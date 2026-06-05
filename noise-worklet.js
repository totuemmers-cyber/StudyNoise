// AudioWorklet wrapper for StudyNoise. Runs the shared DSP (noise-dsp.js, added
// to the worklet scope just before this file) on the real-time audio thread, so
// generating samples is no longer at the mercy of the main thread's rendering
// and garbage collection — which is what caused the occasional buffer-underrun
// pops with the ScriptProcessorNode.
//
// The main thread drives it with messages:
//   { cmd: "play", noise: "<type>", babble: <bool>, gain: <number> }
//   { cmd: "stop" }
// Loudness calibration is done on the main thread (it must not block the audio
// thread), and the resulting per-sample gain is passed in with "play".

class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gen = null; // left/mono generator
    this.genR = null; // right generator (stereo tracks only)
    this.gain = 1;
    this.playing = false;

    this.port.onmessage = (e) => {
      const DSP = self.StudyNoiseDSP;
      const msg = e.data;
      if (msg.cmd === "play" && DSP && DSP.generators[msg.noise]) {
        DSP.setBabble(msg.babble);
        this.gen = DSP.generators[msg.noise](sampleRate);
        this.genR = this.gen.stereo ? DSP.generators[msg.noise](sampleRate) : null;
        this.gain = msg.gain;
        this.playing = true;
      } else if (msg.cmd === "stop") {
        this.playing = false;
        this.gen = null;
        this.genR = null;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const left = out[0];
    const right = out[1] || null;
    const n = left.length;

    if (!this.playing || !this.gen) {
      for (let i = 0; i < n; i++) {
        left[i] = 0;
        if (right) right[i] = 0;
      }
      return true; // keep the processor alive, ready for the next "play"
    }

    const g = this.gain;
    const gen = this.gen;
    const genR = this.genR;
    if (genR && right) {
      for (let i = 0; i < n; i++) {
        left[i] = gen.next() * g;
        right[i] = genR.next() * g;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = gen.next() * g;
        left[i] = v;
        if (right) right[i] = v;
      }
    }
    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
