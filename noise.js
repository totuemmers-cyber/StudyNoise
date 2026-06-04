// StudyNoise — white, pink and brown noise generators using the Web Audio API.
//
// Each noise type fills an AudioBuffer with a few seconds of samples, then
// loops it through a BufferSource. The audio graph is:
//
//   BufferSource (looping) -> GainNode (volume) -> destination
//
// Only one noise plays at a time; tapping the active noise stops it.

(function () {
  "use strict";

  const BUFFER_SECONDS = 5;

  let audioCtx = null;
  let gainNode = null;
  let activeSource = null;
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

  // Fills the channel with white noise: uniformly random samples in [-1, 1].
  function fillWhite(data) {
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
  }

  // Pink noise via Paul Kellet's economical filtering method (~ -3 dB/octave).
  function fillPink(data) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink * 0.11; // scale to keep within [-1, 1]
    }
  }

  // Brown (red) noise: integrated white noise with a small leak (~ -6 dB/octave).
  function fillBrown(data) {
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5; // amplify; brown noise is otherwise very quiet
    }
  }

  // Violet (purple) noise: differentiated white noise (~ +6 dB/octave).
  // The first difference of a signal boosts high frequencies.
  function fillViolet(data) {
    let prev = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      data[i] = white - prev;
      prev = white;
    }
    normalize(data, 0.6);
  }

  // Blue (azure) noise: differentiated pink noise (~ +3 dB/octave).
  function fillBlue(data) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let prev = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = pink - prev; // differentiate pink -> +3 dB/octave
      prev = pink;
    }
    normalize(data, 0.6);
  }

  // Grey noise: white noise roughly shaped to an equal-loudness curve, so it
  // sounds about as loud across the spectrum. This is an approximation that
  // emphasizes the lows and highs (where the ear is least sensitive) and
  // scoops the mids, built from two one-pole filters.
  function fillGrey(data, sampleRate) {
    const aLow = onePoleCoeff(250, sampleRate);  // keep content below ~250 Hz
    const aHigh = onePoleCoeff(3500, sampleRate); // split point for the highs
    let low = 0, mid = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      low += aLow * (white - low);    // lows
      mid += aHigh * (white - mid);   // everything up to ~3.5 kHz
      const high = white - mid;       // highs
      data[i] = low * 1.5 + high;     // lows + highs, mids fall away
    }
    normalize(data, 0.7);
  }

  // Green noise: informal "nature/ambience" noise — energy concentrated in the
  // mid frequencies (~500 Hz). Implemented as band-passed white noise.
  function fillGreen(data, sampleRate) {
    const aHi = onePoleCoeff(800, sampleRate);  // upper edge of the band
    const aLo = onePoleCoeff(250, sampleRate);  // lower edge of the band
    let lpHi = 0, lpLo = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      lpHi += aHi * (white - lpHi);
      lpLo += aLo * (white - lpLo);
      data[i] = lpHi - lpLo; // band between the two cutoffs
    }
    normalize(data, 0.7);
  }

  // Black noise: an ultra-deep rumble. Formally "black noise" often means
  // silence (near-zero power), but the useful audible reading is a spectrum
  // steeper than brown (~ -12 dB/octave) — here, white integrated twice.
  function fillBlack(data) {
    let last1 = 0, last2 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last1 = (last1 + 0.02 * white) / 1.02;
      last2 = (last2 + 0.02 * last1) / 1.02;
      data[i] = last2;
    }
    normalize(data, 0.6);
  }

  // One-pole filter coefficient for a given cutoff frequency.
  function onePoleCoeff(cutoffHz, sampleRate) {
    return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  // Scale a channel so its peak amplitude equals `target`.
  function normalize(data, target) {
    let max = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > max) max = a;
    }
    if (max > 0) {
      const gain = target / max;
      for (let i = 0; i < data.length; i++) data[i] *= gain;
    }
  }

  const fillers = {
    white: fillWhite,
    pink: fillPink,
    brown: fillBrown,
    blue: fillBlue,
    violet: fillViolet,
    grey: fillGrey,
    green: fillGreen,
    black: fillBlack,
  };

  // Builds a buffer that loops without an audible click at the seam.
  //
  // Low-frequency noises (brown, black) drift like a random walk, so the last
  // sample of a plain buffer rarely matches the first — that mismatch is heard
  // as a recurring crackle once per loop. To avoid it we generate a little
  // extra audio (a "fade" region) and fold that tail back onto the head with a
  // raised-cosine crossfade. Because the tail is the natural continuation of
  // the body, the wrap point becomes perfectly continuous: out[length - 1]
  // flows into out[0] exactly as the source signal flowed across that sample.
  function buildBuffer(type) {
    const sr = audioCtx.sampleRate;
    const length = sr * BUFFER_SECONDS;
    const fade = Math.floor(sr * 0.25);

    const temp = new Float32Array(length + fade);
    fillers[type](temp, sr);

    const buffer = audioCtx.createBuffer(1, length, sr);
    const out = buffer.getChannelData(0);

    // Body of the loop.
    for (let i = fade; i < length; i++) out[i] = temp[i];

    // Fold the tail (temp[length .. length + fade]) onto the head so the loop
    // is seamless. out[0] becomes temp[length], the true successor of the
    // body's final sample temp[length - 1].
    //
    // The head and tail are uncorrelated stretches of noise, so we blend them
    // with an EQUAL-POWER crossfade (sin/cos, whose squares sum to 1). An
    // equal-amplitude crossfade (weights summing to 1) would drop the combined
    // power by ~3 dB mid-blend, heard as a recurring volume dip once per loop.
    for (let k = 0; k < fade; k++) {
      const theta = (Math.PI / 2) * (k / fade);
      out[k] = temp[k] * Math.sin(theta) + temp[length + k] * Math.cos(theta);
    }

    return buffer;
  }

  function stop() {
    if (activeSource) {
      activeSource.stop();
      activeSource.disconnect();
      activeSource = null;
    }
    activeType = null;
    buttons.forEach((b) => b.classList.remove("playing"));
  }

  function play(type) {
    ensureContext();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const source = audioCtx.createBufferSource();
    source.buffer = buildBuffer(type);
    source.loop = true;
    source.connect(gainNode);
    source.start();

    activeSource = source;
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
})();
