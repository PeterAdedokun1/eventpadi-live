"use strict";
/* Projector sound: effects and background music synthesised with the Web Audio API
   (no audio files to download). Browsers only allow audio after a click, so the
   context starts on the host's first click. Muting is remembered on this computer. */

const sound = {
  ctx: null,
  master: null,
  musicGain: null,
  muted: store.get("ep-live:muted") === true,
  mode: null,          // current music: "lobby" | "think" | null
  step: 0,
  nextAt: 0,
  timer: null,

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.7;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.16;
      this.musicGain.connect(this.master);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  setMuted(m) {
    this.muted = m;
    store.set("ep-live:muted", m);
    if (this.init()) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  },

  /* One synthesised note. */
  note(freq, at, dur, { type = "sine", vol = 0.25, out, slide, attack = 0.01 } = {}) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out || this.master);
    o.start(at); o.stop(at + dur + 0.05);
  },

  play(name) {
    if (this.muted || !this.init() || this.ctx.state !== "running") return;
    const t = this.ctx.currentTime, n = (f, d, o) => this.note(f, t + d, o && o.dur || 0.2, o);
    switch (name) {
      case "join": n(660, 0, { dur: 0.12, vol: 0.18, type: "triangle" }); n(990, 0.07, { dur: 0.16, vol: 0.16, type: "triangle" }); break;
      case "start": [523, 659, 784, 1047].forEach((f, i) => n(f, i * 0.09, { dur: 0.25, vol: 0.2, type: "triangle" })); break;
      case "tick": n(1200, 0, { dur: 0.05, vol: 0.12, type: "square" }); break;
      case "lasttick": n(880, 0, { dur: 0.12, vol: 0.2, type: "square" }); break;
      case "flick": n(1500 + Math.random() * 300, 0, { dur: 0.03, vol: 0.06, type: "square" }); break;
      case "reveal": n(392, 0, { dur: 0.18, vol: 0.2, type: "triangle" }); n(523, 0.12, { dur: 0.18, vol: 0.2, type: "triangle" }); n(784, 0.24, { dur: 0.45, vol: 0.22, type: "triangle" }); break;
      case "whoosh": n(200, 0, { dur: 0.4, vol: 0.12, type: "sawtooth", slide: 900 }); break;
      case "fanfare":
        [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.36], [784, 0.6], [1047, 0.72]].forEach(([f, d]) => n(f, d, { dur: d > 0.5 ? 0.6 : 0.2, vol: 0.22, type: "triangle" }));
        [262, 330, 392].forEach((f) => n(f, 0.72, { dur: 0.9, vol: 0.1, type: "sine" }));
        break;
    }
  },

  /* Background music: a small step sequencer with look-ahead scheduling. */
  music(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    clearInterval(this.timer); this.timer = null;
    if (!mode || !this.init()) return;
    this.step = 0;
    this.nextAt = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  },

  schedule() {
    if (!this.ctx || this.ctx.state !== "running") return;
    const lobby = this.mode === "lobby";
    const stepDur = lobby ? 60 / 104 / 4 : 60 / 132 / 4;
    // Lobby: I–V–vi–IV in C with a bouncy arpeggio. Think: a tense minor pulse.
    const chords = lobby
      ? [[261.6, 329.6, 392.0], [196.0, 246.9, 293.7], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6]]
      : [[220.0, 261.6, 329.6], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
    while (this.nextAt < this.ctx.currentTime + 0.12) {
      const s = this.step % 64, chord = chords[Math.floor(s / 16)], at = this.nextAt, out = this.musicGain;
      if (lobby) {
        if (s % 4 === 0) this.note(chord[0] / 2, at, 0.35, { type: "sine", vol: 0.5, out });
        if (s % 2 === 0) this.note(chord[(s / 2) % 3] * 2, at, 0.18, { type: "triangle", vol: 0.25, out });
        if (s % 8 === 4) this.note(chord[2] * 2, at, 0.3, { type: "sine", vol: 0.18, out });
      } else {
        if (s % 2 === 0) this.note(chord[0] / 2, at, 0.12, { type: "sawtooth", vol: 0.18, out });
        if (s % 4 === 2) this.note(chord[1] * 2, at, 0.08, { type: "square", vol: 0.08, out });
        if (s % 16 === 0) this.note(chord[2] * 2, at, 0.5, { type: "triangle", vol: 0.2, out });
      }
      this.nextAt += stepDur;
      this.step++;
    }
  }
};

// Start audio on the first click anywhere (browser autoplay rules).
document.addEventListener("click", () => sound.init(), { capture: true });
