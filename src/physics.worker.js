// Physics thread: owns the Rapier world and the timer schedule, steps the
// simulation in real time and streams grain states to the main thread.
//
// The worker is the single authority on time: the release schedule, the
// countdown shown in the UI and the end-of-timer signal all come from here, so
// what you see and what the sand does can't drift apart. Wall-clock time is
// epoch-based (timeOrigin + now) so both threads agree on it.

import RAPIER from '@dimforge/rapier3d-simd-compat';
import { HourglassSim } from './sim/HourglassSim.js';
import { HALF_HEIGHT, NECK_RADIUS } from './sim/profile.js';

const now = () => performance.timeOrigin + performance.now();
const FLIP_SECONDS = 1.4; // simulated duration of turning the glass over
const MAX_STEPS_PER_TICK = 2;
const TAU = Math.PI * 2;

let sim = null;
let topSnapshot = null; // all sand settled in the y > 0 bulb, glass upright
let phase = 'loading'; // loading | ready | flipping | running | paused | done
let run = null; // { N0, duration, elapsed, segStart } (ms)
let flip = null; // { start, from }
let simClock = 0; // wall time the simulation has caught up to
let dtMs = 1000 / 120;
let generation = 0; // bumps on re-init so a superseded init stops early
let ticking = false;

// Buffers handed back by the main thread after it has drawn them. A frame is
// only sent when one is free, which gives natural back-pressure when the page
// is hidden and stops drawing.
let pool = [];
let flowSamples = [];
let costSamples = [];
let speedSamples = [];
let lastStatus = 0;
let restSent = false; // the final at-rest frame has been delivered

const channel = new MessageChannel();
channel.port1.onmessage = () => tick();
const soon = (ms) => (ms <= 0 ? channel.port2.postMessage(0) : setTimeout(tick, ms));

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      await init(m.grainCount);
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
    }
  }
  else if (m.type === 'start') start(m.duration);
  else if (m.type === 'pause') pause();
  else if (m.type === 'resume') resume();
  else if (m.type === 'reset') reset();
  // Buffers from before a grain-count change are simply dropped.
  else if (m.type === 'recycle' && sim && m.buffers.pos.length === sim.N * 3) pool.push(m.buffers);
};

let rapierReady = null;

async function init(grainCount) {
  const gen = ++generation;
  phase = 'loading';
  rapierReady ??= RAPIER.init();
  await rapierReady;
  if (gen !== generation) return;
  if (sim) sim.world.free();
  sim = new HourglassSim(RAPIER, { grainCount });
  dtMs = sim.dt * 1000;
  pool = [makeBuffers(), makeBuffers(), makeBuffers()];

  // Let the freshly poured sand settle in the top bulb, reporting progress.
  const maxSteps = 600;
  for (let n = 0; n < maxSteps; ) {
    for (let k = 0; k < 20; k++, n++) sim.step();
    self.postMessage({ type: 'progress', value: Math.min(0.95, n / 240) });
    await new Promise((r) => setTimeout(r, 0));
    if (gen !== generation) return;
    if (n >= 120 && sim.meanSpeed() < 0.2) break;
  }
  topSnapshot = sim.snapshot();
  sim.restore(topSnapshot, false);
  phase = 'ready';
  run = null;
  self.postMessage({
    type: 'ready',
    grainCount: sim.N,
    grainRadius: sim.r,
    neckRadius: NECK_RADIUS,
    halfHeight: HALF_HEIGHT,
    plugHalf: sim.plugHalf,
    rapierVersion: RAPIER.version(),
  });
  simClock = now();
  flowSamples = [];
  sendFrame(true);
  if (!ticking) {
    ticking = true;
    tick();
  }
}

function makeBuffers() {
  return { pos: new Float32Array(sim.N * 3), rot: new Float32Array(sim.N * 4) };
}

// ----------------------------------------------------------------- commands

function start(duration) {
  if (!sim || (phase !== 'ready' && phase !== 'done')) return;
  run = { N0: 0, duration, elapsed: 0, segStart: 0 };
  // Sand still in the bottom bulb: turn the glass over first, like you would.
  if (sim.countUpper() < sim.N * 0.95) beginFlip();
  else beginRun();
}

function beginFlip() {
  phase = 'flipping';
  sim.gateOpen = false;
  sim.setRotationLocked(true); // the mass slides more than it rolls; also much cheaper
  flip = { start: sim.simTime, from: sim.gravityAngle };
  status();
}

function beginRun() {
  phase = 'running';
  sim.released = 0;
  sim.releaseTarget = 0;
  run.N0 = sim.countUpper();
  run.elapsed = 0;
  run.segStart = now();
  sim.gateOpen = true;
  flowSamples = [];
  status();
}

function pause() {
  if (phase !== 'running') return;
  run.elapsed += now() - run.segStart;
  sim.gateOpen = false;
  phase = 'paused';
  status();
}

function resume() {
  if (phase !== 'paused') return;
  run.segStart = now();
  sim.gateOpen = true;
  phase = 'running';
  status();
}

