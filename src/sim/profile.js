// Inner surface of the hourglass glass, as a surface of revolution.
// All physics and geometry work in centimetres. y = 0 is the neck; the
// two bulbs are mirror images (top bulb y > 0, bottom bulb y < 0).

export const HALF_HEIGHT = 9.0; // neck to the inside of each end, cm
export const NECK_RADIUS = 0.3; // inner radius at the narrowest point, cm
export const GLASS_THICKNESS = 0.16;

// Control points [y, r] for one bulb, neck first. The funnel above the neck
// is kept steeper than the angle of repose (~32 deg) so every grain drains,
// like a real calibrated glass.
const CONTROL = [
  [0.0, NECK_RADIUS],
  [0.32, 0.34],
  [0.9, 0.78],
  [1.8, 1.72],
  [2.9, 2.7],
  [4.1, 3.36],
  [5.3, 3.7],
  [6.3, 3.74],
  [7.2, 3.5],
  [7.9, 3.0],
  [8.45, 2.22],
  [8.8, 1.38],
  [8.97, 0.58],
  [HALF_HEIGHT, 0.0],
];

// Centripetal Catmull-Rom through the control points, sampled densely.
function catmullRom(points, samplesPerSpan) {
  const out = [];
  const n = points.length;
  const get = (i) => points[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let s = 0; s < samplesPerSpan; s++) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSpan;
      const lerp = (a, b, ta, tb) => [
        ((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
        ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
      ];
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  out.push(points[n - 1]);
  return out;
}

// One bulb, neck -> end, as [y, r] pairs with y monotonically increasing.
export const BULB = (() => {
  const pts = catmullRom(CONTROL, 10);
  // Enforce monotonic y (Catmull-Rom can wobble near the dome) and r >= 0.
  const clean = [];
  for (const [y, r] of pts) {
    if (clean.length && y <= clean[clean.length - 1][0] + 1e-5) continue;
    clean.push([y, Math.max(0, r)]);
  }
  clean[clean.length - 1] = [HALF_HEIGHT, 0];
  return clean;
})();

// Lookup table for r(|y|).
const LUT_N = 2048;
const LUT = new Float32Array(LUT_N + 1);
(() => {
  let j = 0;
  for (let i = 0; i <= LUT_N; i++) {
    const y = (i / LUT_N) * HALF_HEIGHT;
    while (j < BULB.length - 2 && BULB[j + 1][0] < y) j++;
    const [y0, r0] = BULB[j], [y1, r1] = BULB[j + 1];
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    LUT[i] = r0 + (r1 - r0) * t;
  }
})();

/** Inner radius of the glass at height y (either bulb). */
export function radiusAt(y) {
  const a = Math.abs(y);
  if (a >= HALF_HEIGHT) return 0;
  const f = (a / HALF_HEIGHT) * LUT_N;
  const i = Math.floor(f);
  return LUT[i] + (LUT[i + 1] - LUT[i]) * (f - i);
}

/** Smallest inner radius over [y - h, y + h]: a sphere of radius h centred at y must fit inside this. */
export function clearanceAt(y, h) {
  let m = Infinity;
  for (let k = -4; k <= 4; k++) {
    const yy = y + (h * k) / 4;
    const cap = Math.sqrt(Math.max(0, h * h - (yy - y) * (yy - y)));
    m = Math.min(m, radiusAt(yy) - (h - cap));
  }
  return m;
}

/** Volume of one bulb (cm^3), from the neck to the end. */
export function bulbVolume() {
  let v = 0;
  const steps = 4000;
  for (let i = 0; i < steps; i++) {
    const y = ((i + 0.5) / steps) * HALF_HEIGHT;
    const r = radiusAt(y);
    v += Math.PI * r * r * (HALF_HEIGHT / steps);
  }
  return v;
}

/**
 * Full inner profile from the bottom end to the top end, as [y, r] pairs,
 * suitable for a lathe (r >= 0, y increasing).
 */
export function fullProfile() {
  const lower = BULB.slice(1).map(([y, r]) => [-y, r]).reverse();
  return [...lower, ...BULB];
}

/**
 * Signed distance to the inner glass surface in the (rho, y) half-plane,
 * positive inside the cavity. Precomputed on a grid and sampled bilinearly;
 * used as a containment safety net on top of the physics engine's contacts.
 */
export function buildGlassSDF(step = 0.02) {
  const prof = fullProfile(); // [y, r], y ascending
  const RHO_MAX = 4.4, Y_MAX = HALF_HEIGHT + 0.4;
  const nx = Math.ceil(RHO_MAX / step) + 1;
  const ny = Math.ceil((2 * Y_MAX) / step) + 1;
  const field = new Float32Array(nx * ny);
  const BAND = 0.8;
  for (let j = 0; j < ny; j++) {
    const y = -Y_MAX + j * step;
    // Segments whose y-range comes within BAND of this row.
    let lo = 0;
    while (lo < prof.length - 2 && prof[lo + 1][0] < y - BAND) lo++;
    let hi = lo;
    while (hi < prof.length - 2 && prof[hi][0] < y + BAND) hi++;
    for (let i = 0; i < nx; i++) {
      const rho = i * step;
      let best = BAND;
      for (let k = lo; k <= hi; k++) {
        const [y0, r0] = prof[k], [y1, r1] = prof[k + 1];
        const ex = r1 - r0, ey = y1 - y0;
        const L2 = ex * ex + ey * ey || 1e-9;
        const t = Math.max(0, Math.min(1, ((rho - r0) * ex + (y - y0) * ey) / L2));
        const d = Math.hypot(rho - (r0 + t * ex), y - (y0 + t * ey));
        if (d < best) best = d;
      }
      const inside = Math.abs(y) < HALF_HEIGHT && rho < radiusAt(y);
      field[j * nx + i] = inside ? best : -best;
    }
  }
  const at = (i, j) => field[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const sample = (rho, y) => {
    const fx = rho / step, fy = (y + Y_MAX) / step;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
  };
  return {
    /** Signed distance (cm), positive inside. */
    distance: sample,
    /** Inward unit normal [nRho, nY] at (rho, y). */
    normal(rho, y) {
      const h = step;
      const gx = sample(rho + h, y) - sample(Math.max(0, rho - h), y);
      const gy = sample(rho, y + h) - sample(rho, y - h);
      const L = Math.hypot(gx, gy) || 1;
      return [gx / L, gy / L];
    },
  };
}
