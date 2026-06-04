# StudyNoise

A tiny, dependency-free web app that generates **white**, **pink**, and **brown**
noise in the browser using the Web Audio API. Handy as background sound for
studying or focusing.

## Usage

Open `index.html` in any modern browser, then tap a noise to start or stop it.
Use the slider to set the volume.

To serve it locally:

```bash
python3 -m http.server
# then visit http://localhost:8000
```

## How the noise is made

Noise is generated **continuously in real time** (via a `ScriptProcessorNode`),
not by looping a short buffer — so it never repeats and has no seam. Each
generator keeps its own filter/integrator state and is calibrated to a
consistent loudness:

- **White** — uniformly random samples; flat spectrum (bright hiss).
- **Pink** — white noise shaped to roughly −3 dB/octave (Paul Kellet's filter);
  balanced and natural sounding.
- **Brown** — integrated white noise with a small leak, roughly −6 dB/octave;
  deep and rumbling.
- **Blue** — differentiated pink noise, roughly +3 dB/octave; hissy, airy highs.
- **Violet** — differentiated white noise, roughly +6 dB/octave; sharp treble.
- **Grey** — white noise approximately shaped to an equal-loudness curve, so it
  sounds about as loud across the spectrum (lows and highs boosted, mids
  scooped). This is an approximation built from one-pole filters.
- **Green** — informal "nature/ambience" noise; band-passed white noise with
  energy concentrated in the mid frequencies (~500 Hz).
- **Black** — an ultra-deep rumble (white integrated twice, ~−12 dB/octave).
  Formally "black noise" often means silence; this is the useful audible reading.
- **Speech Masking** — not a pure colour, but a track tuned to mask the
  *intelligibility* of nearby voices the way office sound-masking systems do.
  Pink noise is shaped with a small filter chain — highpass ~100 Hz (drop
  sub-bass rumble), a boost around 300–600 Hz (the speech-band peak), and a
  lowpass ~4.8 kHz (so it isn't hissy) — to concentrate energy in the
  ~250 Hz–6 kHz band that carries word intelligibility. An optional **babble**
  envelope (on by default) slowly varies the level at the 2–7 Hz syllabic rate
  of speech, so it "breathes" like voices and covers them at a lower, more
  comfortable volume than steady noise. The tuning constants live in the
  `SPEECH` object near the top of `noise.js`.

See `noise.js` for the implementation.
