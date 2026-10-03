// Granular physics for the hourglass, built on the Rapier physics engine.
//
// Every grain is a Rapier rigid body: a frictional sphere with rolling damped,
// so piles hold a sand-like angle of repose (~30 deg) and arches over the neck
// break the way they do in real dry sand. The glass is a static triangle mesh.
// Physics runs in the glass's own frame, so flipping the hourglass rotates the
// gravity vector rather than the mesh.
//
// Timing: a real hourglass keeps time because the flow through its neck is
// constant (Beverloo's law: the rate depends on the orifice, not on how much
// sand sits above it). Here the neck holds a thin diaphragm that grains can
// only cross when the metering gate lets one through, at exactly N / T grains
// per second. The gate always takes the grain sitting lowest in the orifice;
// that grain stops touching the diaphragm and the sand it is leaving, drops
// through the neck under gravity, and becomes ordinary sand again below. Its
// neighbours fall into the gap it leaves, which is what carves the crater in
// the top bulb. Nothing is teleported.
//
// Performance: sand that is not moving is "frozen" (switched to a fixed body)
// and thawed again as soon as anything near it moves, so the solver only works
// on the grains that are actually flowing.

import {
  HALF_HEIGHT, NECK_RADIUS, radiusAt, clearanceAt, bulbVolume, fullProfile, buildGlassSDF,
} from './profile.js';

export const GRAVITY = 981; // cm/s^2

const groups = (member, filter) => ((member << 16) | filter) >>> 0;
const G_GLASS = groups(0x1, 0xffff);
const G_PLUG = groups(0x2, 0xffff);
// Grains belong to the bulb they are in. A metered grain crosses in two
// stages: while it funnels down to the diaphragm it touches only the glass (so
// grains queued in the throat can't jam each other), and once it is through
// and clear of anything it would overlap, it also touches the other crossing
// grains and the sand of the bulb it is falling into.
const SIDE_POS = 0x4, SIDE_NEG = 0x10, ENTERING = 0x8, EXITING = 0x20;
const G_POS = groups(SIDE_POS, 0xffff);
const G_NEG = groups(SIDE_NEG, 0xffff);
const G_ENTERING = groups(ENTERING, 0x1);
const G_EXIT_TO_NEG = groups(EXITING, 0x1 | EXITING | SIDE_NEG);
const G_EXIT_TO_POS = groups(EXITING, 0x1 | EXITING | SIDE_POS);
const sideGroup = (side) => (side > 0 ? G_POS : G_NEG);

const PLUG_HALF = 0.04; // diaphragm half-thickness, cm
const STREAM_SPREAD = 7; // cm/s, sideways jitter of grains leaving the neck
const MAX_IN_NECK = 16; // grains crossing at once

// Freeze manager tuning.
const FREEZE_EVERY = 3; // steps between passes
const V_HOT = 2.5; // cm/s: a grain moving faster than this thaws its neighbourhood
const SETTLE_AFTER_TILT = 0.35; // s after a gravity change before freezing resumes

