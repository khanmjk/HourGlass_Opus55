// Synthesised sound: a soft hiss while sand flows and a bell when time is up.

export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.hissGain = null;
  }

  /** Must be called from a user gesture the first time. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 1 : 0;
    this.master.connect(ctx.destination);

    // Sand hiss: band-passed noise, modulated by the flow rate.
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0.35);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5200;
    bp.Q.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    src.connect(bp).connect(hp).connect(this.hissGain).connect(this.master);
    src.start();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
  }

  /** rate: grains per second crossing the neck (0 when not flowing). */
  setFlow(rate) {
    if (!this.hissGain) return;
    const level = rate > 0 ? Math.min(0.05, 0.012 + 0.006 * Math.sqrt(rate)) : 0;
    this.hissGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.25);
  }

  chime() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const strike = (t0, f, vol) => {
      // Inharmonic partials of a small bell.
      for (const [ratio, amp, decay] of [[1, 1, 2.4], [2.76, 0.45, 1.3], [5.4, 0.22, 0.7], [8.93, 0.1, 0.4]]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f * ratio;
        o.type = 'sine';
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(vol * amp, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
        o.connect(g).connect(this.master);
        o.start(t0);
        o.stop(t0 + decay + 0.05);
      }
    };
    const t = ctx.currentTime + 0.05;
    strike(t, 880, 0.18);
    strike(t + 0.45, 660, 0.16);
    strike(t + 0.9, 880, 0.14);
  }
}
