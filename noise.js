// StudyNoise — white, pink, brown and other coloured noise generators using
// the Web Audio API.
//
// Noise is generated CONTINUOUSLY in real time rather than looping a short
// buffer. A looped buffer repeats the same few seconds over and over, which
// the ear hears as a faint periodic pulse (and any seam mismatch as a click or
// volume dip). Streaming the samples on the fly avoids all of that: the output
// never repeats and has no seam. The audio graph is:
//
//   ScriptProcessorNode (streaming) -> GainNode (volume) -> destination
//
// (ScriptProcessorNode is deprecated in favour of AudioWorklet, but it works
// everywhere — including from a local file:// path — and is more than fast
// enough for per-sample noise. AudioWorklet would be the upgrade path.)
//
// Only one noise plays at a time; tapping the active noise stops it.

(function () {
  "use strict";

  // Each generator is calibrated to this RMS level so all noises sit at a
  // similar perceived loudness; the volume slider scales from there.
  const TARGET_RMS = 0.2;
  const BLOCK_SIZE = 4096;

  // --- Speech-masking track tuning ----------------------------------------
  //
  // Starting points for the sound-masking filter chain in createSpeechMasking;
  // all easily tweakable. The idea is to concentrate energy in the band that
  // carries speech intelligibility (~250 Hz–6 kHz, consonants especially) so it
  // masks the *words* of nearby voices at a low, comfortable level — the way
  // office sound-masking systems do — rather than spreading energy flat.
  const SPEECH = {
    highpassHz: 100, // drop sub-bass that only adds rumble and wastes energy
    peakLoHz: 300, // lower edge of the mid "speech peak" boost band
    peakHiHz: 600, // upper edge of the mid "speech peak" boost band
    peakGain: 1.6, // how strongly to lift the 300–600 Hz peak
    shelfHz: 3000, // high-shelf centre: lift the consonant band above this
    shelfGain: 1.0, // how strongly to lift the 2–5 kHz consonant cues
    lowpassHz: 6500, // keep consonant energy, then roll off the harsh top
    targetRms: 0.15, // quieter than the pure colours: sits just above ambient speech
    stereo: true, // decorrelated L/R noise — wider, harder to listen past
    // Babble: synthetic multi-talker "café" murmur. Summing several
    // independently-modulated voices fills each other's dips (so there's no
    // quiet gap for a real voice to peek through, the flaw of single-stream
    // modulation), and per-voice formant resonances give a vowel-like, speech-
    // like texture that engages the listener's phonetic processing —
    // informational masking that flat noise can't provide.
    talkers: 7, // independent voices summed into the babble
    formantBwHz: 180, // formant resonator bandwidth (gentle vowel colour)
    formantGlide: 0.05, // glide toward each new vowel per control tick (~30 ms)
    ctrlSamples: 64, // control-rate period for updating formant coefficients
    babbleFloor: 0.4, // minimum level of a single voice's syllabic envelope
    babbleMinHz: 2, // syllabic-rate range, low end
    babbleMaxHz: 7, // syllabic-rate range, high end
  };

  // Typical vowel formant pairs (F1, F2) in Hz — the targets each babble voice
  // glides between to produce an "aah–ee–oo" murmur.
  const VOWELS = [
    [730, 1090], // "a"  (father)
    [270, 2290], // "ee" (beet)
    [300, 870], // "oo"  (boot)
    [530, 1840], // "e"  (bet)
    [570, 840], // "o"   (bore)
    [660, 1720], // "ae" (bat)
  ];

  // "Babble" mode: slowly modulate the level at the syllabic rate so the
  // envelope feels voice-like (voice-like noise masks voices more efficiently
  // at lower volume). On by default; toggled live from the UI.
  let babbleEnabled = true;

  let audioCtx = null;
  let gainNode = null;
  let activeNode = null;
  let activeType = null;

  const buttons = document.querySelectorAll(".noise");
  const volumeSlider = document.getElementById("volume");
  const babbleToggle = document.getElementById("babble");
  const babbleToggleLabel = document.querySelector(".toggle");

  // The babble toggle only affects Speech Masking, so dim and disable it
  // whenever the active track is a different noise (or, while it's relevant,
  // light it up). Keeps the control clearly scoped to the one track it changes.
  function refreshBabbleToggle() {
    if (!babbleToggle || !babbleToggleLabel) return;
    const relevant = activeType === null || activeType === "speech";
    babbleToggle.disabled = !relevant;
    babbleToggleLabel.classList.toggle("is-disabled", !relevant);
  }

  function ensureContext() {
    if (audioCtx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(volumeSlider.value);
    gainNode.connect(audioCtx.destination);
  }

  // One-pole filter coefficient for a given cutoff frequency.
  function onePoleCoeff(cutoffHz, sampleRate) {
    return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  // --- Streaming generators ------------------------------------------------
  //
  // Each factory returns an object with next() yielding the next sample while
  // keeping its own persistent filter/integrator state, so the stream is
  // continuous across processing blocks.

  // White noise: uniformly random samples in [-1, 1].
  function createWhite() {
    return { next: () => Math.random() * 2 - 1 };
  }

  // Pink noise via Paul Kellet's economical filtering method (~ -3 dB/octave).
  function createPink() {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        return pink;
      },
    };
  }

  // Brown (red) noise: integrated white noise with a small leak (~ -6 dB/oct).
  function createBrown() {
    let last = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        return last;
      },
    };
  }

  // Violet (purple) noise: differentiated white noise (~ +6 dB/octave).
  function createViolet() {
    let prev = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        const v = white - prev;
        prev = white;
        return v;
      },
    };
  }

  // Blue (azure) noise: differentiated pink noise (~ +3 dB/octave).
  function createBlue() {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let prev = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        const v = pink - prev; // differentiate pink -> +3 dB/octave
        prev = pink;
        return v;
      },
    };
  }

  // Grey noise: white noise roughly shaped to an equal-loudness curve. An
  // approximation that emphasizes lows and highs (where the ear is least
  // sensitive) and scoops the mids, built from two one-pole filters.
  function createGrey(sampleRate) {
    const aLow = onePoleCoeff(250, sampleRate);
    const aHigh = onePoleCoeff(3500, sampleRate);
    let low = 0, mid = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        low += aLow * (white - low); // lows
        mid += aHigh * (white - mid); // everything up to ~3.5 kHz
        const high = white - mid; // highs
        return low * 1.5 + high; // lows + highs, mids fall away
      },
    };
  }

  // Green noise: informal "nature/ambience" noise — energy concentrated in the
  // mid frequencies (~500 Hz). Band-passed white noise.
  function createGreen(sampleRate) {
    const aHi = onePoleCoeff(800, sampleRate);
    const aLo = onePoleCoeff(250, sampleRate);
    let lpHi = 0, lpLo = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        lpHi += aHi * (white - lpHi);
        lpLo += aLo * (white - lpLo);
        return lpHi - lpLo; // band between the two cutoffs
      },
    };
  }

  // Black noise: an ultra-deep rumble. Formally "black noise" often means
  // silence (near-zero power), but the useful audible reading is a spectrum
  // steeper than brown (~ -12 dB/octave) — here, white integrated twice.
  function createBlack() {
    let last1 = 0, last2 = 0;
    return {
      next() {
        const white = Math.random() * 2 - 1;
        last1 = (last1 + 0.02 * white) / 1.02;
        last2 = (last2 + 0.02 * last1) / 1.02;
        return last2;
      },
    };
  }

  // One synthetic "voice" for the babble: pink noise coloured by two wandering
  // formant resonators (giving a vowel-like timbre) and shaped by its own
  // syllabic-rate amplitude envelope. Many of these summed make a crowd murmur.
  function createBabbleVoice(sampleRate) {
    const pink = createPink();

    // Two-pole resonators with poles at radius r: stable, gentle vowel peaks.
    const r = Math.exp((-Math.PI * SPEECH.formantBwHz) / sampleRate);
    const r2 = r * r;
    const g = 1 - r; // keeps each formant's peak gain ~constant and bounded
    let f1 = 500, f2 = 1500; // current (glided) formant centres
    let t1 = 500, t2 = 1500; // vowel targets
    let c1 = Math.cos((2 * Math.PI * f1) / sampleRate); // 2·cosθ lives in the loop
    let c2 = Math.cos((2 * Math.PI * f2) / sampleRate);
    let a1 = 0, a2 = 0, b1 = 0, b2 = 0; // resonator delay states
    let ctrl = 0;

    // Per-voice syllabic envelope (smoothstep ramps between random levels).
    let segLeft = 0, segLen = 1, envFrom = 1, envTo = 1;

    return {
      next() {
        // Control-rate: glide the formant centres toward the current vowel and
        // refresh the resonator coefficients (cheap; they move slowly).
        if (ctrl <= 0) {
          ctrl = SPEECH.ctrlSamples;
          f1 += SPEECH.formantGlide * (t1 - f1);
          f2 += SPEECH.formantGlide * (t2 - f2);
          c1 = Math.cos((2 * Math.PI * f1) / sampleRate);
          c2 = Math.cos((2 * Math.PI * f2) / sampleRate);
        }
        ctrl--;

        // New syllable: pick a new envelope target, rate, and vowel.
        if (segLeft <= 0) {
          envFrom = envTo;
          envTo = SPEECH.babbleFloor + Math.random() * (1 - SPEECH.babbleFloor);
          const rateHz =
            SPEECH.babbleMinHz +
            Math.random() * (SPEECH.babbleMaxHz - SPEECH.babbleMinHz);
          segLen = Math.max(1, Math.floor(sampleRate / rateHz));
          segLeft = segLen;
          const v = VOWELS[(Math.random() * VOWELS.length) | 0];
          t1 = v[0];
          t2 = v[1];
        }
        const tt = 1 - segLeft / segLen;
        const env = envFrom + (envTo - envFrom) * (tt * tt * (3 - 2 * tt));
        segLeft--;

        const x = pink.next();
        const y1 = g * x + 2 * r * c1 * a1 - r2 * a2; // formant 1
        a2 = a1;
        a1 = y1;
        const y2 = g * x + 2 * r * c2 * b1 - r2 * b2; // formant 2
        b2 = b1;
        b1 = y2;
        return (y1 + y2) * env;
      },
    };
  }

  // Speech-masking noise: a source shaped to approximate a sound-masking
  // spectrum, so it masks the intelligibility of nearby voices at a low,
  // comfortable level. The shaping chain — built from the same one-pole
  // primitives as the colours above — is:
  //   highpass ~100 Hz -> +boost 300–600 Hz -> +consonant shelf ~3 kHz
  //     -> lowpass ~6.5 kHz
  // The consonant shelf lifts the 2–5 kHz band that actually carries word
  // intelligibility, so it masks the *words*, not just the vowel rumble.
  //
  // The source is chosen once at creation: steady pink noise (the clean,
  // habituating baseline that commercial systems use), or — when babble is on —
  // a sum of independently-modulated formant voices (a café murmur that fills
  // its own dips and adds speech-like, informational masking).
  function createSpeechMasking(sampleRate) {
    const useBabble = babbleEnabled;
    const voices = [];
    if (useBabble) {
      for (let i = 0; i < SPEECH.talkers; i++) {
        voices.push(createBabbleVoice(sampleRate));
      }
    }
    const pink = useBabble ? null : createPink();
    const srcNorm = useBabble ? 1 / Math.sqrt(SPEECH.talkers) : 1;

    const aHP = onePoleCoeff(SPEECH.highpassHz, sampleRate);
    const aPeakLo = onePoleCoeff(SPEECH.peakLoHz, sampleRate);
    const aPeakHi = onePoleCoeff(SPEECH.peakHiHz, sampleRate);
    const aShelf = onePoleCoeff(SPEECH.shelfHz, sampleRate);
    const aLP = onePoleCoeff(SPEECH.lowpassHz, sampleRate);
    let hp = 0, peakLo = 0, peakHi = 0, shelf = 0, lp = 0;

    return {
      targetRms: SPEECH.targetRms,
      stereo: SPEECH.stereo,
      next() {
        let src;
        if (useBabble) {
          let sum = 0;
          for (let i = 0; i < voices.length; i++) sum += voices[i].next();
          src = sum * srcNorm;
        } else {
          src = pink.next();
        }

        // Highpass ~100 Hz: subtract the low-passed (sub-bass) part.
        hp += aHP * (src - hp);
        let s = src - hp;

        // Peaking boost ~300–600 Hz: add back a band-passed copy of the signal.
        peakHi += aPeakHi * (s - peakHi);
        peakLo += aPeakLo * (s - peakLo);
        s += SPEECH.peakGain * (peakHi - peakLo);

        // High-shelf ~3 kHz: lift the consonant band (the part above the shelf).
        shelf += aShelf * (s - shelf);
        s += SPEECH.shelfGain * (s - shelf);

        // Lowpass ~6.5 kHz: roll off only the harshest top above the consonants.
        lp += aLP * (s - lp);
        return lp;
      },
    };
  }

  const generators = {
    white: createWhite,
    pink: createPink,
    brown: createBrown,
    blue: createBlue,
    violet: createViolet,
    grey: createGrey,
    green: createGreen,
    black: createBlack,
    speech: createSpeechMasking,
  };

  // Run the generator for a short warm-up and measure its RMS so we can scale
  // every noise to a consistent loudness. The warm-up samples are discarded,
  // but the generator keeps its state, so playback continues seamlessly.
  function calibrateGain(gen, sampleRate) {
    const target = gen.targetRms ?? TARGET_RMS;
    const warmup = Math.floor(sampleRate * 0.5);
    let sumSquares = 0;
    for (let i = 0; i < warmup; i++) {
      const v = gen.next();
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / warmup) || 1e-6;
    return target / rms;
  }

  function stop() {
    if (activeNode) {
      activeNode.disconnect();
      activeNode.onaudioprocess = null;
      activeNode = null;
    }
    activeType = null;
    buttons.forEach((b) => b.classList.remove("playing"));
    refreshBabbleToggle();
  }

  function play(type) {
    ensureContext();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const gen = generators[type](audioCtx.sampleRate);
    const gain = calibrateGain(gen, audioCtx.sampleRate);

    // Stereo generators (Speech Masking) drive each channel from an independent
    // instance so the two ears get decorrelated noise — wider and harder to
    // listen past. Mono generators write the same sample to both channels,
    // which is identical to plain mono playback (no change for the colours).
    const genR = gen.stereo ? generators[type](audioCtx.sampleRate) : null;

    const node = audioCtx.createScriptProcessor(BLOCK_SIZE, 0, 2);
    node.onaudioprocess = (e) => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      if (genR) {
        for (let i = 0; i < outL.length; i++) {
          outL[i] = gen.next() * gain;
          outR[i] = genR.next() * gain;
        }
      } else {
        for (let i = 0; i < outL.length; i++) {
          outL[i] = outR[i] = gen.next() * gain;
        }
      }
    };
    node.connect(gainNode);

    activeNode = node;
    activeType = type;
    buttons.forEach((b) =>
      b.classList.toggle("playing", b.dataset.type === type)
    );
    refreshBabbleToggle();
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.type;
      if (activeType === type) {
        stop();
      } else {
        stop();
        play(type);
      }
    });
  });

  volumeSlider.addEventListener("input", () => {
    if (gainNode) gainNode.gain.value = parseFloat(volumeSlider.value);
  });

  // Babble toggle (Speech Masking). The babble vs steady source is chosen when
  // the generator is built, so if Speech Masking is already playing we rebuild
  // it to apply (and recalibrate) the new mode; otherwise just record the flag.
  if (babbleToggle) {
    babbleEnabled = babbleToggle.checked;
    babbleToggle.addEventListener("change", () => {
      babbleEnabled = babbleToggle.checked;
      if (activeType === "speech") {
        stop();
        play("speech");
      }
    });
  }
  refreshBabbleToggle();
})();
