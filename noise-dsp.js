// StudyNoise DSP — the noise generators, their tuning constants and the
// loudness calibration.
//
// This file touches no DOM, so the same code runs in both places it is needed:
// as a classic script on the main thread (loudness calibration, and the
// ScriptProcessor fallback) and as a module inside the AudioWorklet (the
// real-time audio thread, see noise-worklet.js). It publishes its API as
// globalThis.StudyNoiseDSP — globalThis, not `self`, because the AudioWorklet
// global scope has no `self`.
//
// Noise is generated CONTINUOUSLY in real time rather than looping a short
// buffer. A looped buffer repeats the same few seconds over and over, which
// the ear hears as a faint periodic pulse (and any seam mismatch as a click or
// volume dip). Streaming the samples on the fly avoids all of that: the output
// never repeats and has no seam.

(function (scope) {
  "use strict";

  // --- Loudness and stereo -------------------------------------------------
  //
  // Every track is calibrated to the same A-WEIGHTED level, so they sound about
  // equally loud at one volume setting. Plain RMS doesn't do that: the ear is
  // far less sensitive to lows, so a deep rumble and a bright hiss of equal RMS
  // are a long way apart in loudness (16 dB between Rumble and Rain, measured).
  // A-weighting follows the ear's sensitivity at the quiet levels background
  // noise is played at.
  const TARGET_LOUDNESS_DB = -20; // A-weighted RMS, in dB re full scale
  // No track may exceed this plain RMS, whatever its weighting says: beyond it
  // the peaks of a Gaussian-like noise start to clip. The deepest tracks (Black
  // and Rumble, and Ocean to a lesser degree) hit their ceiling before they
  // reach the loudness target, so they stay quieter than the rest — there is
  // no clean headroom left to bring them up. A track can set a lower ceiling
  // of its own with `maxRms`.
  const MAX_RMS = 0.2;
  // Calibration runs the slow modulators (ocean swell, wind gusts, babble
  // syllables) this many times faster, so a second or so of measurement sees
  // the long-term level rather than whichever swell or gust came first.
  const CAL_SPEED = 128;
  // Stereo width: 1 = the two ears get fully independent noise (wide, "around
  // you"), 0 = identical channels (mono, a point in the middle of the head).
  const STEREO_WIDTH = 1;

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
    loudnessDb: 2, // dB above the common loudness target: a masker has to stay
    //               above the voices it covers. Keeps the steady track at the
    //               level it was tuned to (RMS ~0.15); babble now matches it.
    // Babble: synthetic multi-talker "café" murmur. Summing several
    // independently-modulated voices fills each other's dips (so there's no
    // quiet gap for a real voice to peek through, the flaw of single-stream
    // modulation), and per-voice formant resonances give a vowel-like, speech-
    // like texture that engages the listener's phonetic processing —
    // informational masking that flat noise can't provide.
    talkers: 7, // independent voices summed into the babble
    formantGain: 0.1, // how much vowel-formant colour to add ON TOP of the
    //                   broadband voice; small, so the masking spectrum (and so
    //                   the sound) stays within ~3 dB of the steady track

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

  // One-pole filter coefficient for a given cutoff frequency.
  function onePoleCoeff(cutoffHz, sampleRate) {
    return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  // --- Stereo ----------------------------------------------------------------
  //
  // A playable track yields two channels per step: next() returns the left
  // sample and leaves the matching right sample in `.right`. The channels carry
  // independent noise, which sounds wide and is harder to listen past than one
  // signal copied to both ears; anything that should move together (a wave's
  // swell, a gust) is shared between them.

  // STEREO_WIDTH as a cross-feed: each ear keeps KEEP of its own noise and takes
  // BLEED of the other. KEEP² + BLEED² = 1, so the level doesn't change with
  // the width.
  const widthAngle =
    Math.asin(1 - Math.min(1, Math.max(0, STEREO_WIDTH))) / 2;
  const KEEP = Math.cos(widthAngle);
  const BLEED = Math.sin(widthAngle);

  function stereoOut(out, l, r) {
    out.right = KEEP * r + BLEED * l;
    return KEEP * l + BLEED * r;
  }

  // Turn a mono factory into a stereo track by running one instance per ear.
  // The mono factory stays reachable as `.mono` for loudness calibration, which
  // only needs one channel.
  function wide(factory) {
    function create(sampleRate, options) {
      const a = factory(sampleRate, options);
      const b = factory(sampleRate, options);
      const out = {
        loudnessDb: a.loudnessDb,
        right: 0,
        next() {
          return stereoOut(out, a.next(), b.next());
        },
      };
      return out;
    }
    create.mono = factory;
    return create;
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

  // Velvet noise: mostly silence with one randomly-placed ±1 impulse per short
  // grid window. Its spectrum is broadly flat like white, but the sparseness
  // makes it sound smoother and silkier, less harsh than full white hiss.
  function createVelvet(sampleRate) {
    const grid = Math.max(2, Math.round(sampleRate / 3000)); // ~3000 impulses/s
    let idx = 0, pos = 0, sign = 1;
    return {
      next() {
        if (idx === 0) {
          pos = (Math.random() * grid) | 0; // impulse position in this window
          sign = Math.random() < 0.5 ? -1 : 1;
        }
        const out = idx === pos ? sign : 0;
        if (++idx >= grid) idx = 0;
        return out;
      },
    };
  }

  // One synthetic "voice" for the babble: pink noise coloured by two wandering
  // formant resonators (giving a vowel-like timbre) and shaped by its own
  // syllabic-rate amplitude envelope. Many of these summed make a crowd murmur.
  // `speed` runs the syllables and vowel glides faster (calibration only).
  function createBabbleVoice(sampleRate, speed) {
    const pink = createPink();
    const glide = 1 - Math.pow(1 - SPEECH.formantGlide, speed);

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
          f1 += glide * (t1 - f1);
          f2 += glide * (t2 - f2);
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
          segLen = Math.max(1, Math.floor(sampleRate / (rateHz * speed)));
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
        // Keep the broadband voice and add only a touch of formant colour — the
        // resonators alone are a narrow low-mid band that sounds nothing like
        // the masking spectrum (a hollow roar). The dry x preserves the highs.
        return (x + SPEECH.formantGain * (y1 + y2)) * env;
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
  //
  // options.babble selects the source (on unless explicitly false).
  // options.modSpeed runs the babble faster; calibration uses it (see CAL_SPEED).
  function createSpeechMasking(sampleRate, options) {
    const useBabble = !options || options.babble !== false;
    const speed = (options && options.modSpeed) || 1;
    const voices = [];
    if (useBabble) {
      for (let i = 0; i < SPEECH.talkers; i++) {
        voices.push(createBabbleVoice(sampleRate, speed));
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
      loudnessDb: SPEECH.loudnessDb,
      calibrateSeconds: 1,
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

  // --- Environmental / ambience generators ---------------------------------
  //
  // Synthesised in real time, never looped — the same streaming approach as the
  // colours, just driven by slow modulation (waves, gusts) or sparse transients
  // (drops, crackle). Tuning constants are inline and easy to nudge.

  // Rumble masking: a low-frequency masker (~40–200 Hz), the non-speech
  // counterpart to Speech Masking — tuned to cover traffic, footsteps and HVAC
  // thumps rather than voices. Brown noise band-limited to the rumble region.
  function createRumble(sampleRate) {
    const brown = createBrown();
    const aLp1 = onePoleCoeff(180, sampleRate);
    const aLp2 = onePoleCoeff(180, sampleRate);
    const aHp = onePoleCoeff(35, sampleRate);
    let lp1 = 0, lp2 = 0, hp = 0;
    return {
      next() {
        const s = brown.next();
        lp1 += aLp1 * (s - lp1);
        lp2 += aLp2 * (lp1 - lp2); // two-pole lowpass ~180 Hz
        hp += aHp * (lp2 - hp);
        return lp2 - hp; // highpass ~35 Hz to drop infrasonic wander
      },
    };
  }

  // Ocean surf: brown noise under a slow swell that modulates both loudness and
  // brightness, so each wave rises and breaks. Two detuned LFOs keep the rhythm
  // from sounding mechanically periodic. Both ears share the swell (one wave)
  // but get their own noise.
  //
  // options.modSpeed runs the swell faster; calibration uses it (see CAL_SPEED).
  function createOcean(sampleRate, options) {
    const speed = (options && options.modSpeed) || 1;
    const brownL = createBrown(), brownR = createBrown();
    const TWO_PI = 2 * Math.PI;
    let p1 = 0, p2 = Math.PI / 3;
    const inc1 = (TWO_PI * 0.085 * speed) / sampleRate; // ~12 s period
    const inc2 = (TWO_PI * 0.057 * speed) / sampleRate; // ~17 s period
    let lpL = 0, lpR = 0;
    const out = {
      calibrateSeconds: 4,
      // A wave's crest sits well above the long-term level, so the ceiling on
      // that level is lower here than for the steady tracks.
      maxRms: 0.16,
      right: 0,
      next() {
        p1 += inc1;
        if (p1 > TWO_PI) p1 -= TWO_PI;
        p2 += inc2;
        if (p2 > TWO_PI) p2 -= TWO_PI;
        let swell = 0.5 - 0.25 * Math.cos(p1) - 0.25 * Math.cos(p2); // 0..1
        if (swell < 0) swell = 0;
        const a = onePoleCoeff(250 + swell * 1500, sampleRate); // brighter at crest
        const level = 0.2 + 1.1 * swell; // quieter in the trough
        lpL += a * (brownL.next() - lpL);
        lpR += a * (brownR.next() - lpR);
        return stereoOut(out, lpL * level, lpR * level);
      },
    };
    return out;
  }

  // Wind: pink noise through a band-pass whose centre frequency and level wander
  // slowly, giving rising and falling gusts. Both ears share the gusts but get
  // their own noise.
  //
  // Each gust target is HELD for a few seconds and approached over about a
  // second. (Picking a new target far more often than the glide can follow —
  // as an earlier version did, every ~43 ms against a ~0.5 s glide — just
  // averages the targets away and leaves a steady hiss.)
  //
  // options.modSpeed runs the gusts faster; calibration uses it (see CAL_SPEED).
  function createWind(sampleRate, options) {
    const speed = (options && options.modSpeed) || 1;
    const pinkL = createPink(), pinkR = createPink();
    const glide = 1 - Math.exp(-speed / (1.2 * sampleRate)); // ~1.2 s approach
    let center = 500, targetCenter = 500;
    let gust = 0.6, targetGust = 0.6;
    let hold = 0, ctrl = 0, aHi = 0, aLo = 0;
    let hiL = 0, loL = 0, hiR = 0, loR = 0;
    const out = {
      calibrateSeconds: 4,
      right: 0,
      next() {
        if (hold <= 0) {
          hold = (sampleRate * (2 + Math.random() * 4)) / speed; // 2–6 s a gust
          targetCenter = 220 + Math.random() * 900;
          targetGust = 0.25 + Math.random() * 0.75; // a 12 dB range
        }
        hold--;
        center += glide * (targetCenter - center);
        gust += glide * (targetGust - gust);
        // The band edges move slowly, so refresh their coefficients at control
        // rate rather than paying for two exp() calls on every sample.
        if (ctrl <= 0) {
          ctrl = 16;
          aHi = onePoleCoeff(center * 1.7, sampleRate);
          aLo = onePoleCoeff(center * 0.6, sampleRate);
        }
        ctrl--;
        const l = pinkL.next(), r = pinkR.next();
        hiL += aHi * (l - hiL);
        loL += aLo * (l - loL);
        hiR += aHi * (r - hiR);
        loR += aLo * (r - loR);
        const g = gust * 2.2; // band between the cutoffs, gusting
        return stereoOut(out, (hiL - loL) * g, (hiR - loR) * g);
      },
    };
    return out;
  }

  // Rain: a band-passed "wash" of distant rain, peppered with discrete droplet
  // pings — short decaying resonators (poles inside the unit circle, so stable)
  // re-triggered at random from a small pool of voices.
  function createRain(sampleRate) {
    const bed = createPink();
    const aBedLo = onePoleCoeff(5000, sampleRate);
    const aBedHi = onePoleCoeff(400, sampleRate);
    let bedLo = 0, bedHi = 0;
    const drops = [];
    for (let i = 0; i < 14; i++) drops.push({ y1: 0, y2: 0, r: 0, c: 0 });
    const pTrigger = 0.00009; // per voice, per sample (~55 drops/s total)
    function trigger(d) {
      const f = 900 + Math.random() * 3500; // droplet pitch
      const bw = 30 + Math.random() * 120; // ring time
      d.r = Math.exp((-Math.PI * bw) / sampleRate);
      d.c = 2 * d.r * Math.cos((2 * Math.PI * f) / sampleRate);
      d.y1 = 0.5 + Math.random() * 0.9; // initial impulse
      d.y2 = 0;
    }
    return {
      next() {
        const b = bed.next();
        bedLo += aBedLo * (b - bedLo);
        bedHi += aBedHi * (bedLo - bedHi);
        let s = (bedLo - bedHi) * 0.6; // band-passed bed
        for (let i = 0; i < drops.length; i++) {
          const d = drops[i];
          if (d.y1 === 0 && d.y2 === 0) {
            if (Math.random() < pTrigger) trigger(d);
            else continue;
          }
          const y = d.c * d.y1 - d.r * d.r * d.y2; // decaying sinusoid
          d.y2 = d.y1;
          d.y1 = y;
          if (y < 1e-4 && y > -1e-4 && d.y2 < 1e-4 && d.y2 > -1e-4) {
            d.y1 = 0; // settled -> free the voice
            d.y2 = 0;
          }
          s += y * 0.32;
        }
        return s;
      },
    };
  }

  // The playable tracks, all stereo. Ocean and Wind build their own two
  // channels because the ears must share the swell / the gusts; for the rest,
  // one independent instance per ear is exactly right (rain even gets its
  // droplets scattered left and right).
  const generators = {
    white: wide(createWhite),
    pink: wide(createPink),
    brown: wide(createBrown),
    blue: wide(createBlue),
    violet: wide(createViolet),
    grey: wide(createGrey),
    green: wide(createGreen),
    black: wide(createBlack),
    velvet: wide(createVelvet),
    rain: wide(createRain),
    ocean: createOcean,
    wind: createWind,
    speech: wide(createSpeechMasking),
    rumble: wide(createRumble),
  };

  // --- Loudness calibration ------------------------------------------------

  // A-weighting as a streaming filter: returns a function mapping each input
  // sample to its weighted value. The standard analogue curve — highpass poles
  // at 20.6 Hz (twice), 107.7 Hz and 737.9 Hz, lowpass poles at 12194 Hz
  // (twice) — taken to discrete time one first-order section at a time
  // (bilinear transform, pre-warped at each pole) and normalised to 0 dB at
  // 1 kHz.
  function createAWeighting(sampleRate) {
    const cos1k = Math.cos((2 * Math.PI * 1000) / sampleRate);
    const stages = [];
    let norm = 1;
    function add(poleHz, highpass) {
      if (poleHz >= 0.45 * sampleRate) return; // beyond the band at this rate
      const k = Math.tan((Math.PI * poleHz) / sampleRate);
      const b = (1 - k) / (1 + k);
      const g = (highpass ? 1 : k) / (1 + k);
      stages.push({ highpass, g, b, x1: 0, y1: 0 });
      // This section's gain at 1 kHz, divided out of the total.
      const num = highpass ? 2 - 2 * cos1k : 2 + 2 * cos1k;
      norm /= g * Math.sqrt(num / (1 - 2 * b * cos1k + b * b));
    }
    [20.6, 20.6, 107.7, 737.9].forEach((hz) => add(hz, true));
    [12194, 12194].forEach((hz) => add(hz, false));
    return function (x) {
      for (let i = 0; i < stages.length; i++) {
        const s = stages[i];
        const y = s.g * (s.highpass ? x - s.x1 : x + s.x1) + s.b * s.y1;
        s.x1 = x;
        s.y1 = y;
        x = y;
      }
      return x * norm;
    };
  }

  // Measure a track and return the gain that brings it to the common loudness:
  //   { gain, rms }  — rms is the plain RMS of the track once that gain is
  //                    applied (the mixer uses it to keep headroom).
  // The gain aims for the A-weighted target but never lifts the plain RMS past
  // MAX_RMS. A throwaway generator is measured, so this never disturbs one that
  // is playing; it runs on the main thread, and callers cache the result.
  function calibrate(type, sampleRate, options) {
    const factory = generators[type].mono || generators[type];
    const gen = factory(
      sampleRate,
      Object.assign({}, options, { modSpeed: CAL_SPEED })
    );
    const weigh = createAWeighting(sampleRate);

    // Let the generator's and the weighting filter's states settle first.
    const settle = Math.floor(sampleRate * 0.25);
    for (let i = 0; i < settle; i++) weigh(gen.next());

    const count = Math.floor(sampleRate * (gen.calibrateSeconds || 2));
    let sum = 0, sumA = 0;
    for (let i = 0; i < count; i++) {
      const v = gen.next();
      const a = weigh(v);
      sum += v * v;
      sumA += a * a;
    }
    const rms = Math.sqrt(sum / count) || 1e-9;
    const rmsA = Math.sqrt(sumA / count) || 1e-9;
    const target = Math.pow(
      10,
      (TARGET_LOUDNESS_DB + (gen.loudnessDb || 0)) / 20
    );
    const gain = Math.min(target / rmsA, (gen.maxRms || MAX_RMS) / rms);
    return { gain, rms: rms * gain };
  }

  scope.StudyNoiseDSP = { generators, calibrate };
})(globalThis);
