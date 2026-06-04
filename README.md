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

Each type fills an audio buffer with a few seconds of samples and loops it:

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

See `noise.js` for the implementation.
