// StudyNoise — UI controller and audio-graph wiring. The generators and their
// loudness calibration live in noise-dsp.js.
//
// Noise is generated CONTINUOUSLY in real time rather than looping a short
// buffer, so the output never repeats and has no seam. Any number of tracks can
// play at once (tap to layer them); each is its own source in this graph:
//
//   source -> fade GainNode (anti-click) -> level GainNode (the track's slider)
//                                                |
//   master GainNode (volume) <-------------------+   every track mixes in here
//     -> sleep GainNode (the sleep timer's fade-out)
//     -> DynamicsCompressor (limiter) -> destination
//
// A source is normally an AudioWorkletNode (noise-worklet.js), which runs the
// generator on the browser's real-time audio thread — so a busy main thread
// (rendering, garbage collection) can't make the audio underrun and pop. Where
// the worklet can't be loaded (a local file:// path, an insecure origin, an old
// browser) it falls back to a ScriptProcessorNode on the main thread: the same
// sound, just more prone to the occasional glitch.

(function () {
  "use strict";

  const DSP = globalThis.StudyNoiseDSP; // generators + calibration (noise-dsp.js)
  const BLOCK_SIZE = 4096; // buffer size of the ScriptProcessor fallback
  const FADE = 0.04; // short anti-click ramp on start/stop (seconds)
  const SLEEP_FADE = 45; // the sleep timer fades out over its last seconds
  const IDLE_SUSPEND_MS = 1000; // release the audio hardware this long after a stop
  const HEADROOM_RMS = 0.25; // a mix louder than this RMS gets trimmed (see below)
  const STORE_KEY = "studynoise"; // localStorage key for persisted settings
  const HINT_STALLED = "Paused by your device — tap anywhere to resume.";
  // Android only shows lock-screen controls for (and reliably keeps alive) pages
  // that are playing a media element; see the "media anchor" section.
  const USE_ANCHOR =
    /Android/i.test(navigator.userAgent) && !navigator.audioSession;

  let audioCtx = null;
  let masterGain = null; // volume slider × headroom trim
  let sleepGain = null; // 1 normally; the sleep timer ramps it to 0
  let workletReady = null; // settles once we know whether the worklet loaded
  let workletOk = false; // true while the AudioWorklet path is usable
  let suspendTimer = null; // pending "release the audio hardware" after a stop
  let stallTimer = null;
  let stalled = false; // tracks are on, but the system has paused the audio

  const wanted = new Set(); // tracks the user has switched on — "the mix"
  const active = new Map(); // type -> { source, env, level, rms, ... } sounding now
  const calibrations = new Map(); // measured { gain, rms } per track, cached
  let lastMix = []; // the most recent non-empty mix, for the play button

  // Sleep timer, in AudioContext time (0 = off). See the timer section.
  let timerEndAt = 0;
  let fadeStartAt = 0;
  let timerTickId = null;

  const volumeSlider = document.getElementById("volume");
  const playButton = document.getElementById("playpause");
  const babbleToggle = document.getElementById("babble");
  const babbleToggleLabel = document.querySelector(".toggle");
  const timerSelect = document.getElementById("timer");
  const timerDisplay = document.getElementById("timer-remaining");
  const hint = document.getElementById("hint");
  const defaultHint = hint.textContent;

  // Sliders hold a POSITION; the gain is its square. Loudness follows the
  // logarithm of gain, so a slider wired straight to gain spends its whole top
  // half on the last 6 dB and crams every quiet level into the bottom tenth.
  // Squaring spreads the quiet end out, which is where sleep levels live.
  function sliderToGain(position) {
    return position * position;
  }

  function quiet(promise) {
    if (promise && promise.catch) promise.catch(() => {});
  }

  // --- Track cards ---------------------------------------------------------
  // Each card is a toggle button plus a level slider that takes the place of
  // the description line while the track is in the mix.
  const cards = new Map(); // type -> { card, button, level, name }
  document.querySelectorAll(".noise").forEach((card) => {
    const type = card.dataset.type;
    const button = card.querySelector(".noise-btn");
    const name = card.querySelector(".label").textContent.trim();

    const level = document.createElement("input");
    level.type = "range";
    level.className = "level";
    level.min = "0.1";
    level.max = "1";
    level.step = "0.01";
    level.value = "1";
    level.disabled = true;
    level.title = name + " level";
    level.setAttribute("aria-label", name + " level");
    card.appendChild(level);
    cards.set(type, { card, button, level, name });

    button.addEventListener("click", () => {
      // While the system has the audio paused, a tap on a lit card means
      // "carry on", not "switch this one off".
      if (stalled && wanted.has(type)) {
        tryResume();
        return;
      }
      toggle(type);
    });

    level.addEventListener("input", () => {
      const node = active.get(type);
      if (node) {
        node.level.gain.setTargetAtTime(
          sliderToGain(parseFloat(level.value)),
          audioCtx.currentTime,
          0.02
        );
      }
      updateMasterGain();
      saveSettings();
    });
  });

  function mixName(types) {
    return types.map((t) => cards.get(t).name).join(" + ");
  }

  // --- Persistence ---------------------------------------------------------
  // Remember the volume, each track's level, the café-babble preference and the
  // last mix across reloads. The mix is not auto-resumed — browsers block sound
  // without a gesture, and waking a sleeper on page load would be unwelcome —
  // but the play button brings it back with one tap.
  function saveSettings() {
    const levels = {};
    cards.forEach((c, type) => {
      levels[type] = parseFloat(c.level.value);
    });
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          v: 2,
          volume: parseFloat(volumeSlider.value),
          babble: babbleToggle.checked,
          levels,
          mix: lastMix,
        })
      );
    } catch (err) {
      /* storage unavailable (private mode, etc.) — just don't persist */
    }
  }

  function loadSettings() {
    let s;
    try {
      s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
    } catch (err) {
      return;
    }
    if (typeof s.volume === "number" && s.volume >= 0 && s.volume <= 1) {
      // Before v2 the stored number was the gain itself; it is now the slider
      // position, so convert an old value to the position that sounds the same.
      volumeSlider.value = String(s.v === 2 ? s.volume : Math.sqrt(s.volume));
    }
    if (typeof s.babble === "boolean") babbleToggle.checked = s.babble;
    if (s.levels && typeof s.levels === "object") {
      cards.forEach((c, type) => {
        const value = s.levels[type];
        if (typeof value === "number" && value >= 0.1 && value <= 1) {
          c.level.value = String(value);
        }
      });
    }
    if (Array.isArray(s.mix)) lastMix = s.mix.filter((t) => cards.has(t));
  }
  loadSettings();

  // --- Audio graph ---------------------------------------------------------

  // Create the context and the shared part of the graph. This runs
  // synchronously inside the first tap (browsers require a user gesture), and
  // kicks off loading the worklet in the background.
  function ensureContext() {
    if (audioCtx) return;

    // iOS treats Web Audio as "ambient" sound by default: it obeys the ring/
    // silent switch, so with the phone on silent nothing is heard at all.
    // Declaring media playback lifts that (Safari 16.4+).
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch (err) {
      /* not supported — stay with the default */
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioCtx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = sliderToGain(parseFloat(volumeSlider.value));
    sleepGain = audioCtx.createGain();

    // Master safety limiter: catches the rare high peaks of the transient-rich
    // Rain droplets, and of dense mixes, so they can't clip at high volume. The
    // threshold sits just below full scale, so at normal levels everything
    // passes through untouched.
    const limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -1.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;

    masterGain.connect(sleepGain);
    sleepGain.connect(limiter);
    limiter.connect(audioCtx.destination);

    audioCtx.addEventListener("statechange", scheduleStallCheck);

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

  // The master gain is the volume slider, less a trim that only engages when
  // the mix itself is too hot. Each track's RMS is known from calibration and
  // independent noises add in power, so the mix's level can be predicted; if it
  // would exceed HEADROOM_RMS (about where a noise's peaks reach full scale)
  // the master is pulled back to that, rather than leaving the limiter to
  // squash it. A single track never gets there, nor does a mix at moderate
  // volume, so adding a layer normally just adds.
  function updateMasterGain() {
    if (!masterGain) return;
    let power = 0;
    active.forEach((node, type) => {
      const rms = node.rms * sliderToGain(parseFloat(cards.get(type).level.value));
      power += rms * rms;
    });
    const volume = sliderToGain(parseFloat(volumeSlider.value));
    const mixRms = volume * Math.sqrt(power);
    const trim = mixRms > HEADROOM_RMS ? HEADROOM_RMS / mixRms : 1;
    masterGain.gain.setTargetAtTime(volume * trim, audioCtx.currentTime, 0.02);
  }

  // Loudness is measured once per track (and babble mode) and then reused: the
  // measurement runs a throwaway generator on the main thread for a few tens of
  // milliseconds, which is fine once but not on every start.
  function calibration(type, options) {
    const key = type === "speech" ? type + ":" + options.babble : type;
    let result = calibrations.get(key);
    if (!result) {
      result = DSP.calibrate(type, audioCtx.sampleRate, options);
      calibrations.set(key, result);
    }
    return result;
  }

  // Worklet source: the generator runs on the audio thread, which builds it
  // from the track name and applies the calibrated gain.
  function createWorkletSource(type, options, gain) {
    const source = new AudioWorkletNode(audioCtx, "noise-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { type, babble: options.babble, gain },
    });
    const node = {
      source,
      release: () => source.port.postMessage("stop"),
    };
    // If the processor fails on the audio thread the node just outputs silence
    // while the card still looks active. Switch to the fallback from here on
    // and, if this track is still playing, restart it there.
    source.onprocessorerror = () => {
      workletOk = false;
      if (active.get(type) === node) {
        teardown(node);
        active.delete(type);
        startSource(type);
      }
    };
    return node;
  }

  // Fallback source: generate samples in an onaudioprocess callback on the
  // main thread.
  function createScriptSource(type, options, gain) {
    const gen = DSP.generators[type](audioCtx.sampleRate, options);
    const source = audioCtx.createScriptProcessor(BLOCK_SIZE, 0, 2);
    source.onaudioprocess = (e) => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      for (let i = 0; i < outL.length; i++) {
        outL[i] = gen.next() * gain;
        outR[i] = gen.right * gain;
      }
    };
    return {
      source,
      release: () => {
        source.onaudioprocess = null;
      },
    };
  }

  // Build the source for a track and fade it in.
  function startSource(type) {
    const options = { babble: babbleToggle.checked };
    const cal = calibration(type, options);
    let node = null;
    if (workletOk) {
      try {
        node = createWorkletSource(type, options, cal.gain);
      } catch (err) {
        workletOk = false;
      }
    }
    if (!node) node = createScriptSource(type, options, cal.gain);

    // Per-source envelope gain, ramped 0 -> 1 so playback starts without a click.
    const now = audioCtx.currentTime;
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + FADE);

    const level = audioCtx.createGain();
    level.gain.value = sliderToGain(parseFloat(cards.get(type).level.value));

    node.source.connect(env);
    env.connect(level);
    level.connect(masterGain);
    node.env = env;
    node.level = level;
    node.rms = cal.rms;
    node.startedAt = now;
    active.set(type, node);
    updateMasterGain();
  }

  // Disconnect a finished source and let it stop generating.
  function teardown(node) {
    try {
      node.source.disconnect();
      node.env.disconnect();
      node.level.disconnect();
    } catch (err) {
      /* ignore */
    }
    node.release();
  }

  // Ramp a source's own gain down to silence, then disconnect it once the ramp
  // has finished — so stopping never produces a click. The ramp starts from
  // where the fade-in has got to (worked out from its start time rather than
  // read back from the AudioParam, which not every browser reports mid-ramp).
  function fadeOutAndTeardown(node, fadeSec) {
    const now = audioCtx.currentTime;
    const current = Math.min(1, Math.max(0, (now - node.startedAt) / FADE));
    try {
      node.env.gain.cancelScheduledValues(now);
      node.env.gain.setValueAtTime(current, now);
      node.env.gain.linearRampToValueAtTime(0, now + fadeSec);
    } catch (err) {
      /* ignore */
    }
    setTimeout(() => teardown(node), fadeSec * 1000 + 50);
  }

  // --- The mix -------------------------------------------------------------

  function startTrack(type) {
    if (wanted.has(type)) return;
    const first = wanted.size === 0;
    ensureContext();
    wanted.add(type);
    wake();
    if (first) startSleepTimer();
    // The very first tap has to wait a moment for the worklet module to load;
    // after that this continues straight away. The checks drop the start if
    // the track has been switched off again in the meantime.
    workletReady.then(() => {
      if (wanted.has(type) && !active.has(type)) startSource(type);
    });
  }

  function stopTrack(type, fadeSec) {
    wanted.delete(type);
    const node = active.get(type);
    if (node) {
      active.delete(type);
      fadeOutAndTeardown(node, fadeSec);
    }
  }

  // Tap on a card: add the track to the mix, or take it out.
  function toggle(type) {
    if (wanted.has(type)) stopTrack(type, FADE);
    else startTrack(type);
    if (wanted.size) lastMix = Array.from(wanted);
    afterMixChange();
  }

  // Stop everything but remember the mix, so "play" can bring it back.
  function pauseAll(fadeSec) {
    if (!wanted.size) return;
    lastMix = Array.from(wanted);
    lastMix.forEach((type) => stopTrack(type, fadeSec));
    afterMixChange();
  }

  function resumeMix() {
    if (wanted.size || !lastMix.length) return;
    lastMix.slice().forEach(startTrack);
    afterMixChange();
  }

  function afterMixChange() {
    if (!wanted.size) {
      clearSleepTimer();
      goIdle();
    }
    updateMasterGain();
    refreshUi();
    updateMediaSession();
    scheduleStallCheck();
    saveSettings();
  }

  // Something is about to play: make sure the audio is actually running.
  function wake() {
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    if (audioCtx.state !== "running") quiet(audioCtx.resume());
    startAnchor();
  }

  // Nothing is playing: once the fade-out is through, suspend the context so
  // the page stops holding the audio hardware (and, on a phone, the audio
  // session) while it sits silent.
  function goIdle() {
    stopAnchor();
    if (!audioCtx) return;
    if (suspendTimer) clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      if (!wanted.size && audioCtx.state === "running") quiet(audioCtx.suspend());
    }, IDLE_SUSPEND_MS);
  }

  function refreshUi() {
    const playing = wanted.size > 0;
    cards.forEach((c, type) => {
      const on = wanted.has(type);
      c.card.classList.toggle("playing", on);
      c.button.setAttribute("aria-pressed", String(on));
      c.level.disabled = !on;
    });

    playButton.classList.toggle("is-playing", playing);
    playButton.disabled = !playing && !lastMix.length;
    playButton.setAttribute("aria-label", playing ? "Pause" : "Play");
    playButton.title = playing
      ? "Pause all sounds"
      : lastMix.length
        ? "Play " + mixName(lastMix)
        : "Pick a sound first";

    // The babble toggle only affects Speech Masking, so dim and disable it
    // while a mix without that track is playing.
    const relevant = !playing || wanted.has("speech");
    babbleToggle.disabled = !relevant;
    babbleToggleLabel.classList.toggle("is-disabled", !relevant);
  }

  playButton.addEventListener("click", () => {
    if (stalled) {
      tryResume();
      return;
    }
    if (wanted.size) pauseAll(FADE);
    else resumeMix();
  });

  volumeSlider.addEventListener("input", () => {
    updateMasterGain(); // glides to the new level, so no zipper noise
    saveSettings();
  });

  // Babble vs steady is chosen when the Speech Masking generator is built, so
  // if that track is sounding, swap it for a fresh one in the new mode.
  babbleToggle.addEventListener("change", () => {
    saveSettings();
    const node = active.get("speech");
    if (node) {
      active.delete("speech");
      fadeOutAndTeardown(node, FADE);
      startSource("speech");
    }
  });

  // --- Interruptions -------------------------------------------------------
  // A phone can pause the audio underneath us — a call, another app taking the
  // audio session, the screen locking — which leaves the context "suspended"
  // (or, on iOS, "interrupted") while the mix is still switched on. Say so
  // instead of showing cards that pulse in silence, and resume when the page
  // comes back or on the next tap anywhere.
  function scheduleStallCheck() {
    if (stallTimer) clearTimeout(stallTimer);
    // Debounced: a context is briefly "suspended" on every normal start too.
    stallTimer = setTimeout(checkStall, 400);
  }

  function checkStall() {
    stallTimer = null;
    const now = !!audioCtx && wanted.size > 0 && audioCtx.state !== "running";
    if (now === stalled) return;
    stalled = now;
    document.body.classList.toggle("is-stalled", stalled);
    hint.textContent = stalled ? HINT_STALLED : defaultHint;
    updateMediaSession();
  }

  function tryResume() {
    if (!audioCtx || !wanted.size || audioCtx.state === "running") return;
    quiet(audioCtx.resume());
    startAnchor();
  }

  document.addEventListener("pointerdown", tryResume, true);
  document.addEventListener("keydown", tryResume, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // With the media anchor, another app may legitimately hold the audio; then
    // only an explicit tap takes it back.
    if (!USE_ANCHOR) tryResume();
    checkSleepTimer(); // the countdown's own tick is throttled while hidden
  });

  // --- Media anchor (Android) ----------------------------------------------
  // Android's browsers only treat a page as "playing media" — lock-screen and
  // headset controls, and not being put to sleep with the screen off — while a
  // media element plays; Web Audio alone doesn't count. So a silent, looping
  // <audio> element plays alongside the mix. When the system pauses it (a call,
  // another app taking the audio) the mix is suspended with it, and resumes
  // when the system lets it play again.
  //
  // The cost: like any media player, this takes Android's audio focus, so
  // other apps' audio pauses while StudyNoise plays. To mix with other apps
  // instead (and give up the lock-screen controls), set USE_ANCHOR to false.
  let anchor = null;
  let anchorOn = false;

  function silentWavUrl() {
    // Ten seconds of 8-bit mono silence. Long enough to count as media (very
    // short clips get no lock-screen controls), still only ~80 kB in memory.
    const rate = 8000;
    const samples = rate * 10;
    const buffer = new ArrayBuffer(44 + samples);
    const view = new DataView(buffer);
    const text = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + samples, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate, true); // bytes per second
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    text(36, "data");
    view.setUint32(40, samples, true);
    new Uint8Array(buffer, 44).fill(128); // 8-bit PCM silence
    return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  }

  function startAnchor() {
    if (!USE_ANCHOR) return;
    if (!anchor) {
      anchor = new Audio(silentWavUrl());
      anchor.loop = true;
      anchor.addEventListener("pause", () => {
        if (anchorOn && audioCtx.state === "running") quiet(audioCtx.suspend());
      });
      anchor.addEventListener("play", () => {
        if (anchorOn && audioCtx.state !== "running") quiet(audioCtx.resume());
      });
    }
    anchorOn = true;
    quiet(anchor.play());
  }

  function stopAnchor() {
    anchorOn = false;
    if (anchor) anchor.pause();
  }

  // --- Lock-screen / headset controls --------------------------------------
  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    const playing = wanted.size > 0;
    const types = playing ? Array.from(wanted) : lastMix;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: types.length ? mixName(types) : "StudyNoise",
        artist: "StudyNoise",
        artwork: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
      navigator.mediaSession.playbackState =
        playing && !stalled ? "playing" : "paused";
    } catch (err) {
      /* ignore */
    }
  }

  if ("mediaSession" in navigator) {
    const actions = {
      play: () => {
        if (wanted.size) tryResume();
        else resumeMix();
      },
      pause: () => pauseAll(FADE),
      stop: () => pauseAll(FADE),
    };
    Object.keys(actions).forEach((action) => {
      try {
        navigator.mediaSession.setActionHandler(action, actions[action]);
      } catch (err) {
        /* this browser doesn't offer the action */
      }
    });
  }

  // --- Sleep timer ---------------------------------------------------------
  // Optional: after the chosen number of minutes, fade the sound out and stop.
  // "Off" (endless playback) is the default. The countdown starts when playback
  // starts, or when the timer is changed while playing; adding or removing a
  // layer leaves it alone, and stopping clears it.
  //
  // The fade-out is scheduled on the AUDIO clock, as automation of sleepGain,
  // so it happens on time on the audio thread whatever the page's own timers
  // are doing — browsers throttle those heavily once a page is hidden or the
  // screen is off, which is exactly when a sleep timer runs out. The page's
  // timer only updates the countdown and tidies up once the fade has finished.
  //
  // The duration is read from the <select> each time a countdown starts rather
  // than cached from its change event: a browser can restore a form control's
  // value on reload without firing one (Firefox does), and a cached copy would
  // then leave the control showing a timer that isn't actually running.
  function selectedTimerMinutes() {
    return parseFloat(timerSelect.value) || 0;
  }

  // The scheduled value of sleepGain at audio time t — the same curve as the
  // automation below: 1 until the fade starts, an exponential glide down to
  // -40 dB, then a last linear second to true silence.
  function sleepGainAt(t) {
    if (!timerEndAt || t <= fadeStartAt) return 1;
    if (t >= timerEndAt) return 0;
    const knee = timerEndAt - 1;
    if (t >= knee) return 0.01 * (timerEndAt - t);
    return Math.pow(0.01, (t - fadeStartAt) / (knee - fadeStartAt));
  }

  function updateTimerDisplay() {
    if (!timerEndAt) {
      timerDisplay.textContent = "";
      return;
    }
    const total = Math.max(0, Math.ceil(timerEndAt - audioCtx.currentTime));
    const m = Math.floor(total / 60);
    const s = total % 60;
    timerDisplay.textContent = m + ":" + String(s).padStart(2, "0");
  }

  function clearSleepTimer() {
    if (timerTickId) {
      clearInterval(timerTickId);
      timerTickId = null;
    }
    if (audioCtx) {
      // Drop any scheduled fade and glide back to full from wherever it had
      // got to. Whatever is still sounding is fading out on its own envelope
      // faster than this rises, so nothing swells back up.
      const now = audioCtx.currentTime;
      sleepGain.gain.cancelScheduledValues(now);
      sleepGain.gain.setValueAtTime(sleepGainAt(now), now);
      sleepGain.gain.setTargetAtTime(1, now, 0.1);
    }
    timerEndAt = 0;
    fadeStartAt = 0;
    updateTimerDisplay();
  }

  function startSleepTimer() {
    clearSleepTimer();
    const seconds = selectedTimerMinutes() * 60;
    if (seconds <= 0 || !wanted.size) return;

    const fade = Math.max(2, Math.min(SLEEP_FADE, seconds / 2));
    timerEndAt = audioCtx.currentTime + seconds;
    fadeStartAt = timerEndAt - fade;
    sleepGain.gain.setValueAtTime(1, fadeStartAt);
    sleepGain.gain.exponentialRampToValueAtTime(0.01, timerEndAt - 1);
    sleepGain.gain.linearRampToValueAtTime(0, timerEndAt);

    timerTickId = setInterval(checkSleepTimer, 1000);
    updateTimerDisplay();
  }

  function checkSleepTimer() {
    if (!timerEndAt) return;
    // By now the audio thread has already faded to silence; just stop (which
    // also clears the timer).
    if (audioCtx.currentTime >= timerEndAt) pauseAll(0);
    else updateTimerDisplay();
  }

  timerSelect.addEventListener("change", () => {
    if (wanted.size) startSleepTimer();
    else clearSleepTimer();
  });

  // --- Offline -------------------------------------------------------------
  // The service worker keeps a copy of the app's few files so it opens (and can
  // be installed to the home screen) without a connection. Needs http(s).
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => {
      quiet(navigator.serviceWorker.register("sw.js"));
    });
  }

  refreshUi();
  updateMediaSession();
})();
