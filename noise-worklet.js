// StudyNoise AudioWorklet processor — runs one generator from noise-dsp.js on
// the browser's real-time audio thread, so producing samples no longer depends
// on the main thread being free. (Main-thread stalls — rendering, garbage
// collection — are what make a ScriptProcessorNode underrun and pop.)
//
// noise-dsp.js is added to the worklet scope just before this file and
// publishes globalThis.StudyNoiseDSP. One processor is created per playing
// source; the track, babble mode and calibrated gain arrive in
// processorOptions. Fades are applied outside by a GainNode, so the processor
// simply streams samples until it is told to stop.

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { type, babble, gain } = options.processorOptions;
    const create = globalThis.StudyNoiseDSP.generators[type];
    this.gain = gain;
    this.gen = create(sampleRate, { babble });
    // Stereo tracks (Speech Masking) drive each channel from its own generator
    // so the two ears get decorrelated noise.
    this.genR = this.gen.stereo ? create(sampleRate, { babble }) : null;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.running = false;
    };
  }

  process(inputs, outputs) {
    // Returning false once stopped lets the browser collect the node.
    if (!this.running) return false;

    const out = outputs[0];
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const gain = this.gain;
    const gen = this.gen;
    const genR = this.genR;

    if (genR && right) {
      for (let i = 0; i < left.length; i++) {
        left[i] = gen.next() * gain;
        right[i] = genR.next() * gain;
      }
    } else {
      for (let i = 0; i < left.length; i++) {
        const v = gen.next() * gain;
        left[i] = v;
        if (right) right[i] = v;
      }
    }
    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
