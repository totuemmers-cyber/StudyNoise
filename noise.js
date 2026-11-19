// StudyNoise — UI controller and audio-graph wiring for the white, pink, brown
// and other noise generators, which live in noise-dsp.js.
//
// Noise is generated CONTINUOUSLY in real time rather than looping a short
// buffer, so the output never repeats and has no seam. The audio graph is:
//
//   source (one per playing track) -> fade GainNode (per-source, anti-click)
//     -> volume GainNode -> DynamicsCompressor (limiter) -> destination
//
// The source is normally an AudioWorkletNode (noise-worklet.js), which runs the
// generator on the browser's real-time audio thread — so a busy main thread
// (rendering, garbage collection) can't make the audio underrun and pop. Where
// the worklet can't be loaded (a local file:// path, an insecure origin, an old
// browser) it falls back to a ScriptProcessorNode on the main thread: the same
// sound, just more prone to the occasional glitch.
//
// Only one noise plays at a time; tapping the active noise stops it.

(function () {
  "use strict";

  const DSP = globalThis.StudyNoiseDSP; // generators + calibration (noise-dsp.js)
  const BLOCK_SIZE = 4096; // buffer size of the ScriptProcessor fallback
  const FADE = 0.04; // short anti-click ramp on start/stop/switch (seconds)
  const SLEEP_FADE = 4; // gentle fade-out at the end of a sleep timer (seconds)
  const STORE_KEY = "studynoise"; // localStorage key for persisted settings

  // "Babble" mode: slowly modulate the level at the syllabic rate so the
  // envelope feels voice-like (voice-like noise masks voices more efficiently
  // at lower volume). On by default; toggled live from the UI.
  let babbleEnabled = true;

  let audioCtx = null;
  let gainNode = null; // master volume (driven by the slider)
  let workletReady = null; // settles once we know whether the worklet loaded
  let workletOk = false; // true while the AudioWorklet path is usable
  let activeNode = null; // { source, env, release } of the playing source
  let activeType = null;
  let playToken = 0; // bumped by every play/stop; cancels a start still pending

  // Sleep timer countdown state. The chosen duration is not kept here — it is
  // read from the <select> whenever a countdown starts (see the timer section).
  let timerEndAt = 0;
  let timerTickId = null;

  const buttons = document.querySelectorAll(".noise");
  const volumeSlider = document.getElementById("volume");
  const babbleToggle = document.getElementById("babble");
  const babbleToggleLabel = document.querySelector(".toggle");
  const timerSelect = document.getElementById("timer");
  const timerDisplay = document.getElementById("timer-remaining");

  // --- Persistence ---------------------------------------------------------
  // Remember volume and the café-babble preference across reloads. The last
  // track is deliberately not auto-resumed: browsers block autoplaying sound
  // without a gesture, and waking a sleeper on page load would be unwelcome.
  function saveSettings() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          volume: parseFloat(volumeSlider.value),
          babble: babbleToggle ? babbleToggle.checked : true,
        })
      );
    } catch (err) {
      /* storage unavailable (private mode, etc.) — just don't persist */
    }
  }

  function loadSettings() {
    let s;
    try {
      s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch (err) {
      return;
    }
    if (typeof s.volume === "number" && s.volume >= 0 && s.volume <= 1) {
      volumeSlider.value = String(s.volume);
    }
    if (typeof s.babble === "boolean" && babbleToggle) {
      babbleToggle.checked = s.babble;
    }
  }
  loadSettings();

  // The babble toggle only affects Speech Masking, so dim and disable it
  // whenever the active track is a different noise (or, while it's relevant,
  // light it up). Keeps the control clearly scoped to the one track it changes.
  function refreshBabbleToggle() {
    if (!babbleToggle || !babbleToggleLabel) return;
    const relevant = activeType === null || activeType === "speech";
    babbleToggle.disabled = !relevant;
    babbleToggleLabel.classList.toggle("is-disabled", !relevant);
  }

  // Create the context and the shared part of the graph. This runs
  // synchronously inside the first tap (browsers require a user gesture), and
  // kicks off loading the worklet in the background.
  function ensureContext() {
    if (audioCtx) return;
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

    workletReady = loadWorklet().then((ok) => {
      workletOk = ok;
    });
  }

  // Load the generator code into the audio thread. Resolves to whether the
  // worklet path can be used; any failure (file:// blocks the module fetch, an
  // insecure origin or old browser has no audioWorklet) is not an error, it
  // just means the ScriptProcessor fallback is used instead.
  function loadWorklet() {
    if (!audioCtx.audioWorklet || typeof AudioWorkletNode === "undefined") {
      return Promise.resolve(false);
    }
    // The DSP goes in first: the processor reads it from the worklet's globals.
    return audioCtx.audioWorklet
      .addModule("noise-dsp.js")
      .then(() => audioCtx.audioWorklet.addModule("noise-worklet.js"))
      .then(
        () => true,
        () => false
      );
  }

  // Disconnect a finished source and let it stop generating.
  function teardown(node) {
    try {
      node.source.disconnect();
      node.env.disconnect();
    } catch (err) {
      /* ignore */
    }
    node.release();
  }

  // Ramp a source's own gain down to silence, then disconnect it once the ramp
  // has finished — so stopping never produces a click. Each source carries its
  // own envelope gain, so an outgoing source can fade out while a new one fades
  // in (a brief crossfade on track switches).
  function fadeOutAndTeardown(node, fadeSec) {
    const now = audioCtx.currentTime;
    try {
      node.env.gain.cancelScheduledValues(now);
      node.env.gain.setValueAtTime(node.env.gain.value, now);
      node.env.gain.linearRampToValueAtTime(0, now + fadeSec);
    } catch (err) {
      /* ignore */
    }
    setTimeout(() => teardown(node), fadeSec * 1000 + 50);
  }

  function stop(fadeSec) {
    playToken++; // drop a start that is still waiting for the worklet to load
    if (activeNode) {
      fadeOutAndTeardown(activeNode, fadeSec === undefined ? FADE : fadeSec);
      activeNode = null;
    }
    activeType = null;
    clearSleepTimer();
    buttons.forEach((b) => b.classList.remove("playing"));
    refreshBabbleToggle();
  }

  // Worklet source: the generator runs on the audio thread. Loudness is
  // measured here on the main thread with a throwaway generator (the warm-up
  // loop must not block the audio thread); the processor then builds its own
  // fresh, statistically identical generator and applies the gain.
  function createWorkletSource(type, options) {
    const sampleRate = audioCtx.sampleRate;
    const gain = DSP.calibrateGain(
      DSP.generators[type](sampleRate, options),
      sampleRate
    );
    const source = new AudioWorkletNode(audioCtx, "noise-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { type, babble: options.babble, gain },
    });
    const node = {
      source,
      env: null,
      release: () => source.port.postMessage("stop"),
    };
    // If the processor fails on the audio thread the node just outputs silence
    // while the button still looks active. Switch to the fallback from here on
    // and, if this is still the playing track, restart it there.
    source.onprocessorerror = () => {
      workletOk = false;
      if (activeNode === node) {
        teardown(node);
        startSource(type);
      }
    };
    return node;
  }

  // Fallback source: generate samples in an onaudioprocess callback on the
  // main thread. The generator is calibrated and then keeps playing from the
  // same state.
  function createScriptSource(type, options) {
    const sampleRate = audioCtx.sampleRate;
    const gen = DSP.generators[type](sampleRate, options);
    const gain = DSP.calibrateGain(gen, sampleRate);

    // Stereo generators (Speech Masking) drive each channel from an independent
    // instance so the two ears get decorrelated noise — wider and harder to
    // listen past. Mono generators write the same sample to both channels,
    // which is identical to plain mono playback (no change for the colours).
    const genR = gen.stereo ? DSP.generators[type](sampleRate, options) : null;

    const source = audioCtx.createScriptProcessor(BLOCK_SIZE, 0, 2);
    source.onaudioprocess = (e) => {
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
    return {
      source,
      env: null,
      release: () => {
        source.onaudioprocess = null;
      },
    };
  }

  // Build the source for a track and fade it in.
  function startSource(type) {
    const options = { babble: babbleEnabled };
    const node = workletOk
      ? createWorkletSource(type, options)
      : createScriptSource(type, options);

    // Per-source envelope gain, ramped 0 -> 1 so playback starts without a click.
    const env = audioCtx.createGain();
    const now = audioCtx.currentTime;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + FADE);

    node.source.connect(env);
    env.connect(gainNode);
    node.env = env;
    activeNode = node;
  }

  function play(type) {
    ensureContext();
    if (audioCtx.state === "suspended") audioCtx.resume();

    activeType = type;
    buttons.forEach((b) =>
      b.classList.toggle("playing", b.dataset.type === type)
    );
    refreshBabbleToggle();
    startSleepTimer();

    // The very first tap has to wait a moment for the worklet module to load;
    // after that this continues straight away. The token drops the start if
    // the user has stopped or switched tracks in the meantime.
    const token = ++playToken;
    workletReady.then(() => {
      if (token === playToken) startSource(type);
    });
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
    if (gainNode) {
      // Glide to the new level instead of jumping, to avoid zipper noise.
      gainNode.gain.setTargetAtTime(
        parseFloat(volumeSlider.value),
        audioCtx.currentTime,
        0.02
      );
    }
    saveSettings();
  });

  // Babble toggle (Speech Masking). The babble vs steady source is chosen when
  // the generator is built, so if Speech Masking is already playing we rebuild
  // it to apply (and recalibrate) the new mode; otherwise just record the flag.
  if (babbleToggle) {
    babbleEnabled = babbleToggle.checked;
    babbleToggle.addEventListener("change", () => {
      babbleEnabled = babbleToggle.checked;
      saveSettings();
      if (activeType === "speech") {
        stop();
        play("speech");
      }
    });
  }
  refreshBabbleToggle();

  // --- Sleep timer ---------------------------------------------------------
  // Optional: after the chosen number of minutes, gently fade the sound out and
  // stop. "Off" (endless playback) is the default. The countdown restarts when
  // a (new) track starts and clears when playback stops.
  //
  // The duration is read from the <select> each time a countdown starts rather
  // than cached from its change event: a browser can restore a form control's
  // value on reload without firing one (Firefox does), and a cached copy would
  // then leave the control showing a timer that isn't actually running.
  function selectedTimerMinutes() {
    return timerSelect ? parseInt(timerSelect.value, 10) || 0 : 0;
  }

  function updateTimerDisplay() {
    if (!timerDisplay) return;
    if (!timerEndAt) {
      timerDisplay.textContent = "";
      return;
    }
    const total = Math.max(0, Math.ceil((timerEndAt - Date.now()) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    timerDisplay.textContent = m + ":" + String(s).padStart(2, "0");
  }

  function clearSleepTimer() {
    if (timerTickId) {
      clearInterval(timerTickId);
      timerTickId = null;
    }
    timerEndAt = 0;
    updateTimerDisplay();
  }

  function startSleepTimer() {
    if (timerTickId) {
      clearInterval(timerTickId);
      timerTickId = null;
    }
    const minutes = selectedTimerMinutes();
    if (minutes <= 0 || !activeType) {
      timerEndAt = 0;
      updateTimerDisplay();
      return;
    }
    timerEndAt = Date.now() + minutes * 60000;
    timerTickId = setInterval(() => {
      if (timerEndAt && Date.now() >= timerEndAt) {
        stop(SLEEP_FADE); // gentle fade-out, then stop (also clears the timer)
      } else {
        updateTimerDisplay();
      }
    }, 1000);
    updateTimerDisplay();
  }

  if (timerSelect) {
    timerSelect.addEventListener("change", () => {
      if (activeType) startSleepTimer();
      else clearSleepTimer();
    });
  }
})();
