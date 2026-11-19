// StudyNoise AudioWorklet processor — runs one generator from noise-dsp.js on
// the browser's real-time audio thread, so producing samples no longer depends
// on the main thread being free. (Main-thread stalls — rendering, garbage
// collection — are what make a ScriptProcessorNode underrun and pop.)
//
// noise-dsp.js is added to the worklet scope just before this file and
// publishes globalThis.StudyNoiseDSP. One processor is created per playing
// track; the track, babble mode and calibrated gain arrive in
// processorOptions. Fades and the track's level are applied outside by
// GainNodes, so the processor simply streams samples until it is told to stop.

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { type, babble, gain } = options.processorOptions;
    this.gain = gain;
    this.gen = globalThis.StudyNoiseDSP.generators[type](sampleRate, { babble });
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

    // Every track is stereo: next() yields the left sample and leaves the
    // matching right one in gen.right.
    if (right) {
      for (let i = 0; i < left.length; i++) {
        left[i] = gen.next() * gain;
        right[i] = gen.right * gain;
      }
    } else {
      for (let i = 0; i < left.length; i++) left[i] = gen.next() * gain;
    }
    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
