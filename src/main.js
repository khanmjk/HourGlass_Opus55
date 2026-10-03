// Main thread: 3D view, controls and UI. The physics and the clock live in
// the worker (physics.worker.js); this file draws whatever state it reports.

import * as THREE from 'three';
import { createStage } from './scene/stage.js';
import { createHourglass, HALF_EXTENT, CAP_RADIUS } from './scene/hourglass.js';
import { SandGrains, FineStream } from './scene/sand.js';
import { Sound } from './audio.js';

const $ = (id) => document.getElementById(id);
const now = () => performance.timeOrigin + performance.now();
const fmtInt = new Intl.NumberFormat();

// ------------------------------------------------------------------ scene

const stage = createStage($('viewport'), { focusY: HALF_EXTENT });
const rig = new THREE.Group(); // the whole hourglass; turns over when flipped
stage.scene.add(rig);
rig.add(createHourglass().group);
if (import.meta.env.DEV) window.__hourglass = { stage, rig, THREE };

// Frame the glass beside the panel on wide screens, above it on phones.
const panel = $('panel');
const fitToPanel = () => {
  const r = panel.getBoundingClientRect();
  const phone = window.innerWidth <= 720;
  stage.setInsets(phone ? { left: 0, bottom: window.innerHeight - r.top } : { left: r.right, bottom: 0 });
};
new ResizeObserver(fitToPanel).observe(panel);
window.addEventListener('resize', fitToPanel);

function placeRig(angle) {
  // Keep the lowest point of the caps on the table while it turns, plus a
  // small lift, as if picked up and turned over by hand.
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  rig.rotation.z = angle;
  rig.position.y = Math.max(HALF_EXTENT, HALF_EXTENT * c + CAP_RADIUS * s) + 2.4 * s;
}
placeRig(0);

let sand = null;
let stream = null;
let info = null; // from the worker's 'ready'
let latest = null; // newest grain frame not yet drawn
let view = { angle: 0, up: 1, flowing: false, rate: 0, pileTop: -9 };
let status = { phase: 'loading', elapsed: 0, duration: 0, t: now() };

// ----------------------------------------------------------------- worker

const worker = new Worker(new URL('./physics.worker.js', import.meta.url), { type: 'module' });
const sound = new Sound();

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'progress':
      $('loaderBar').style.width = `${Math.round(m.value * 100)}%`;
      $('loaderSub').textContent = 'Letting the grains settle…';
      break;
    case 'ready':
      onReady(m);
      break;
    case 'frame':
      if (latest) recycle(latest);
      // Ignore a frame still in flight from before a grain-count change.
      latest = sand && m.buffers.pos.length === sand.count * 3 ? m : null;
      break;
    case 'status':
      status = m;
      renderUI();
      break;
    case 'done':
      sound.chime();
      document.title = "Time's up · Hourglass";
      break;
    case 'error':
      $('loaderSub').textContent = `The physics engine could not start (${m.message}). A browser with WebAssembly SIMD is required.`;
      break;
  }
};
worker.onerror = (e) => {
  $('loaderSub').textContent = `Physics failed to start: ${e.message ?? e}`;
};

function recycle(frame) {
  worker.postMessage({ type: 'recycle', buffers: frame.buffers }, [frame.buffers.pos.buffer, frame.buffers.rot.buffer]);
}

function init(grainCount) {
  $('loader').classList.remove('hidden');
  $('loaderBar').style.width = '4%';
  $('loaderSub').textContent = 'Starting the physics engine…';
  status = { phase: 'loading', elapsed: 0, duration: 0, t: now() };
  renderUI();
  worker.postMessage({ type: 'init', grainCount });
}

function onReady(m) {
  info = m;
  if (sand) {
    rig.remove(sand.mesh);
    sand.dispose();
  }
  sand = new SandGrains(m.grainCount, m.grainRadius);
  rig.add(sand.mesh);
  if (!stream) {
    stream = new FineStream({ exitY: m.plugHalf + m.grainRadius });
    rig.add(stream.mesh);
  }
  stream.clear();
  $('loaderBar').style.width = '100%';
  setTimeout(() => $('loader').classList.add('hidden'), 150);
}

init(Number($('quality').value));

// ------------------------------------------------------------------- UI

let minutes = 1;
let picked = false; // a new duration was chosen since the last run ended

function selectMinutes(m, fromCustom = false) {
  minutes = m;
  picked = true;
  for (const b of $('chips').children) b.setAttribute('aria-checked', String(!fromCustom && Number(b.dataset.min) === m));
  $('custom').classList.toggle('active', fromCustom);
  if (!fromCustom) $('custom').value = '';
  renderUI();
}

$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled) selectMinutes(Number(b.dataset.min));
});
$('custom').addEventListener('input', () => {
  const v = Number($('custom').value);
  if (v >= 1 && v <= 180) selectMinutes(v, true);
});
$('custom').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') primary();
});

function primary() {
  sound.unlock();
  const p = status.phase;
  if (p === 'ready' || p === 'done') {
    document.title = 'Hourglass · digital twin';
    picked = false;
    worker.postMessage({ type: 'start', duration: minutes * 60_000 });
  } else if (p === 'running') worker.postMessage({ type: 'pause' });
  else if (p === 'paused') worker.postMessage({ type: 'resume' });
}

