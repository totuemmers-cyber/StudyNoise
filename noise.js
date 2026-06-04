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
    lowpassHz: 4800, // roll the highs off (~4.5–5 kHz) so it isn't hissy
    targetRms: 0.12, // quieter than the pure colours: sits just above ambient speech
    babbleFloor: 0.5, // minimum envelope level when babble is on
    babbleMinHz: 2, // syllabic-rate range, low end
    babbleMaxHz: 7, // syllabic-rate range, high end
  };

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

  // Speech-masking noise: pink noise (already weighted toward the lows, a good
  // base) shaped to approximate a sound-masking spectrum, then optionally given
  // a syllabic-rate "babble" envelope so it masks the intelligibility of nearby
  // voices at a low, comfortable level. The filter chain — built from the same
  // one-pole primitives as the colours above — is:
  //   highpass ~100 Hz  ->  +boost 300–600 Hz  ->  lowpass ~4.8 kHz
  function createSpeechMasking(sampleRate) {
    const pink = createPink();
    const aHP = onePoleCoeff(SPEECH.highpassHz, sampleRate);
    const aPeakLo = onePoleCoeff(SPEECH.peakLoHz, sampleRate);
    const aPeakHi = onePoleCoeff(SPEECH.peakHiHz, sampleRate);
    const aLP = onePoleCoeff(SPEECH.lowpassHz, sampleRate);
    let hp = 0, peakLo = 0, peakHi = 0, lp = 0;

    // Syllabic-rate envelope: each segment ramps smoothly to a new random level
    // at a random rate in [babbleMinHz, babbleMaxHz], so the level "breathes"
    // like speech instead of holding steady.
    let segLeft = 0, segLen = 1, envFrom = 1, envTo = 1;

    return {
      targetRms: SPEECH.targetRms,
      next() {
        const p = pink.next();

        // Highpass ~100 Hz: subtract the low-passed (sub-bass) part.
        hp += aHP * (p - hp);
        let s = p - hp;

        // Peaking boost ~300–600 Hz: add back a band-passed copy of the signal.
        peakHi += aPeakHi * (s - peakHi);
        peakLo += aPeakLo * (s - peakLo);
        s += SPEECH.peakGain * (peakHi - peakLo);

        // Lowpass ~4.8 kHz: roll off the harsh, hissy highs.
        lp += aLP * (s - lp);
        s = lp;

        if (!babbleEnabled) return s;

        // Advance the babble envelope, starting a new ramp when the segment ends.
        if (segLeft <= 0) {
          envFrom = envTo;
          envTo = SPEECH.babbleFloor + Math.random() * (1 - SPEECH.babbleFloor);
          const rateHz =
            SPEECH.babbleMinHz +
            Math.random() * (SPEECH.babbleMaxHz - SPEECH.babbleMinHz);
          segLen = Math.max(1, Math.floor(sampleRate / rateHz));
          segLeft = segLen;
        }
        const t = 1 - segLeft / segLen;
        const smooth = t * t * (3 - 2 * t); // smoothstep for natural ramps
        segLeft--;
        return s * (envFrom + (envTo - envFrom) * smooth);
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
  }

  function play(type) {
    ensureContext();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const gen = generators[type](audioCtx.sampleRate);
    const gain = calibrateGain(gen, audioCtx.sampleRate);

    const node = audioCtx.createScriptProcessor(BLOCK_SIZE, 0, 1);
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      for (let i = 0; i < out.length; i++) out[i] = gen.next() * gain;
    };
    node.connect(gainNode);

    activeNode = node;
    activeType = type;
    buttons.forEach((b) =>
      b.classList.toggle("playing", b.dataset.type === type)
    );
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

  // Babble toggle (Speech Masking). Applies live to the running stream.
  const babbleToggle = document.getElementById("babble");
  if (babbleToggle) {
    babbleEnabled = babbleToggle.checked;
    babbleToggle.addEventListener("change", () => {
      babbleEnabled = babbleToggle.checked;
    });
  }
})();
