# StudyNoise

A tiny, dependency-free web app that generates coloured noise (**white**,
**pink**, **brown** and more), synthesised **ambiences** (rain, ocean, wind)
and **sound-masking** tracks in the browser using the Web Audio API.
Handy as background sound for studying, focusing, relaxing or sleeping.

## Usage

Open `index.html` in any modern browser and tap a sound to switch it on; tap it
again to switch it off. Sounds **layer**: tap several to mix them (brown noise
under rain, Speech Masking together with Rumble Masking, …). While a sound is
on, its card shows a slider for that sound's own level, and the main slider
sets the overall volume. The play/pause button stops the whole mix and brings
the last one back — also after a reload, though nothing ever starts playing by
itself.

Starting and stopping are fade-smoothed so there are no clicks. An optional
**sleep timer** fades the mix out over its last 45 seconds and stops after
15–60 minutes (default: off / endless). The volume, each sound's level, the
café-babble preference and the last mix are remembered across reloads.

To serve it locally:

```bash
python3 -m http.server
# then visit http://localhost:8000
```

### On a phone

- **Install / offline** — served over HTTPS (or localhost) the app can be added
  to the home screen and opens without a connection; a small service worker
  (`sw.js`) keeps a copy of its files. It is network-first, so a newly
  published version shows up on the next load while online.
- **iPhone silent switch** — the page declares itself as media playback
  (`navigator.audioSession`), so the ring/silent switch doesn't mute it.
- **Interruptions** — if the system pauses the audio (a call, another app, the
  lock screen) the page says so instead of showing cards that pulse in
  silence, and resumes when you come back or tap.
- **Lock-screen / headset controls** — the mix is published through the Media
  Session API. On Android a silent `<audio>` element plays alongside it,
  because Android only gives lock-screen controls (and keeps playing with the
  screen off) to pages that play a media element. Like any player this takes
  the audio focus, so other apps' audio pauses while StudyNoise plays; set
  `USE_ANCHOR` to `false` in `noise.js` to mix with other apps instead.
- **Sleep timer** — its fade-out is scheduled on the audio clock, not on a
  page timer, so it still happens on time when the page is hidden or the
  screen is off and the browser is throttling timers.

## How the noise is made

Noise is generated **continuously in real time**, sample by sample,
not by looping a short buffer — so it never repeats and has no seam. Each
generator keeps its own filter/integrator state. All tracks are **stereo**: the
two ears get independent noise, which sounds wide rather than like a point in
the middle of the head (`STEREO_WIDTH` in `noise-dsp.js` narrows it, down to
mono at 0).

### Loudness

Every track is calibrated to the same **A-weighted** level, so they sound about
equally loud at one volume setting. Matching plain RMS doesn't achieve that —
the ear is far less sensitive to lows, so a deep rumble and a bright hiss of
equal RMS were up to 16 dB apart in loudness. The brighter tracks are brought
down to where Brown sits; Brown itself is unchanged. Three tracks cannot be
brought *up* to the others without clipping and so stay quieter: Ocean by
about 4 dB, Black and Rumble Masking by about 9–10 dB (and those two need
headphones or full-range speakers anyway — a phone speaker can barely
reproduce them). Speech Masking deliberately sits 2 dB above the rest, with
babble on or off.

The volume and level sliders are tapered (gain = position²), so the quiet end
of the travel — where sleep levels live — is spread out instead of crammed
into the bottom tenth. A mix that would get loud enough to clip is trimmed
back automatically; a single sound, or a mix at moderate volume, never is.

### The tracks

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
- **Velvet** — sparse noise: mostly silence with one randomly-placed ±1 impulse
  per short window. Broadly flat like white, but the sparseness sounds smoother
  and silkier.
- **Speech Masking** — not a pure colour, but a track tuned to mask the
  *intelligibility* of nearby voices the way office sound-masking systems do.
  Pink noise is shaped with a small filter chain — highpass ~100 Hz (drop
  sub-bass rumble), a boost around 300–600 Hz (the speech-band peak), a
  high-shelf around 3 kHz that lifts the **consonant band** (2–5 kHz is what
  actually makes words decodable), and a lowpass ~6.5 kHz to roll off the
  harshest top — concentrating energy across the ~250 Hz–6 kHz band that
  carries word intelligibility. Like every track it plays in stereo with
  independent left/right noise, which is harder to listen past than a mono
  source. An optional **café babble** mode (on by default) replaces the steady source with
  a sum of several independently-modulated synthetic voices, each coloured by
  wandering vowel-formant resonances. Summing the voices fills each other's
  level dips (so there's no quiet gap for a real voice to peek through), while
  the formant motion adds a speech-like texture that engages the listener's
  phonetic processing — a touch of *informational* masking that flat noise can't
  provide. Turning it **off** gives the steady, habituating noise that
  commercial systems use, which masks just as well; babble is mostly about a
  more natural character. The tuning constants live in the `SPEECH` object near
  the top of `noise-dsp.js`.
- **Rumble Masking** — the low-frequency counterpart to Speech Masking: brown
  noise band-limited to ~40–200 Hz, tuned to cover non-speech intrusions like
  traffic, footsteps and HVAC thumps rather than voices.

Plus a few **synthesised ambiences** (also generated live, never looped):

- **Rain** — a band-passed wash of distant rain with scattered droplet pings
  (each a short, randomly-triggered decaying resonator), scattered left and
  right.
- **Ocean** — brown noise under a slow swell that modulates loudness and
  brightness, so each wave rises and breaks. Both ears share the swell.
- **Wind** — pink noise through a band-pass whose centre and level wander, for
  rising and falling gusts. Each gust is held for 2–6 seconds and approached
  over about a second; both ears share the gusts.

A master limiter on the output catches the rare high peaks of the transient
Rain droplets, and of dense mixes, so nothing clips at high volume; at normal
levels everything passes through it untouched.

### Audio thread

The generators run inside an **AudioWorklet** — on the browser's dedicated
real-time audio thread — so sample generation is isolated from main-thread
rendering and garbage collection. (Generating on the main thread lets the audio
buffer underrun whenever that thread is briefly busy, which is heard as
occasional pops and crackle.) The DOM-free DSP lives in `noise-dsp.js` so the
same code runs in the worklet (`noise-worklet.js`) and on the main thread, where
it is used for loudness calibration and as an automatic fallback: when the
worklet module can't be loaded — for example when `index.html` is opened
straight from a `file://` path — playback uses a `ScriptProcessorNode` instead.
Serve the folder over HTTP (see above) to get the worklet path.

See `noise-dsp.js` for the generators and loudness calibration, and `noise.js`
for the UI, the mixer and the phone handling.