$('primary').addEventListener('click', primary);
$('reset').addEventListener('click', () => {
  document.title = 'Hourglass · digital twin';
  stream?.clear();
  worker.postMessage({ type: 'reset' });
});
$('view').addEventListener('click', () => stage.resetView());
$('sound').addEventListener('click', () => {
  sound.unlock();
  const on = !sound.enabled;
  sound.setEnabled(on);
  $('sound').setAttribute('aria-pressed', String(on));
  $('sound').textContent = on ? 'Sound on' : 'Sound off';
});
$('quality').addEventListener('change', () => init(Number($('quality').value)));

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!$('primary').disabled) primary();
  } else if (e.key === 'r' || e.key === 'R') {
    if (!$('reset').disabled) $('reset').click();
  } else if (e.key === 'v' || e.key === 'V') stage.resetView();
});

function fmtClock(ms) {
  const total = Math.max(0, ms) / 1000;
  if (total < 10 && total > 0) {
    const s = Math.floor(total);
    return `0:0${s}<span class="frac">.${Math.floor((total - s) * 10)}</span>`;
  }
  const t = Math.ceil(total);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function liveElapsed() {
  if (status.phase === 'running') return Math.min(status.duration, status.elapsed + (now() - status.t));
  return status.elapsed;
}

let lastTimeHtml = '';
function renderClock() {
  const p = status.phase;
  let html, frac = 0;
  if (p === 'running' || p === 'paused' || (p === 'done' && !picked)) {
    const el = liveElapsed();
    html = fmtClock(status.duration - el);
    frac = status.duration ? el / status.duration : 0;
  } else {
    html = fmtClock(minutes * 60_000);
  }
  if (html !== lastTimeHtml) {
    $('time').innerHTML = html;
    lastTimeHtml = html;
  }
  $('bar').style.width = `${(frac * 100).toFixed(2)}%`;
  $('barWrap').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
}

function renderUI() {
  const p = status.phase;
  const busy = p === 'loading' || p === 'flipping' || p === 'running' || p === 'paused';
  for (const b of $('chips').children) b.disabled = busy;
  $('custom').disabled = busy;
  $('quality').disabled = p === 'flipping';

  const btn = $('primary');
  btn.disabled = p === 'loading' || p === 'flipping';
  btn.classList.toggle('secondary', p === 'running');
  btn.textContent = { loading: 'Start', ready: 'Start', flipping: 'Turning…', running: 'Pause', paused: 'Resume', done: 'Flip & start' }[p] ?? 'Start';
  $('reset').disabled = p === 'loading';

  const st = $('state');
  st.classList.toggle('done', p === 'done');
  if (p === 'loading') st.textContent = 'Pouring sand…';
  else if (p === 'ready') st.textContent = `Ready · ${fmtInt.format(info?.grainCount ?? 0)} grains in the top bulb`;
  else if (p === 'flipping') st.textContent = 'Turning the glass over…';
  else if (p === 'running') {
    const end = new Date(Date.now() + (status.duration - liveElapsed()));
    st.textContent = `Running · ends ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (p === 'paused') st.textContent = 'Paused · neck closed';
  else if (p === 'done') st.textContent = "Time's up";

  if (status.upper !== undefined) {
    $('tUpper').textContent = fmtInt.format(status.upper);
    $('tCrossing').textContent = fmtInt.format(status.crossing);
    $('tLower').textContent = fmtInt.format(status.lower);
    const want = status.duration ? (status.N0 * 1000) / status.duration : 0;
    $('tFlow').textContent = p === 'running' ? `${status.flow.toFixed(1)} /s (set ${want.toFixed(1)})` : '–';
    if (p === 'running' || p === 'done') {
      const lag = status.target - status.released;
      const ms = want ? (lag / want) * 1000 : 0;
      $('tLag').textContent = lag <= 1 ? 'on time' : `${lag} behind (${Math.round(ms)} ms)`;
    } else $('tLag').textContent = '–';
    $('tPhys').textContent = `${status.stepMs.toFixed(1)} ms/step · ${status.simSpeed >= 0.99 ? 'real time' : `${status.simSpeed.toFixed(2)}× speed`}`;
    $('tActive').textContent = fmtInt.format(status.active);
  }
  sound.setFlow(p === 'running' ? status.flow : 0);
}

// ------------------------------------------------------------------ frame

let lastT = performance.now();
let fpsFrames = 0, fpsT = lastT;

function draw(dt) {
  if (latest && sand) {
    sand.update(latest.buffers.pos, latest.buffers.rot);
    view = latest;
    placeRig(latest.angle);
    recycle(latest);
    latest = null;
  }
  stream?.update(dt, view);
  stage.controls.update();
  stage.renderer.render(stage.scene, stage.camera);
  renderClock();
}

let manual = false; // dev: frames are stepped by hand

function frame() {
  requestAnimationFrame(frame);
  const t = performance.now();
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  if (!manual) draw(dt);
  fpsFrames++;
  if (t - fpsT > 1000) {
    $('tFps').textContent = `${Math.round((fpsFrames * 1000) / (t - fpsT))} fps`;
    fpsFrames = 0;
    fpsT = t;
  }
}
requestAnimationFrame(frame);
selectMinutes(1);

if (import.meta.env.DEV) {
  // Inspection hook: step the view at a fixed timestep (e.g. when the tab is hidden).
  window.__hourglass.step = (frames = 60, dt = 1 / 60) => {
    manual = true;
    for (let i = 0; i < frames; i++) draw(dt);
  };
  window.__hourglass.live = () => { manual = false; };
}
