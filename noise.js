// StudyNoise — playback controller.
//
// The actual noise DSP lives in noise-dsp.js (shared, DOM-free). This file just
// wires up the UI and routes audio through the Web Audio graph:
//
//   AudioWorkletNode | ScriptProcessorNode  ->  GainNode (volume)  ->
//     DynamicsCompressor (safety limiter)  ->  destination
//
// Preferred path is an AudioWorklet, which generates samples on the dedicated
// real-time audio thread — immune to the main-thread rendering/GC stalls that
// make a ScriptProcessorNode underrun and "pop". Where the worklet can't be
// loaded (e.g. an old browser, or a file:// path that blocks the module fetch),
// it transparently falls back to a ScriptProcessorNode, which works everywhere.
//
// Only one noise plays at a time; tapping the active noise stops it.

(function () {
  "use strict";

  const BLOCK_SIZE = 4096; // ScriptProcessor fallback buffer size

  let audioCtx = null;
  let gainNode = null;
  let workletNode = null; // persistent; fed "play"/"stop" messages
  let useWorklet = false;
  let readyPromise = null;
  let activeNode = null; // ScriptProcessor fallback node
  let activeType = null;

  let babbleEnabled = true;

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

  // Create the context + graph (synchronously, to stay inside the user gesture)
  // and then asynchronously try to bring up the AudioWorklet. Returns a promise
  // that resolves once we know which path (worklet or fallback) to use.
  function ensureContext() {
    if (readyPromise) return readyPromise;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(volumeSlider.value);

    // Master safety limiter: catches the rare high peaks of the transient-rich
    // Rain droplets so they can't clip at high volume. The threshold sits just
    // below full scale, so the steady tracks — whose peaks stay well under it at
    // normal levels — pass through untouched.
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -1.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;

    gainNode.connect(limiter);
    limiter.connect(audioCtx.destination);

    readyPromise = (async () => {
      if (audioCtx.audioWorklet) {
        try {
          // The shared DSP must be added first; the processor references it.
          await audioCtx.audioWorklet.addModule("noise-dsp.js");
          await audioCtx.audioWorklet.addModule("noise-worklet.js");
          workletNode = new AudioWorkletNode(audioCtx, "noise-processor", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
          });
          workletNode.connect(gainNode);
          useWorklet = true;
        } catch (err) {
          // file:// or unsupported — fall back to the ScriptProcessor path.
          useWorklet = false;
        }
      }
    })();
    return readyPromise;
  }

  function stop() {
    if (useWorklet && workletNode) {
      workletNode.port.postMessage({ cmd: "stop" });
    }
    if (activeNode) {
      activeNode.disconnect();
      activeNode.onaudioprocess = null;
      activeNode = null;
    }
    activeType = null;
    buttons.forEach((b) => b.classList.remove("playing"));
    refreshBabbleToggle();
  }

  async function play(type) {
    await ensureContext();
    if (audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch (err) {
        /* ignore */
      }
    }

    const DSP = self.StudyNoiseDSP;
    DSP.setBabble(babbleEnabled);

    if (useWorklet && workletNode) {
      // Calibrate on the main thread (a brief synchronous warm-up that must NOT
      // run on the audio thread), then hand the per-sample gain to the worklet,
      // which builds its own fresh, statistically-identical generator(s).
      const probe = DSP.generators[type](audioCtx.sampleRate);
      const gain = DSP.calibrateGain(probe, audioCtx.sampleRate);
      workletNode.port.postMessage({
        cmd: "play",
        noise: type,
        babble: babbleEnabled,
        gain,
      });
    } else {
      playWithScriptProcessor(type, DSP);
    }

    activeType = type;
    buttons.forEach((b) =>
      b.classList.toggle("playing", b.dataset.type === type)
    );
    refreshBabbleToggle();
  }

  // Fallback path: generate samples in an onaudioprocess callback on the main
  // thread. Identical audio to the worklet, just more prone to the occasional
  // glitch under main-thread load.
  function playWithScriptProcessor(type, DSP) {
    const gen = DSP.generators[type](audioCtx.sampleRate);
    const gain = DSP.calibrateGain(gen, audioCtx.sampleRate);

    // Stereo generators (Speech Masking) drive each channel from an independent
    // instance so the two ears get decorrelated noise. Mono generators write the
    // same sample to both channels, identical to plain mono playback.
    const genR = gen.stereo ? DSP.generators[type](audioCtx.sampleRate) : null;

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
