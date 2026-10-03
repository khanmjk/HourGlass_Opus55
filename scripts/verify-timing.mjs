// Headless check of the physics and the timing: settle the sand in the top
// bulb, run a timer, flip the glass, run it again, and report how closely the
// top bulb emptied to the requested time.
//
//   node scripts/verify-timing.mjs [seconds=60] [grains=3000]
//
// SIM='{"friction":0.4}' overrides simulation options; PILE=1 prints the
// bottom pile profile as it grows.

import RAPIER from '@dimforge/rapier3d-simd-compat';
import { HourglassSim } from '../src/sim/HourglassSim.js';

const T = Number(process.argv[2] ?? 60);
const N = Number(process.argv[3] ?? 3000);
const extra = process.env.SIM ? JSON.parse(process.env.SIM) : {};

await RAPIER.init();
const sim = new HourglassSim(RAPIER, { grainCount: N, ...extra });
console.log(`${N} grains, radius ${(sim.r * 10).toFixed(2)} mm, timer ${T} s, physics ${Math.round(1 / sim.dt)} Hz`);

const time = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

let ms = time(() => sim.settle());
console.log(`settled in top bulb: ${ms.toFixed(0)} ms wall, upper=${sim.countUpper()}`);

function run(label) {
  const N0 = sim.countUpper();
  sim.gateOpen = true;
  sim.released = 0;
  let maxLag = 0, emptiedAt = null, cost = 0, worst = 0;
  const steps = Math.ceil((T + 2) / sim.dt);
  for (let k = 0; k < steps; k++) {
    const t = k * sim.dt;
    sim.releaseTarget = Math.min(N0, Math.floor((N0 * t) / T));
    const c = time(() => sim.step());
    cost += c;
    worst = Math.max(worst, c);
    maxLag = Math.max(maxLag, sim.releaseTarget - sim.released);
    if (emptiedAt === null && sim.countUpper() === 0 && sim.transit.length === 0) emptiedAt = t + sim.dt;
    if (process.env.PILE && k % Math.round(T / 6 / sim.dt) === 0) {
      const rings = new Array(8).fill(99);
      for (let i = 0; i < sim.N; i++) {
        if (sim.side[i] !== -sim.up || sim.inTransit[i] || Math.abs(sim.vel[i * 3 + 1]) > 30) continue;
        const q = Math.min(7, Math.floor(Math.hypot(sim.pos[i * 3], sim.pos[i * 3 + 2]) / 0.5));
        rings[q] = Math.min(rings[q], sim.pos[i * 3 + 1] * -sim.up);
      }
      console.log(`    t=${t.toFixed(0)}s released ${sim.released}/${sim.releaseTarget}, frozen ${sim.frozenCount()}, pile top by ring:`, rings.map((v) => v.toFixed(2)).join(' '));
    }
  }
  sim.gateOpen = false;
  const err = emptiedAt === null ? 'NOT EMPTIED' : `${((emptiedAt - T) * 1000).toFixed(0)} ms`;
  console.log(`${label}: ${N0} grains, top bulb emptied at ${emptiedAt?.toFixed(3)} s (target ${T} s, error ${err}); ` +
    `max lag ${maxLag} grains = ${((maxLag / N0) * T * 1000).toFixed(0)} ms; ` +
    `physics ${(cost / steps).toFixed(2)} ms/step avg, ${worst.toFixed(1)} worst`);
  return emptiedAt !== null && Math.abs(emptiedAt - T) < 0.5;
}

const ok1 = run('run 1');

// Flip the glass over 1.4 s with grain rotation locked, as the app does.
sim.setRotationLocked(true);
const flipT = 1.4;
let k = 0;
ms = time(() => {
  for (k = 1; k * sim.dt <= flipT + 1e-9; k++) {
    const u = (k * sim.dt) / flipT;
    sim.setGravityAngle(Math.PI * u * u * (3 - 2 * u));
    sim.step();
  }
  sim.setGravityAngle(Math.PI);
  sim.setRotationLocked(false);
});
console.log(`flip: ${k - 1} steps in ${ms.toFixed(0)} ms wall (${(ms / (k - 1)).toFixed(1)} ms/step)`);

const ok2 = run('run 2 (after flip)');
console.log(`escapes caught: ${sim.escapes}, containment corrections: ${sim.contained}`);
console.log(ok1 && ok2 ? 'PASS' : 'FAIL');
process.exit(ok1 && ok2 ? 0 : 1);
