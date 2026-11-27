// Card-table sounds and optional background music, synthesized with Web Audio
// (no audio files). Browsers only allow audio after the first tap or click, so
// everything stays silent until then.

const KEY = 'cribbage.sound';
let prefs = { sfx: true, music: false };
try {
  prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
} catch { /* storage blocked: defaults */ }

let ctx = null;
let master;
let sfxBus;
let musicBus;
let noise;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 0.7;
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);
  // Half a second of white noise, reused for card snaps and shuffles.
  noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Call from any user gesture; unlocks audio and resumes music if it was on. */
export function unlockAudio() {
  const c = ensure();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  if (prefs.music) startMusic();
}

export const soundPrefs = () => ({ ...prefs });
export function setSoundPref(key, on) {
  prefs[key] = on;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* fine */ }
  if (key === 'music') (on ? (unlockAudio(), startMusic()) : stopMusic());
}

const ready = () => prefs.sfx && ctx && ctx.state === 'running';

function env(gainNode, t, peak, attack, decay) {
  gainNode.gain.setValueAtTime(0.0001, t);
  gainNode.gain.exponentialRampToValueAtTime(peak, t + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(freq, t, { type = 'sine', peak = 0.2, attack = 0.005, decay = 0.4, bus = sfxBus, detune = 0 } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.detune.value = detune;
  env(g, t, peak, attack, decay);
  o.connect(g).connect(bus);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
  return o;
}

function snap(t, { freq = 2600, q = 0.9, peak = 0.5, decay = 0.07 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = ctx.createGain();
  env(g, t, peak, 0.002, decay);
  src.connect(bp).connect(g).connect(sfxBus);
  src.start(t, Math.random() * 0.3);
  src.stop(t + decay + 0.05);
}

const note = (n) => 440 * 2 ** ((n - 69) / 12); // MIDI note number -> Hz

export const sfx = {
  /** A card landing on the felt. */
  card() {
    if (!ready()) return;
    const t = ctx.currentTime;
    snap(t, { freq: 2200 + Math.random() * 900 });
    tone(150 + Math.random() * 30, t, { peak: 0.12, decay: 0.06 });
  },
  /** A quick riffle of cards for a new deal. */
  deal(count = 6) {
    if (!ready()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < count; i++) snap(t + i * 0.075, { freq: 1800 + Math.random() * 1400, peak: 0.32, decay: 0.05 });
  },
  /** Soft bell for points; more points, more notes. */
  score(points = 2) {
    if (!ready()) return;
    const t = ctx.currentTime + 0.05;
    const scale = [76, 79, 81, 84, 88, 91]; // E5 G5 A5 C6 E6 G6
    const n = Math.min(scale.length, Math.max(1, Math.ceil(points / 2)));
    for (let i = 0; i < n; i++) {
      tone(note(scale[i]), t + i * 0.09, { peak: 0.13, decay: 0.7 });
      tone(note(scale[i]) * 2, t + i * 0.09, { peak: 0.03, decay: 0.4 });
    }
  },
  /** A brighter run up for 31. */
  thirtyOne() {
    if (!ready()) return;
    const t = ctx.currentTime + 0.05;
    [72, 76, 79, 84, 88].forEach((m, i) => {
      tone(note(m), t + i * 0.07, { type: 'triangle', peak: 0.14, decay: 0.8 });
    });
  },
  /** A wooden knock on the table for "Go". */
  go() {
    if (!ready()) return;
    const t = ctx.currentTime;
    for (const dt of [0, 0.14]) {
      const o = tone(190, t + dt, { peak: 0.35, decay: 0.12 });
      o.frequency.exponentialRampToValueAtTime(110, t + dt + 0.1);
      snap(t + dt, { freq: 700, q: 1.5, peak: 0.25, decay: 0.04 });
    }
  },
  /** Chips clicking onto the felt (bets and calls). */
  chips() {
    if (!ready()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const dt = i * 0.045 + Math.random() * 0.02;
      snap(t + dt, { freq: 4200 + Math.random() * 1800, q: 4, peak: 0.22, decay: 0.035 });
      tone(2400 + Math.random() * 600, t + dt, { type: 'triangle', peak: 0.03, decay: 0.03 });
    }
  },
  /** Gentle two-note ping when it becomes your turn. */
  turn() {
    if (!ready()) return;
    const t = ctx.currentTime;
    tone(note(79), t, { peak: 0.09, decay: 0.35 });
    tone(note(84), t + 0.12, { peak: 0.09, decay: 0.5 });
  },
  /** A peg click while hands are counted; rises with the running total. */
  tick(step = 0) {
    if (!ready()) return;
    const t = ctx.currentTime;
    tone(900 + step * 45, t, { type: 'triangle', peak: 0.1, decay: 0.05 });
    snap(t, { freq: 3800, peak: 0.12, decay: 0.03 });
  },
  win() {
    if (!ready()) return;
    const t = ctx.currentTime + 0.05;
    [[72, 0], [76, 0.12], [79, 0.24], [84, 0.36], [79, 0.6], [84, 0.72]].forEach(([m, dt]) => {
      tone(note(m), t + dt, { type: 'triangle', peak: 0.15, decay: dt > 0.5 ? 1.2 : 0.4 });
    });
  },
};

// ---------------------------------------------------------------------------
// Background music: slow, quiet chords under a few random plucked notes.
// ---------------------------------------------------------------------------
const CHORDS = [
  [57, 60, 64, 67], // Am7
  [53, 57, 60, 64], // Fmaj7
  [48, 55, 60, 64], // Cmaj7 (open)
  [55, 59, 62, 64], // G6
];
const PLUCKS = [69, 72, 74, 76, 79, 81]; // A minor pentatonic
const CHORD_LEN = 5.2;
let musicTimer = null;
let nextChord = 0;
let chordIndex = 0;

function scheduleMusic() {
  if (!ctx || document.hidden) return;
  while (nextChord < ctx.currentTime + 1.5) {
    const t = Math.max(nextChord, ctx.currentTime + 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 750;
    lp.connect(musicBus);
    for (const m of CHORDS[chordIndex % CHORDS.length]) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = note(m);
        o.detune.value = detune;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.06, t + 1.6);
        g.gain.setValueAtTime(0.06, t + CHORD_LEN - 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, t + CHORD_LEN + 1.4);
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(t + CHORD_LEN + 1.5);
      }
    }
    // A few soft plucked notes over each chord.
    for (let beat = 0; beat < 4; beat++) {
      if (Math.random() < 0.45) {
        const m = PLUCKS[Math.floor(Math.random() * PLUCKS.length)];
        tone(note(m), t + 0.6 + beat * 1.2 + Math.random() * 0.2, { peak: 0.05, decay: 1.4, bus: musicBus });
      }
    }
    nextChord = t + CHORD_LEN;
    chordIndex++;
  }
}

function startMusic() {
  if (!ensure() || musicTimer) return;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(0.55, ctx.currentTime, 1.5);
  nextChord = ctx.currentTime + 0.1;
  scheduleMusic();
  musicTimer = setInterval(scheduleMusic, 700);
}

function stopMusic() {
  if (!ctx || !musicTimer) return;
  clearInterval(musicTimer);
  musicTimer = null;
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
}

// Audio unlocks on the first gesture; music pauses (new chords stop) in background tabs.
document.addEventListener('pointerdown', unlockAudio, { passive: true });
document.addEventListener('keydown', unlockAudio);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && prefs.music && musicTimer && ctx) nextChord = Math.max(nextChord, ctx.currentTime + 0.1);
});