function reset() {
  if (!sim || phase === 'loading') return;
  // Stand the glass upright (whichever way it is closest to) and put all the
  // sand back in its top bulb.
  const upright = Math.round(sim.gravityAngle / Math.PI) * Math.PI;
  sim.setRotationLocked(false);
  sim.setGravityAngle(upright);
  sim.restore(topSnapshot, sim.up < 0);
  flip = null;
  run = null;
  phase = 'ready';
  status();
  sendFrame(true);
}

// ---------------------------------------------------------------- the loop

function tick() {
  if (phase === 'loading') {
    setTimeout(tick, 50);
    return;
  }
  const t = now();
  let steps = 0;
  const c0 = performance.now();
  while (simClock + dtMs <= t && steps < MAX_STEPS_PER_TICK) {
    stepOnce();
    simClock += dtMs;
    steps++;
  }
  const cost = performance.now() - c0;
  // If the machine can't keep up (e.g. while the whole mass tumbles in a
  // flip), run in slow motion rather than spiralling. The release schedule is
  // wall-clock based, so timing stays exact either way.
  let dropped = 0;
  if (t - simClock > 100) {
    dropped = t - dtMs - simClock;
    simClock = t - dtMs;
  }
  if (steps) {
    costSamples.push(cost / steps);
    if (costSamples.length > 120) costSamples.shift();
    speedSamples.push({ t, sim: steps * dtMs, wall: steps * dtMs + dropped });
    while (speedSamples.length && speedSamples[0].t < t - 1000) speedSamples.shift();
    // Once everything has come to rest there is nothing new to draw.
    if (!sim.atRest || phase === 'flipping' || !restSent) {
      restSent = sendFrame(false) && sim.atRest && phase !== 'flipping';
    }
  }
  if (t - lastStatus > 100) status();
  soon(simClock + dtMs - now());
}

function stepOnce() {
  if (phase === 'flipping') {
    const u = Math.min(1, (sim.simTime - flip.start) / FLIP_SECONDS);
    const e = u * u * (3 - 2 * u);
    // Turn clockwise (as seen from the front), away from the control panel.
    if (u >= 1) {
      const end = flip.from - Math.PI;
      sim.setGravityAngle(((end % TAU) + TAU) % TAU);
      sim.setRotationLocked(false);
      flip = null;
      beginRun();
    } else {
      sim.setGravityAngle(flip.from - Math.PI * e);
    }
  }
  if (phase === 'running') {
    const elapsed = run.elapsed + (now() - run.segStart);
    const f = Math.min(1, elapsed / run.duration);
    sim.releaseTarget = Math.floor(run.N0 * f);
    if (f >= 1) {
      sim.releaseTarget = run.N0;
      run.elapsed = run.duration;
      phase = 'done';
      self.postMessage({ type: 'done' });
      status();
    }
  }
  if (phase === 'done' && sim.released < sim.releaseTarget) sim.gateOpen = true;
  sim.step();
}

// ---------------------------------------------------------------- messages

function timing() {
  if (!run) return { elapsed: 0, duration: 0 };
  const elapsed = phase === 'running' ? run.elapsed + (now() - run.segStart) : run.elapsed;
  return { elapsed: Math.min(elapsed, run.duration), duration: run.duration };
}

function status() {
  lastStatus = now();
  const t = now();
  flowSamples.push({ t, n: sim.released });
  while (flowSamples.length > 2 && flowSamples[0].t < t - 2000) flowSamples.shift();
  const a = flowSamples[0], b = flowSamples[flowSamples.length - 1];
  const flow = b.t > a.t ? ((b.n - a.n) * 1000) / (b.t - a.t) : 0;
  const sp = speedSamples.reduce((s, x) => ({ sim: s.sim + x.sim, wall: s.wall + x.wall }), { sim: 0, wall: 0 });
  const upper = sim.countUpper();
  self.postMessage({
    type: 'status',
    t,
    phase,
    ...timing(),
    N0: run ? run.N0 : 0,
    upper,
    crossing: sim.transit.length,
    lower: sim.N - upper - sim.transit.length,
    released: sim.released,
    target: sim.releaseTarget,
    flow,
    stepMs: costSamples.length ? costSamples.reduce((s, x) => s + x, 0) / costSamples.length : 0,
    simSpeed: sp.wall > 0 ? sp.sim / sp.wall : 1,
    active: sim.N - sim.frozenCount(),
  });
}

function sendFrame(force) {
  if (!pool.length) {
    if (!force) return false;
    pool.push(makeBuffers());
  }
  const buf = pool.pop();
  buf.pos.set(sim.pos);
  buf.rot.set(sim.rot);
  self.postMessage({
    type: 'frame',
    t: now(),
    buffers: buf,
    angle: sim.gravityAngle,
    up: sim.up,
    flowing: phase === 'running',
    rate: run && run.duration ? (run.N0 * 1000) / run.duration : 0,
    pileTop: sim.pileTopOnAxis(),
    phase,
    ...timing(),
  }, [buf.pos.buffer, buf.rot.buffer]);
  return true;
}
