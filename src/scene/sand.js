// Sand rendering.
//
// Grains: each physics body is drawn as a small cluster of six faceted
// sub-grains that turns with the body, so 3,000 simulated grains read as
// ~18,000 visible ones. Fine stream: a continuous thread of fine sand falling
// from the orifice to the top of the pile. Grains in a dilute falling stream
// don't touch each other, so plain ballistic motion is their exact physics; it
// lets the stream look continuous even for long timers, where a real glass
// moves millions of grains and the simulated grains pass only about one a second.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRAVITY } from '../sim/HourglassSim.js';

const PALETTE = ['#e2c99d', '#d8bd8d', '#ecd9b4', '#cfb07e', '#f1e3c6', '#c4a271', '#dcc193', '#a98c62', '#bd9a6c'];
const WEIGHTS = [16, 14, 10, 10, 6, 6, 12, 3, 3];

function pickColor(rand) {
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let x = rand() * total;
  for (let i = 0; i < PALETTE.length; i++) {
    x -= WEIGHTS[i];
    if (x <= 0) return PALETTE[i];
  }
  return PALETTE[0];
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Rough, faceted sub-grains of mixed sizes clustered to fill a sphere of radius r. */
function clusterGeometry(r, rand) {
  // Spread directions evenly (Fibonacci sphere), then jitter them.
  const K = 6;
  const dirs = [];
  for (let k = 0; k < K; k++) {
    const y = 1 - (2 * (k + 0.5)) / K, rr = Math.sqrt(1 - y * y), a = k * 2.39996 + rand();
    dirs.push(new THREE.Vector3(Math.cos(a) * rr + (rand() - 0.5) * 0.3, y, Math.sin(a) * rr + (rand() - 0.5) * 0.3).normalize());
  }
  const parts = dirs.map((d) => {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const pos = g.attributes.position;
    // Roughen: jitter each corner (shared corners move together).
    const seen = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      if (!seen.has(key)) seen.set(key, 0.82 + rand() * 0.3);
      const k = seen.get(key);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
    }
    const size = 0.34 + rand() * 0.2;
    g.scale(size * (0.9 + rand() * 0.25) * r, size * (0.8 + rand() * 0.25) * r, size * (0.9 + rand() * 0.2) * r);
    g.rotateX(rand() * 6.28).rotateY(rand() * 6.28);
    const dist = (0.92 - size) * r;
    g.translate(d.x * dist, d.y * dist, d.z * dist);
    const shade = 0.78 + rand() * 0.32;
    const colors = new Float32Array(pos.count * 3).fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  });
  return mergeGeometries(parts);
}

export class SandGrains {
  constructor(count, radius) {
    const rand = rng(12345);
    this.count = count;
    const geom = clusterGeometry(radius, rand);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, envMapIntensity: 0.6 });
    this.mesh = new THREE.InstancedMesh(geom, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.scale = new Float32Array(count);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      this.scale[i] = 0.93 + rand() * 0.14;
      this.mesh.setColorAt(i, c.set(pickColor(rand)));
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  /** Write instance transforms from physics positions and quaternions. */
  update(pos, rot) {
    const te = this.mesh.instanceMatrix.array;
    const sc = this.scale;
    for (let i = 0; i < this.count; i++) {
      const x = rot[i * 4], y = rot[i * 4 + 1], z = rot[i * 4 + 2], w = rot[i * 4 + 3];
      const s = sc[i];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      const o = i * 16;
      te[o] = (1 - (yy + zz)) * s; te[o + 1] = (xy + wz) * s; te[o + 2] = (xz - wy) * s; te[o + 3] = 0;
      te[o + 4] = (xy - wz) * s; te[o + 5] = (1 - (xx + zz)) * s; te[o + 6] = (yz + wx) * s; te[o + 7] = 0;
      te[o + 8] = (xz + wy) * s; te[o + 9] = (yz - wx) * s; te[o + 10] = (1 - (xx + yy)) * s; te[o + 11] = 0;
      te[o + 12] = pos[i * 3]; te[o + 13] = pos[i * 3 + 1]; te[o + 14] = pos[i * 3 + 2]; te[o + 15] = 1;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

export class FineStream {
  constructor({ exitY, max = 1600 }) {
    this.exitY = exitY;
    this.max = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.s = new Float32Array(max);
    this.n = 0;
    this.carry = 0;
    const rand = rng(777);
    this.rand = rand;
    const geom = new THREE.IcosahedronGeometry(1, 0);
    // Drawn after the glass (see hourglass.js) so the thin thread stays crisp.
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.6, transparent: true });
    this.mesh = new THREE.InstancedMesh(geom, mat, max);
    this.mesh.renderOrder = 3;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    const c = new THREE.Color();
    for (let i = 0; i < max; i++) this.mesh.setColorAt(i, c.set(pickColor(rand)));
    this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * @param {number} dt seconds
   * @param {object} st flowing, rate (grains/s scheduled), up (+1/-1), pileTop (glass-frame y)
   */
  update(dt, st) {
    const down = -st.up;
    const g = GRAVITY * down;
    const p = this.p, v = this.v;
    // Emit: denser for faster timers, never thinner than a fine thread.
    if (st.flowing) {
      const rate = 260 + 60 * Math.pow(Math.max(0, st.rate), 0.6);
      this.carry += rate * dt;
      while (this.carry >= 1 && this.n < this.max) {
        this.carry -= 1;
        const i = this.n++;
        const a = this.rand() * 6.283, rr = 0.07 * Math.sqrt(this.rand());
        const lag = this.rand() * dt; // spread births across the frame
        p[i * 3] = Math.cos(a) * rr;
        p[i * 3 + 1] = down * this.exitY;
        p[i * 3 + 2] = Math.sin(a) * rr;
        v[i * 3] = (this.rand() - 0.5) * 3;
        v[i * 3 + 1] = down * (20 + this.rand() * 6) + g * lag;
        v[i * 3 + 2] = (this.rand() - 0.5) * 3;
        this.s[i] = 0.03 + this.rand() * 0.028;
      }
    } else {
      this.carry = 0;
    }
    // Fall, and vanish into the pile on landing.
    const floor = st.pileTop * down;
    for (let i = 0; i < this.n; ) {
      v[i * 3 + 1] += g * dt;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (p[i * 3 + 1] * down >= floor || Math.abs(p[i * 3 + 1]) > 9.2) {
        const j = --this.n;
        p[i * 3] = p[j * 3]; p[i * 3 + 1] = p[j * 3 + 1]; p[i * 3 + 2] = p[j * 3 + 2];
        v[i * 3] = v[j * 3]; v[i * 3 + 1] = v[j * 3 + 1]; v[i * 3 + 2] = v[j * 3 + 2];
        this.s[i] = this.s[j];
      } else {
        i++;
      }
    }
    const te = this.mesh.instanceMatrix.array;
    for (let i = 0; i < this.n; i++) {
      // Stretch along the fall with speed: the streak your eye sees.
      const o = i * 16, s = this.s[i], sy = s * (1.2 + Math.abs(v[i * 3 + 1]) * 0.018);
      te[o] = s; te[o + 1] = 0; te[o + 2] = 0; te[o + 3] = 0;
      te[o + 4] = 0; te[o + 5] = sy; te[o + 6] = 0; te[o + 7] = 0;
      te[o + 8] = 0; te[o + 9] = 0; te[o + 10] = s; te[o + 11] = 0;
      te[o + 12] = p[i * 3]; te[o + 13] = p[i * 3 + 1]; te[o + 14] = p[i * 3 + 2]; te[o + 15] = 1;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }
}