// Small deterministic PRNG so every load settles the same way.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class HourglassSim {
  /**
   * @param {object} R Initialised Rapier module.
   * @param {object} [opts]
   */
  constructor(R, opts = {}) {
    const {
      grainCount = 3000,
      fillFraction = 0.55, // share of one bulb the settled sand occupies
      packing = 0.6, // random loose packing of settled grains
      dt = 1 / 120,
      seed = 7,
      solverIterations = 4,
      contactFrequency = 240,
      friction = 0.4,
      angularDamping = 4, // rolling resistance stand-in
      pickRadius = 18, // grain radii: how far above the orifice the gate looks
      hotReach = 1, // grid cells a moving grain thaws around itself
      stillSpeed = 0.8, // cm/s: slower than this counts as resting
      stillTime = 0.4, // s at rest before a grain is frozen
    } = opts;
    this.stillSpeed = stillSpeed;
    this.stillTime = stillTime;
    this.R = R;
    this.N = grainCount;
    this.dt = dt;
    this.rand = mulberry32(seed);
    this.friction = friction;
    this.pickRadius = pickRadius;
    this.hotReach = hotReach;

    const vSand = fillFraction * bulbVolume() * packing;
    this.r = Math.cbrt(vSand / (grainCount * (4 / 3) * Math.PI));
    if (this.r > NECK_RADIUS * 0.8) throw new Error('Too few grains: they would not fit through the neck');

    this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = dt;
    this.world.numSolverIterations = solverIterations;
    // Rapier's default contact softness is tuned for metre-sized bodies; sand
    // grains need much stiffer contacts or a pile squashes under its own weight.
    this.world.integrationParameters.contact_natural_frequency = contactFrequency;

    this.gravityAngle = 0;
    this.up = 1; // +1: the draining bulb is y > 0; -1: the glass is flipped
    this.simTime = 0;
    this.lastGravityChange = -1;
    this.rotationLocked = false;

    // Metering gate.
    this.gateOpen = false;
    this.releaseTarget = 0;
    this.released = 0;
    this.maxReleasePerStep = 3;
    this.transit = [];
    this.starve = 0; // consecutive steps the gate found the orifice empty

    this.pos = new Float32Array(this.N * 3);
    this.vel = new Float32Array(this.N * 3);
    this.rot = new Float32Array(this.N * 4);
    this.side = new Int8Array(this.N); // bulb each grain belongs to: +1 (y > 0) or -1
    this.inTransit = new Uint8Array(this.N);
    this.transitStart = new Float32Array(this.N);
    this.frozen = new Uint8Array(this.N);
    this.frozenTotal = 0;
    this.still = new Float32Array(this.N);
    this.vacancies = []; // {x, y, z, until}: spots a metered grain just left
    this.freezeEnabled = true;
    this.stepCount = 0;
    this.escapes = 0;
    this.contained = 0;

    this.sdf = buildGlassSDF();
    this.#buildGlass();
    this.#buildGrains(angularDamping);
    this.#buildGrid();
  }

  // ---------------------------------------------------------------- building

  #buildGlass() {
    const R = this.R;
    // The same profile the containment field is built from, so the two agree.
    // Each pole is a single vertex with a triangle fan (collapsed rings would
    // leave degenerate triangles).
    const body = fullProfile().filter(([, r]) => r > 1e-4);
    const seg = 48;
    const verts = [];
    const idx = [];
    for (const [y, r] of body) {
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        verts.push(Math.cos(a) * r, y, Math.sin(a) * r);
      }
    }
    for (let i = 0; i < body.length - 1; i++) {
      for (let s = 0; s < seg; s++) {
        const a = i * seg + s, b = i * seg + ((s + 1) % seg);
        const c = (i + 1) * seg + s, d = (i + 1) * seg + ((s + 1) % seg);
        idx.push(a, c, b, b, c, d);
      }
    }
    const south = verts.length / 3;
    verts.push(0, -HALF_HEIGHT, 0);
    const north = south + 1;
    verts.push(0, HALF_HEIGHT, 0);
    const last = (body.length - 1) * seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      idx.push(south, s, s1);
      idx.push(north, last + s1, last + s);
    }
    const glass = R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idx))
      .setFriction(0.3)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(0.1)
      .setCollisionGroups(G_GLASS);
    this.world.createCollider(glass);

    // The diaphragm at the neck: closes the orifice except for metered grains.
    const plug = R.ColliderDesc.cylinder(PLUG_HALF, NECK_RADIUS + 0.15)
      .setFriction(0.6)
      .setRestitution(0.05)
      .setCollisionGroups(G_PLUG);
    this.world.createCollider(plug);
  }

  /** Body-centred lattice filling the top bulb from the neck upwards. */
  #latticeFill(n) {
    const r = this.r;
    const a = 2.36 * r; // cube side: nearest neighbours just clear of each other
    const out = [];
    let layer = 0;
    for (let y = PLUG_HALF + r + 0.03; y < HALF_HEIGHT - r && out.length < n; y += a / 2, layer++) {
      const limit = clearanceAt(y, r + 0.04) - r - 0.04;
      if (limit < 0) continue;
      const off = (layer % 2) * a * 0.5;
      const cells = Math.ceil(limit / a) + 1;
      for (let ix = -cells; ix <= cells; ix++) {
        for (let iz = -cells; iz <= cells; iz++) {
          const x = ix * a + off + (this.rand() - 0.5) * 0.06 * r;
          const z = iz * a + off + (this.rand() - 0.5) * 0.06 * r;
          if (Math.hypot(x, z) <= limit && out.length < n) out.push([x, y, z]);
        }
      }
    }
    if (out.length < n) throw new Error(`Bulb too small for ${n} grains (fit ${out.length})`);
    return out;
  }

  #buildGrains(angularDamping) {
    const R = this.R;
    const r = this.r;
    this.bodies = new Array(this.N);
    this.colliders = new Array(this.N);
    const pts = this.#latticeFill(this.N);
    for (let i = 0; i < this.N; i++) {
      const [x, y, z] = pts[i];
      // Random initial orientation so the rendered grain clusters vary.
      const q = this.#randomQuat();
      const bd = R.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(q)
        .setLinearDamping(0.02)
        .setAngularDamping(angularDamping)
        .setSoftCcdPrediction(r * 6);
      const body = this.world.createRigidBody(bd);
      const cd = R.ColliderDesc.ball(r)
        .setFriction(this.friction)
        .setRestitution(0.05)
        .setDensity(2.6)
        .setCollisionGroups(G_POS);
      this.colliders[i] = this.world.createCollider(cd, body);
      this.bodies[i] = body;
      this.side[i] = 1;
    }
    this.readState(true);
  }

  #randomQuat() {
    const u1 = this.rand(), u2 = this.rand() * Math.PI * 2, u3 = this.rand() * Math.PI * 2;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return { x: a * Math.sin(u2), y: a * Math.cos(u2), z: b * Math.sin(u3), w: b * Math.cos(u3) };
  }

  #buildGrid() {
    this.cell = 2.4 * this.r;
    this.gx = Math.ceil(8.4 / this.cell) + 1;
    this.gy = Math.ceil((2 * HALF_HEIGHT + 0.6) / this.cell) + 1;
    this.gz = this.gx;
    this.hot = new Uint8Array(this.gx * this.gy * this.gz);
    this.surface = new Float32Array(this.gx * this.gz);
  }

  // ------------------------------------------------------------ state access

  /** Copy body state into the typed arrays (frozen grains don't move, so they're skipped). */
  readState(all = false) {
    const p = this.pos, v = this.vel, q = this.rot;
    for (let i = 0; i < this.N; i++) {
      if (this.frozen[i] && !all) continue;
      const b = this.bodies[i];
      const t = b.translation();
      p[i * 3] = t.x; p[i * 3 + 1] = t.y; p[i * 3 + 2] = t.z;
      const l = b.linvel();
      v[i * 3] = l.x; v[i * 3 + 1] = l.y; v[i * 3 + 2] = l.z;
      const o = b.rotation();
      q[i * 4] = o.x; q[i * 4 + 1] = o.y; q[i * 4 + 2] = o.z; q[i * 4 + 3] = o.w;
    }
  }

  /** Rotate gravity in the glass frame. angle = rotation of the glass about the view axis. */
  setGravityAngle(angle) {
    if (angle === this.gravityAngle) return;
    this.gravityAngle = angle;
    const gx = -GRAVITY * Math.sin(angle);
    const gy = -GRAVITY * Math.cos(angle);
    this.world.gravity = { x: gx, y: gy, z: 0 };
    this.up = gy < 0 ? 1 : -1;
    this.lastGravityChange = this.simTime;
    this.thawAll();
  }

  /** Lock grain rotation (cheaper; used while the whole mass tumbles during a flip). */
  setRotationLocked(locked) {
    if (locked === this.rotationLocked) return;
    this.rotationLocked = locked;
    for (const b of this.bodies) b.lockRotations(locked, true);
  }

  /** True when the glass is standing (either way up) so the neck can flow. */
  get upright() {
    return Math.abs(Math.cos(this.gravityAngle)) > 0.999;
  }

  /** Grains in the upper (draining) bulb, not counting any crossing the neck. */
  countUpper() {
    let n = 0;
    for (let i = 0; i < this.N; i++) if (this.side[i] === this.up && !this.inTransit[i]) n++;
    return n;
  }

  frozenCount() {
    return this.frozenTotal;
  }

  /** Nothing is moving: every grain frozen and none crossing the neck. */
  get atRest() {
    return this.frozenTotal === this.N && this.transit.length === 0;
  }

  /** Mean grain speed (cm/s). */
  meanSpeed() {
    let s = 0;
    const v = this.vel;
    for (let i = 0; i < this.N; i++) s += Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    return s / this.N;
  }

  /** Height (glass frame) of the top of the lower pile on the axis: where the stream lands. */
  pileTopOnAxis() {
    const down = -this.up, p = this.pos, v = this.vel, r = this.r;
    let best = down * (HALF_HEIGHT - 0.12); // empty bulb: the glass end
    const reach = 1.6 * r;
    for (let i = 0; i < this.N; i++) {
      if (this.side[i] !== down || this.inTransit[i]) continue;
      if (Math.abs(p[i * 3]) > reach || Math.abs(p[i * 3 + 2]) > reach) continue;
      // Only grains at rest on the pile (one just out of the neck is slow too).
      if (Math.abs(v[i * 3]) + Math.abs(v[i * 3 + 1]) + Math.abs(v[i * 3 + 2]) > 8) continue;
      const top = p[i * 3 + 1] - down * r;
      if (top * down < best * down) best = top;
    }
    return best;
  }

  // ---------------------------------------------------------- freeze manager

  #cellIndex(x, y, z) {
    const c = this.cell;
    const ix = Math.min(this.gx - 1, Math.max(0, Math.floor((x + 4.2) / c)));
    const iy = Math.min(this.gy - 1, Math.max(0, Math.floor((y + HALF_HEIGHT + 0.3) / c)));
    const iz = Math.min(this.gz - 1, Math.max(0, Math.floor((z + 4.2) / c)));
    return [ix, iy, iz];
  }

  #markHot(x, y, z, reach) {
    const [cx, cy, cz] = this.#cellIndex(x, y, z);
    const { gx, gy, gz, hot } = this;
    for (let k = Math.max(0, cy - reach); k <= Math.min(gy - 1, cy + reach); k++) {
      for (let j = Math.max(0, cz - reach); j <= Math.min(gz - 1, cz + reach); j++) {
        const row = (k * gz + j) * gx;
        for (let i = Math.max(0, cx - reach); i <= Math.min(gx - 1, cx + reach); i++) hot[row + i] = 1;
      }
    }
  }

  // Sand can't hold a free surface steeper than its angle of repose. Build a
  // height map of one bulb's surface and thaw the top of any column standing
  // too far above a neighbour, so frozen grains can't prop up a slope that
  // real sand would avalanche down.
  #markSteepSlopes(side) {
    const { gx, gz, cell, surface: H, pos: p } = this;
    const lift = this.up; // gravity is -y when upright, +y when flipped
    H.fill(-Infinity);
    for (let i = 0; i < this.N; i++) {
      if (this.side[i] !== side || this.inTransit[i]) continue;
      const [cx, , cz] = this.#cellIndex(p[i * 3], 0, p[i * 3 + 2]);
      const h = p[i * 3 + 1] * lift;
      const k = cz * gx + cx;
      if (h > H[k]) H[k] = h;
    }
    const limit = 1.0 * cell; // tan(45 deg) per cell, above surface noise
    for (let cz = 1; cz < gz - 1; cz++) {
      for (let cx = 1; cx < gx - 1; cx++) {
        const h = H[cz * gx + cx];
        if (h === -Infinity) continue;
        const lowest = Math.min(
          H[cz * gx + cx - 1], H[cz * gx + cx + 1], H[(cz - 1) * gx + cx], H[(cz + 1) * gx + cx],
        );
        // Columns with no sand (outside the glass, or bare floor) give no slope.
        let drop = 0;
        for (const n of [cz * gx + cx - 1, cz * gx + cx + 1, (cz - 1) * gx + cx, (cz + 1) * gx + cx]) {
          if (H[n] !== -Infinity) drop = Math.max(drop, h - H[n]);
        }
        if (lowest === undefined || drop <= limit) continue;
        // A slope fails as a slab, not just its top layer.
        const x = -4.2 + (cx + 0.5) * cell, z = -4.2 + (cz + 0.5) * cell;
        for (let d = 0; d < 5; d++) this.#markHot(x, (h - d * cell) * lift, z, 0);
      }
    }
  }

  #isHot(x, y, z) {
    const [cx, cy, cz] = this.#cellIndex(x, y, z);
    return this.hot[(cy * this.gz + cz) * this.gx + cx] === 1;
  }

  #freeze(i) {
    if (this.frozen[i]) return;
    this.bodies[i].setBodyType(this.R.RigidBodyType.Fixed, false);
    this.frozen[i] = 1;
    this.frozenTotal++;
    this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
  }

  #thaw(i) {
    if (!this.frozen[i]) return;
    this.bodies[i].setBodyType(this.R.RigidBodyType.Dynamic, true);
    this.frozen[i] = 0;
    this.frozenTotal--;
    this.still[i] = 0;
  }

  thawAll() {
    for (let i = 0; i < this.N; i++) this.#thaw(i);
    for (const b of this.bodies) b.wakeUp();
  }

  #freezePass() {
    const dtPass = this.dt * FREEZE_EVERY;
    const p = this.pos, v = this.vel;
    const allowFreeze = this.freezeEnabled && this.simTime - this.lastGravityChange > SETTLE_AFTER_TILT;
    this.hot.fill(0);
    for (let i = 0; i < this.N; i++) {
      if (this.frozen[i] || this.inTransit[i]) continue;
      const s = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      if (s > V_HOT) this.#markHot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], this.hotReach);
    }
    const now = this.simTime;
    this.vacancies = this.vacancies.filter((h) => h.until > now);
    for (const h of this.vacancies) this.#markHot(h.x, h.y, h.z, 2);

    // Occasional audit: thaw a few random grains so a frozen grain can never
    // stay propped up by something that has since moved away.
    for (let k = 0; k < 3; k++) this.#thaw(Math.floor(this.rand() * this.N));
    // The draining bulb's crater is the slope that matters; the bottom pile is
    // kept moving by the grains landing on it.
    if (this.upright && this.gateOpen && (this.stepCount / FREEZE_EVERY) % 4 === 0) this.#markSteepSlopes(this.up);

    for (let i = 0; i < this.N; i++) {
      if (this.inTransit[i]) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (this.frozen[i]) {
        if (this.#isHot(x, y, z)) this.#thaw(i);
        continue;
      }
      const s = Math.hypot(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
      this.still[i] = s < this.stillSpeed ? this.still[i] + dtPass : 0;
      if (allowFreeze && this.still[i] > this.stillTime && !this.#isHot(x, y, z)) this.#freeze(i);
    }
  }

  // ------------------------------------------------------------ neck & gate

  #findOrificeGrain() {
    const up = this.up, p = this.pos, r = this.r;
    const gy = up * (PLUG_HALF + r);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.N; i++) {
      if (this.side[i] !== up || this.inTransit[i]) continue;
      const dx = p[i * 3], dy = p[i * 3 + 1] - gy, dz = p[i * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    // Only a grain that has reached the bottom of the funnel can go (allowing
    // for one that bridges a little above the orifice).
    if (best < 0 || bestD > (this.pickRadius * r) ** 2) return -1;
    return best;
  }

  // Nothing in reach of the orifice although sand remains above: a frozen
  // bridge is holding it up. Thaw the sand above the neck, widening each time.
  #starved() {
    this.starve++;
    if (this.starve % 4 !== 1) return;
    const reach = this.r * (8 + 2 * this.starve);
    const up = this.up, p = this.pos;
    for (let i = 0; i < this.N; i++) {
      if (!this.frozen[i] || this.side[i] !== up) continue;
      if (Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) < reach) this.#thaw(i);
    }
  }

  #startTransit(i) {
    this.#thaw(i);
    const body = this.bodies[i];
    const t = body.translation();
    this.vacancies.push({ x: t.x, y: t.y, z: t.z, until: this.simTime + 0.3 });
    this.colliders[i].setCollisionGroups(G_ENTERING);
    // Frictionless while crossing so it slides down the funnel to the orifice.
    this.colliders[i].setFriction(0);
    // Aim at the orifice; gravity does the rest.
    const down = -this.up;
    const tx = -t.x, ty = down * (PLUG_HALF + this.r) - t.y, tz = -t.z;
    const L = Math.hypot(tx, ty, tz) || 1;
    const sp = 25;
    body.setLinvel({ x: (tx / L) * sp, y: (ty / L) * sp, z: (tz / L) * sp }, true);
    this.inTransit[i] = 1; // 1: entering, 2: exiting
    this.transitStart[i] = this.simTime;
    this.transit.push(i);
  }

  #updateTransit() {
    if (!this.transit.length) return;
    const exitY = PLUG_HALF + this.r + 0.02;
    const dest = -this.up;
    const keep = [];
    for (const i of this.transit) {
      const body = this.bodies[i];
      const t = body.translation();
      const h = t.y * dest; // > 0: through the diaphragm
      // Mild overlaps are fine (Rapier separates them gently); a grain is only
      // held back while it sits nearly on top of another one.
      if (this.inTransit[i] === 1 && h > 0 && (this.#clearOf(i, t, dest, 1.2) || h > exitY)) {
        this.inTransit[i] = 2;
        this.colliders[i].setCollisionGroups(dest > 0 ? G_EXIT_TO_POS : G_EXIT_TO_NEG);
      }
      if (this.inTransit[i] === 2 && h > exitY) {
        this.#land(i, dest);
      } else if (this.simTime - this.transitStart[i] > 0.8 && this.#clearOf(-1, { x: 0, y: dest * (exitY + 0.01), z: 0 }, dest, 2.02)) {
        // Snagged (rare): finish the crossing.
        body.setTranslation({ x: 0, y: dest * (exitY + 0.01), z: 0 }, true);
        body.setLinvel({ x: 0, y: dest * 20, z: 0 }, true);
        this.#land(i, dest);
      } else {
        keep.push(i);
      }
    }
    this.transit = keep;
  }

  /** No solid grain of the destination bulb, and no exiting grain, is within gap*r of t. */
  #clearOf(self, t, dest, gap) {
    const p = this.pos, lim = (gap * this.r) ** 2;
    for (let j = 0; j < this.N; j++) {
      if (j === self) continue;
      const solid = this.inTransit[j] === 0 ? this.side[j] === dest : this.inTransit[j] === 2;
      if (!solid) continue;
      const dy = p[j * 3 + 1] - t.y;
      if (dy * dy > lim) continue;
      const dx = p[j * 3] - t.x, dz = p[j * 3 + 2] - t.z;
      if (dx * dx + dy * dy + dz * dz < lim) return false;
    }
    return true;
  }

  #land(i, dest) {
    this.colliders[i].setCollisionGroups(sideGroup(dest));
    this.colliders[i].setFriction(this.friction);
    this.side[i] = dest;
    this.inTransit[i] = 0;
    // A real stream frays as grains jostle through the orifice; without this
    // every grain would land dead centre on the one before and stack a spike.
    const b = this.bodies[i];
    const v = b.linvel();
    const a = this.rand() * Math.PI * 2, s = STREAM_SPREAD * Math.sqrt(this.rand());
    b.setLinvel({ x: v.x * 0.2 + Math.cos(a) * s, y: v.y, z: v.z * 0.2 + Math.sin(a) * s }, true);
  }

  // ------------------------------------------------------------ containment

  // The glass mesh is a thin shell, and at the bottom of a deep pile the
  // contact solver can let a grain sink far enough into it to slip through.
  // Push any grain deeper than the solver normally allows back out along the
  // glass normal and drop its velocity into the wall.
  #contain() {
    const p = this.pos, v = this.vel, r = this.r, sdf = this.sdf;
    const target = 0.75 * r;
    for (let i = 0; i < this.N; i++) {
      if (this.frozen[i]) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const rho = Math.hypot(x, z);
      const d = sdf.distance(rho, y);
      if (d >= target) continue;
      const [nr, ny] = sdf.normal(rho, y);
      const ux = rho > 1e-6 ? x / rho : 0, uz = rho > 1e-6 ? z / rho : 0;
      const nx = nr * ux, nz = nr * uz;
      const push = target - d;
      const body = this.bodies[i];
      const px = x + nx * push, py = y + ny * push, pz = z + nz * push;
      body.setTranslation({ x: px, y: py, z: pz }, true);
      const vn = v[i * 3] * nx + v[i * 3 + 1] * ny + v[i * 3 + 2] * nz;
      if (vn < 0) {
        body.setLinvel({ x: v[i * 3] - vn * nx, y: v[i * 3 + 1] - vn * ny, z: v[i * 3 + 2] - vn * nz }, true);
      }
      p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz;
      this.contained++;
    }
  }

  /** Last-resort net: anything that still got out goes back into its own bulb. */
  containEscapes() {
    const p = this.pos, r = this.r;
    for (let i = 0; i < this.N; i++) {
      if (this.frozen[i] || this.inTransit[i]) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const ay = Math.abs(y);
      const rad = Math.hypot(x, z);
      if (ay < HALF_HEIGHT - 0.02 && rad < radiusAt(y) + 0.3 * r && y * this.side[i] > -0.05) continue;
      const ny = this.side[i] * Math.min(Math.max(ay, 1.5), HALF_HEIGHT - 1.5 * r);
      const nl = Math.max(0, radiusAt(ny) - 1.5 * r);
      const k = rad > nl ? nl / rad : 1;
      this.bodies[i].setTranslation({ x: x * k, y: ny, z: z * k }, true);
      this.bodies[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.escapes++;
    }
  }

  // ------------------------------------------------------------------ step

  /** Advance one fixed step. */
  step() {
    if (this.gateOpen && this.upright) {
      let budget = this.maxReleasePerStep;
      while (this.released < this.releaseTarget && budget-- > 0 && this.transit.length < MAX_IN_NECK) {
        const i = this.#findOrificeGrain();
        if (i < 0) {
          this.#starved();
          break;
        }
        this.starve = 0;
        this.#startTransit(i);
        this.released++;
      }
    }
    this.world.step();
    this.simTime += this.dt;
    this.stepCount++;
    this.#updateTransit();
    this.readState();
    this.#contain();
    if (this.stepCount % FREEZE_EVERY === 0) this.#freezePass();
    if (this.stepCount % 60 === 0) this.containEscapes();
  }

  /** Step until the sand is at rest (or maxSteps). Returns steps taken. */
  settle(maxSteps = 600, minSteps = 90) {
    let n = 0;
    while (n < maxSteps) {
      this.step();
      n++;
      if (n >= minSteps && this.meanSpeed() < 0.2) break;
    }
    return n;
  }

  // ------------------------------------------------------------- snapshots

  snapshot() {
    return { pos: Float32Array.from(this.pos), rot: Float32Array.from(this.rot) };
  }

  /** Restore a settled state. mirror = true reflects it into the other bulb. */
  restore(snap, mirror) {
    const s = mirror ? -1 : 1;
    for (const i of this.transit) this.inTransit[i] = 0;
    this.transit = [];
    this.vacancies = [];
    for (let i = 0; i < this.N; i++) {
      const b = this.bodies[i];
      const side = s * snap.pos[i * 3 + 1] > 0 ? 1 : -1;
      this.side[i] = side;
      this.colliders[i].setCollisionGroups(sideGroup(side));
      this.colliders[i].setFriction(this.friction);
      if (this.frozen[i]) {
        b.setBodyType(this.R.RigidBodyType.Dynamic, false);
        this.frozen[i] = 0;
        this.frozenTotal--;
      }
      b.setTranslation({ x: snap.pos[i * 3], y: s * snap.pos[i * 3 + 1], z: snap.pos[i * 3 + 2] }, false);
      b.setRotation({ x: snap.rot[i * 4], y: snap.rot[i * 4 + 1], z: snap.rot[i * 4 + 2], w: snap.rot[i * 4 + 3] }, false);
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      this.#freeze(i);
    }
    this.released = 0;
    this.releaseTarget = 0;
    this.gateOpen = false;
    this.starve = 0;
    this.readState(true);
  }

  get plugHalf() { return PLUG_HALF; }
}
