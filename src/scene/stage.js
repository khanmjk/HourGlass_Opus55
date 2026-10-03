// Renderer, camera, lighting and the table the hourglass stands on.
// World units are centimetres; the table top is y = 0.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { woodTexture } from './textures.js';

/**
 * A small photo studio for reflections: dark warm walls, a tall key softbox,
 * a dimmer fill, a top panel and two rim strips behind. Tall soft highlights
 * are what make curved glass read as glass.
 */
function studioEnvironment() {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(20, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {},
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `varying vec3 vP;
        void main(){
          float h = normalize(vP).y;
          vec3 floorC = vec3(0.06, 0.04, 0.03), wallC = vec3(0.10, 0.08, 0.07), ceilC = vec3(0.16, 0.14, 0.13);
          vec3 c = h < 0. ? mix(wallC, floorC, smoothstep(0., -0.4, h)) : mix(wallC, ceilC, smoothstep(0., 0.8, h));
          gl_FragColor = vec4(c, 1.);
        }`,
    }),
  );
  env.add(room);
  const panel = (w, h, color, intensity, pos, look) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    m.lookAt(...look);
    env.add(m);
  };
  panel(3.2, 10, '#fff1df', 5.0, [9, 2, 8], [0, 0, 0]); // key softbox, front right
  panel(2.4, 8, '#e9eef8', 1.6, [-10, 1, 6], [0, 0, 0]); // fill, front left
  panel(8, 8, '#fff8ee', 1.1, [0, 14, 0], [0, 0, 0]); // overhead
  panel(0.8, 11, '#cfdcff', 3.0, [-6, 2, -11], [0, 0, 0]); // rim strips
  panel(0.8, 11, '#ffe6c8', 2.4, [7, 2, -10], [0, 0, 0]);
  return env;
}

export function createStage(container, { focusY }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#120e0b');
  scene.fog = new THREE.Fog('#120e0b', 90, 220);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studioEnvironment(), 0.02).texture;
  scene.environmentIntensity = 0.9;

  const camera = new THREE.PerspectiveCamera(30, container.clientWidth / container.clientHeight, 1, 600);
  const home = { position: new THREE.Vector3(0, focusY + 6, 54), target: new THREE.Vector3(0, focusY, 0) };
  camera.position.copy(home.position);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(home.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 18;
  controls.maxDistance = 110;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.update();

  // Lights: a warm key with soft shadows, a cool rim from behind, gentle fill.
  const key = new THREE.DirectionalLight('#ffe4c4', 2.6);
  key.position.set(22, 40, 26);
  key.target.position.set(0, focusY * 0.6, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -18;
  key.shadow.camera.right = 18;
  key.shadow.camera.top = 22;
  key.shadow.camera.bottom = -14;
  key.shadow.camera.near = 10;
  key.shadow.camera.far = 110;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  scene.add(key, key.target);

  const rim = new THREE.DirectionalLight('#9fb8ff', 1.1);
  rim.position.set(-26, 22, -30);
  scene.add(rim);

  const fill = new THREE.HemisphereLight('#fff1dd', '#2b1c12', 0.35);
  scene.add(fill);

  // Table: a dark oiled-wood top that fades into the background.
  const tableTex = woodTexture({ dark: [40, 24, 15], light: [86, 54, 32], rings: 40, seed: 11, repeat: [5, 2], planks: 6, size: 1024 });
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.58, metalness: 0, envMapIntensity: 0.5 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.rotation.z = Math.PI / 2; // grain runs left to right
  table.receiveShadow = true;
  scene.add(table);

  // Screen space taken by the UI (px): the glass is framed in what's left.
  let insets = { left: 0, bottom: 0 };
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    const fw = Math.max(0.3, (w - insets.left) / w), fh = Math.max(0.3, (h - insets.bottom) / h);
    const D = home.position.distanceTo(home.target);
    const OBJ_H = 26, OBJ_W = 24; // cm, with room to turn over
    const fovH = 2 * Math.atan(OBJ_H / (2 * D * fh));
    const fovW = 2 * Math.atan(OBJ_W / (2 * D * camera.aspect * fw));
    camera.fov = Math.max(30, THREE.MathUtils.radToDeg(Math.max(fovH, fovW)));
    if (insets.left || insets.bottom) camera.setViewOffset(w, h, -insets.left / 2, insets.bottom / 2, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();
  const setInsets = (next) => {
    insets = next;
    resize();
  };

  const resetView = () => {
    camera.position.copy(home.position);
    controls.target.copy(home.target);
    controls.update();
  };

  return { renderer, scene, camera, controls, resetView, setInsets, keyLight: key };
}
