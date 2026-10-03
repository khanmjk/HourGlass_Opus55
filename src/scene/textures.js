// Procedural textures (no image assets needed).

import * as THREE from 'three';

// Smooth value noise.
function makeNoise(seed = 1) {
  const p = new Uint8Array(512);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const perm = Array.from({ length: 256 }, (_, i) => i).sort(() => rnd() - 0.5);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const val = new Float32Array(256).map(() => rnd());
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = val[p[(p[xi & 255] + yi) & 511] & 255];
    const b = val[p[(p[(xi + 1) & 255] + yi) & 511] & 255];
    const c = val[p[(p[xi & 255] + yi + 1) & 511] & 255];
    const d = val[p[(p[(xi + 1) & 255] + yi + 1) & 511] & 255];
    const u = fade(xf), v = fade(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/**
 * Wood grain running along the texture's v axis.
 * @param {object} o
 * @param {number[]} o.dark  RGB 0-255 of the late wood
 * @param {number[]} o.light RGB 0-255 of the early wood
 */
export function woodTexture({ dark, light, size = 512, rings = 26, seed = 3, repeat = [1, 1], planks = 0 }) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const n = makeNoise(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Boards: each plank gets its own offset and tone; seams between them.
      let tone = 1, seam = 1, off = 0;
      if (planks) {
        const k = Math.floor(u * planks), f = u * planks - k;
        off = k * 7.31 + Math.floor(v * 2 + k * 0.37) * 3.1;
        tone = 0.86 + 0.28 * n(k * 3.7, 1.3);
        seam = f < 0.006 || f > 0.994 ? 0.45 : 1;
      }
      const warp = n(u * 4 + off, v * 1.2) * 1.6 + n(u * 13, v * 3 + off) * 0.35;
      const g = Math.sin((u * rings + warp * 3) * Math.PI);
      let t = Math.pow(Math.abs(g), 0.55);
      t = t * 0.8 + n(u * 90, v * 6) * 0.2; // fine fibre
      const pore = n(u * 260, v * 20) > 0.82 ? 0.75 : 1;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.min(255, (dark[c] + (light[c] - dark[c]) * t) * pore * tone * seam);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 8;
  return tex;
}

/** Soft radial gradient used behind the scene. */
export function backdropTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(256, 200, 20, 256, 256, 360);
  g.addColorStop(0, '#3a2c22');
  g.addColorStop(0.5, '#1d1612');
  g.addColorStop(1, '#0b0908');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
