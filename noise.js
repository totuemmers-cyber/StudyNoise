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

  const fillers = { white: fillWhite, pink: fillPink, brown: fillBrown };

  function buildBuffer(type) {
    const length = audioCtx.sampleRate * BUFFER_SECONDS;
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    fillers[type](buffer.getChannelData(0));
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
