// The physical hourglass: blown-glass bulbs, turned walnut end caps and
// spindles, brass collars. Built in the glass frame shared with the physics
// (centimetres, neck at the origin, axis along +y).

import * as THREE from 'three';
import { fullProfile, HALF_HEIGHT } from '../sim/profile.js';
import { woodTexture } from './textures.js';

export const CAP_FACE = HALF_HEIGHT + 0.05; // where the glass ends meet the caps
export const CAP_THICKNESS = 1.3;
export const CAP_RADIUS = 5.0;
export const HALF_EXTENT = CAP_FACE + CAP_THICKNESS; // centre to the outside of a cap
const PILLAR_RING = 4.45;

/** Glass wall thickness: thicker where the two bulbs are fused at the neck. */
const wall = (y) => 0.14 + 0.2 * Math.exp(-((y / 0.7) ** 2));

function outerProfile() {
  const inner = fullProfile(); // [y, r] bottom to top
  const pts = [];
  for (let i = 0; i < inner.length; i++) {
    const [y0, r0] = inner[Math.max(0, i - 1)];
    const [y1, r1] = inner[Math.min(inner.length - 1, i + 1)];
    let tr = r1 - r0, ty = y1 - y0;
    const L = Math.hypot(tr, ty) || 1;
    tr /= L; ty /= L;
    const nr = ty, ny = -tr; // outward normal
    const [y, r] = inner[i];
    const t = wall(y);
    pts.push(new THREE.Vector2(Math.max(0, r + nr * t), y + ny * t));
  }
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  return pts;
}

function radiusOnProfile(pts, y) {
  // Outer radius at height y on the upper half.
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    if (a.y <= y && b.y >= y && a.y >= 0) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1);
  }
  return 0;
}

function capProfile() {
  // Rounded disc with a turned groove, from the glass face (y = 0) outwards.
  const R = CAP_RADIUS, H = CAP_THICKNESS, b = 0.32;
  const pts = [new THREE.Vector2(0, 0)];
  const arc = (cx, cy, r, a0, a1, n = 8) => {
    for (let k = 0; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };
  pts.push(new THREE.Vector2(R - 0.9, 0));
  pts.push(new THREE.Vector2(R - 0.75, 0.04)); // small step where the spindles sit
  arc(R - b, b, b, -Math.PI / 2, 0);
  pts.push(new THREE.Vector2(R, 0.52));
  arc(R, 0.65, 0.09, -Math.PI / 2, -Math.PI * 1.5, 6); // groove
  pts.push(new THREE.Vector2(R, 0.8));
  arc(R - b, H - b, b, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(R - 0.6, H + 0.02));
  pts.push(new THREE.Vector2(0, H + 0.02));
  return pts;
}

function spindleProfile() {
  const L = CAP_FACE;
  const pts = [];
  const n = 160;
  for (let i = 0; i <= n; i++) {
    const y = -L + (2 * L * i) / n;
    const a = Math.abs(y);
    let r = 0.25 + 0.11 * Math.exp(-((y / 1.1) ** 2)); // central swell
    r += 0.13 * Math.exp(-(((a - (L - 0.75)) / 0.16) ** 2)); // bead near each end
    r += 0.06 * Math.exp(-(((a - 2.2) / 0.12) ** 2)); // ring either side of the swell
    if (a > L - 0.42) r = 0.46; // square-shouldered foot
    pts.push(new THREE.Vector2(r, y));
  }
  return pts;
}

export function createHourglass() {
  const group = new THREE.Group();
  group.name = 'hourglass';

  // Glass: one lathe for the outer surface; refraction thickness approximates the wall.
  const outer = outerProfile();
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    metalness: 0,
    roughness: 0.03,
    transmission: 1,
    thickness: 0.35,
    ior: 1.5,
    attenuationColor: new THREE.Color('#eef3ee'),
    attenuationDistance: 12,
    specularIntensity: 1,
    envMapIntensity: 1.3,
    // The fine sand stream is drawn after the glass (a 1-px thread would be
    // blurred away by the refraction pass), so the glass must not hide it.
    depthWrite: false,
  });
  const glass = new THREE.Mesh(new THREE.LatheGeometry(outer, 128), glassMat);
  glass.name = 'glass';
  glass.renderOrder = 2;
  group.add(glass);

  // Faint inner surface: a second set of reflections makes the wall read as thick.
  const innerPts = fullProfile().map(([y, r]) => new THREE.Vector2(r, y));
  const innerMat = new THREE.MeshPhysicalMaterial({
    color: '#ffffff',
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.08,
    side: THREE.BackSide,
    depthWrite: false,
    envMapIntensity: 1.2,
  });
  const inner = new THREE.Mesh(new THREE.LatheGeometry(innerPts, 96), innerMat);
  inner.renderOrder = 1;
  group.add(inner);

  // Walnut caps and spindles.
  const capTex = woodTexture({ dark: [58, 32, 18], light: [128, 80, 46], rings: 18, seed: 5, repeat: [3, 1] });
  const spindleTex = woodTexture({ dark: [58, 32, 18], light: [128, 80, 46], rings: 9, seed: 9, repeat: [1, 2] });
  const wood = new THREE.MeshStandardMaterial({ map: capTex, roughness: 0.48, metalness: 0, envMapIntensity: 0.8 });
  const spindleWood = new THREE.MeshStandardMaterial({ map: spindleTex, roughness: 0.45, metalness: 0, envMapIntensity: 0.8 });
  const brass = new THREE.MeshStandardMaterial({ color: '#c9a35b', metalness: 1, roughness: 0.28 });

  const capGeom = new THREE.LatheGeometry(capProfile(), 96);
  for (const s of [1, -1]) {
    const cap = new THREE.Mesh(capGeom, wood);
    cap.position.y = s * CAP_FACE;
    if (s < 0) cap.rotation.x = Math.PI;
    cap.castShadow = cap.receiveShadow = true;
    group.add(cap);

    // Brass collar where the glass end seats into the cap.
    const rc = radiusOnProfile(outer, CAP_FACE - 0.12) + 0.06;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(Math.max(0.5, rc), 0.09, 12, 64), brass);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = s * (CAP_FACE - 0.07);
    group.add(collar);
  }

  const spindleGeom = new THREE.LatheGeometry(spindleProfile(), 32);
  // Four spindles on the diagonals: nothing stands directly in front of or
  // behind the neck, so the stream is always in clear view.
  for (const deg of [45, 135, 225, 315]) {
    const a = THREE.MathUtils.degToRad(deg);
    const sp = new THREE.Mesh(spindleGeom, spindleWood);
    sp.position.set(Math.cos(a) * PILLAR_RING, 0, Math.sin(a) * PILLAR_RING);
    sp.castShadow = sp.receiveShadow = true;
    group.add(sp);
  }

  return { group, glass };
}
