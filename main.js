'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'dropturn.' で始める。
const STORE = 'dropturn.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}
function clear(key) {
  try { localStorage.removeItem(STORE + key); } catch { /* 何もできなくても害はない */ }
}

WebAppKit.init({ title: 'DROPTURN', text: '3×3×3のかごに色の箱を落とし、段を回すか全体をひっくり返して、同じ色を3つ並べる立体の三目並べ。1台で2〜4人。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----

import * as THREE from './vendor/three.module.min.js';
import * as G from './game.js';

const $ = (id) => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// 見た目（§9 権利: 元の製品の黒枠・6 色の組を使わない。色ごとに形の印も付ける）
const COLOR_META = [
  { hex: '#f07a5a', mark: '●' }, // 0 珊瑚
  { hex: '#f2b632', mark: '▲' }, // 1 山吹
  { hex: '#f28ab8', mark: '◆' }, // 2 桃
  { hex: '#7cc36b', mark: '■' }, // 3 若葉
  { hex: '#5ab0e8', mark: '✚' }, // 4 空
  { hex: '#9b86e0', mark: '★' }, // 5 藤
];
// 列 k(0-7) の (x, z) 位置（3×3 の外周。中心は軸でふさがっている）
const COL_XZ = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
const playerName = (p) => `プレイヤー ${p + 1}`;

// ---- 設定・記録 ----
function loadSettings() {
  const s = load('settings', {});
  return {
    v: 1,
    sound: typeof s.sound === 'boolean' ? s.sound : true,
    seenHelp: s.seenHelp === true,
  };
}
let settings = loadSettings();

// ---- 効果音（Web Audio で作る。音声ファイルは使わない） ----
const Sound = {
  ctx: null, out: null,
  ensure() {
    if (!settings.sound) return null;
    if (!this.ctx || this.ctx.state === 'suspended') setAudioSession(true);
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.6;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },
  tone(freq, dur, { type = 'sine', gain = 0.08, at = 0, bend = 1 } = {}) {
    const c = this.ensure();
    if (!c) return;
    const t = c.currentTime + at;
    const o = c.createOscillator(), v = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq * bend, t + dur);
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(v).connect(this.out);
    o.start(t); o.stop(t + dur + 0.05);
  },
  select() { this.tone(1500, 0.03, { gain: 0.05 }); },
  land(n = 1) { for (let i = 0; i < n; i++) this.tone(180, 0.06, { type: 'triangle', gain: 0.09, at: i * 0.05, bend: 0.7 }); },
  rotate() { this.tone(2200, 0.02, { type: 'square', gain: 0.04 }); },
  flip() { this.tone(500, 0.2, { gain: 0.05, bend: 2 }); setTimeout(() => this.land(), 180); },
  bad() { this.tone(140, 0.09, { type: 'triangle', gain: 0.07, bend: 0.6 }); },
  win() { [523, 659, 784].forEach((f, i) => this.tone(f, 0.24, { type: 'triangle', gain: 0.08, at: i * 0.1 })); },
  draw() { [440, 440].forEach((f, i) => this.tone(f, 0.2, { type: 'triangle', gain: 0.06, at: i * 0.18 })); },
};
setAudioSession(settings.sound);
document.addEventListener('pointerdown', () => Sound.ensure(), { capture: true });
document.querySelectorAll('[data-sound]').forEach((b) => b.addEventListener('click', () => {
  settings = { ...settings, sound: !settings.sound };
  save('settings', settings);
  setAudioSession(settings.sound);
  renderSound();
}));
function renderSound() {
  document.querySelectorAll('[data-sound]').forEach((b) => {
    b.setAttribute('aria-pressed', settings.sound);
    if (b.tagName === 'BUTTON' && b.classList.contains('pill')) b.textContent = settings.sound ? '音 オン' : '音 オフ';
  });
}
renderSound();

// ---- タイトルの小さな見本（Canvas 2D。見るだけの飾りなので 3D にはしない） ----
const titleCanvas = $('title-cage');
const titleCtx = titleCanvas.getContext('2d');
function drawDemoCage(ctx, w, h, board) {
  ctx.clearRect(0, 0, w, h);
  const scale = Math.min(w, h) / 5.6;
  const originX = w / 2, originY = h * 0.32;
  const iso = (x, z, y) => [
    originX + (x - z) * scale * 0.86,
    originY + (x + z) * scale * 0.5 - y * scale * 0.62,
  ];
  const cells = [];
  for (let k = 0; k < 8; k++) {
    const [x, z] = COL_XZ[k];
    for (let t = 0; t < 3; t++) cells.push({ x, z, t, color: board[G.idx(k, t)], depth: x + z - t });
  }
  cells.sort((a, b) => a.depth - b.depth);
  const size = scale * 0.74;
  for (const c of cells) {
    const [sx, sy] = iso(c.x, c.z, c.t);
    ctx.beginPath();
    ctx.roundRect(sx - size / 2, sy - size / 2, size, size, size * 0.22);
    if (c.color >= 0) {
      ctx.fillStyle = COLOR_META[c.color].hex;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = `${size * 0.5}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(COLOR_META[c.color].mark, sx, sy + size * 0.04);
    } else {
      ctx.strokeStyle = 'rgba(216, 196, 154, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
function demoCage() {
  let b = G.newBoard();
  let n = 0;
  for (const c of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const h = (c * 37 + 11) % 3;
    for (let t = 0; t <= h && n < 15; t++, n++) b = G.drop(b, c, (c + t) % 6);
  }
  drawDemoCage(titleCtx, titleCanvas.width, titleCanvas.height, b);
}
demoCage();

// ==========================================================================
// ---- 3D のかご（Three.js） ----
// 帯（展開図）ではなく、本物の立体として見せる。操作は「空いた所をドラッグで
// 視点を回す」「かごの上の入口・段をタップして選ぶ」の 2 つだけ。
// ==========================================================================

const offsetOf = (col) => { const [x, z] = COL_XZ[col]; return [x - 1, z - 1]; };
const yOf = (tier) => tier - 1;
// かごの枠の半径（中心から面まで）。マスの間隔（1）の 1.5 倍で、3 マス分ぴったりの立方体になる。
// 枠・軸・入口の目印・当たり判定・見た目のフィットは、すべてこの 1 つの値と offsetOf/yOf から作る。
const FRAME_R = 1.5;
const cornerOf = (col) => { const [x, z] = offsetOf(col); return [x * FRAME_R, z * FRAME_R]; };
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sceneCanvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// リアルタイムの影（shadow map）は、古いスマホへの負荷と、特定の角度で床とかご・箱の
// 組み合わせがちらつく描画の不具合が出たため使わない。かわりに、床に固定のぼかした影の
// 絵（テクスチャ）を敷いて「浮いていない」感じだけを安く出す。

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101626);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
scene.add(new THREE.HemisphereLight(0x8fa0d8, 0x0a0e18, 0.5));
const keyLight = new THREE.DirectionalLight(0xfff1d6, 1.35);
keyLight.position.set(2.3, 4.2, 2.6);
scene.add(keyLight);
// 反対側からの弱い青みの光。金属の枠に陰影の差が出て、立体感と「照り」が出る。
const fillLight = new THREE.DirectionalLight(0x9fb6ff, 0.45);
fillLight.position.set(-3, 1.2, -2.4);
scene.add(fillLight);

function shadowBlobTexture() {
  const W = 256, cv = document.createElement('canvas');
  cv.width = cv.height = W;
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.45)');
  g.addColorStop(0.7, 'rgba(0,0,0,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, W, W);
  return new THREE.CanvasTexture(cv);
}
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(FRAME_R * 1.7, 28),
  new THREE.MeshBasicMaterial({ map: shadowBlobTexture(), transparent: true, depthWrite: false }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -FRAME_R - 0.05;
scene.add(ground);

const cageGroup = new THREE.Group();
const frameGroup = new THREE.Group();
const panelGroup = new THREE.Group();
const cubesGroup = new THREE.Group();
const markerGroup = new THREE.Group();
cageGroup.add(frameGroup, panelGroup, cubesGroup, markerGroup);
scene.add(cageGroup);

// ---- かごの枠（真鍮色）と、少し透ける側面 ----
const BRASS = 0xd8c49a;
// 金属らしい照りを出すため metalness を高めにし、roughness を低めにして反射を強くする。
const postMat = new THREE.MeshStandardMaterial({ color: BRASS, metalness: 0.78, roughness: 0.28 });
const axisMat = new THREE.MeshStandardMaterial({ color: 0xc2a876, metalness: 0.72, roughness: 0.32 });

function edgeBetween(a, b, radius, material) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = dir.length();
  // radialSegments を増やして、金属のハイライトが丸く滑らかに乗るようにする
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 16), material);
  m.position.copy(start).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().normalize());
  return m;
}

function buildFrame() {
  // かごはちょうど 3×3×3 マスの立方体（±FRAME_R）。枠の柱もこの範囲にきっちり収め、
  // 軸だけ突き出て見えないようにする。
  const Y0 = -FRAME_R, Y1 = FRAME_R;
  const offs = COL_XZ.map((_, col) => cornerOf(col));
  for (const [x, z] of offs) frameGroup.add(edgeBetween([x, Y0, z], [x, Y1, z], 0.07, postMat));
  frameGroup.add(edgeBetween([0, Y0, 0], [0, Y1, 0], 0.14, axisMat)); // ふさがっている中心の軸
  for (const y of [-1.5, -0.5, 0.5, 1.5]) {
    for (let i = 0; i < 8; i++) {
      const [x1, z1] = offs[i], [x2, z2] = offs[(i + 1) % 8];
      frameGroup.add(edgeBetween([x1, y, z1], [x2, y, z2], 0.05, postMat));
    }
  }
  // 側面をふさぐ 1 枚のガラス箱（内側だけ描く BackSide）。4 枚の板を別々に置くと、斜めから
  // 見たときに板どうしが重なって格子状のちらつきが出たので、継ぎ目のない 1 個の箱にした。
  const panelMat = new THREE.MeshBasicMaterial({
    color: BRASS, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.BackSide,
  });
  const panelSize = FRAME_R * 2 + 0.1;
  panelGroup.add(new THREE.Mesh(new THREE.BoxGeometry(panelSize, panelSize, panelSize), panelMat));
}
buildFrame();

// ---- 段を選んでいるときの光る帯 ----
const tierHighlightMat = new THREE.MeshBasicMaterial({ color: 0xffcf6b, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
const tierHighlightMesh = new THREE.Mesh(new THREE.CylinderGeometry(FRAME_R * 1.28, FRAME_R * 1.28, 0.86, 24, 1, true), tierHighlightMat);
tierHighlightMesh.visible = false;
cageGroup.add(tierHighlightMesh);
function highlightTier(tier) {
  if (tier == null) { tierHighlightMesh.visible = false; kick(); return; }
  tierHighlightMesh.position.y = yOf(tier);
  tierHighlightMesh.visible = true;
  kick();
}

// ---- 落とす入口（かごの上の 8 か所。光る目印） ----
// 見た目は輪（テクスチャ）だが、当たり判定は真ん中も含む円にする（輪の穴をタップしても選べるように）
function ringTexture(color) {
  const W = 128, cv = document.createElement('canvas');
  cv.width = cv.height = W;
  const x = cv.getContext('2d');
  x.strokeStyle = color;
  x.lineWidth = W * 0.16;
  x.beginPath(); x.arc(W / 2, W / 2, W * 0.34, 0, Math.PI * 2); x.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// depthWrite: false にする（透ける板が深度を書き込むと、後ろのかご・箱が変な形に欠けて見えた）
const markerMatOn = new THREE.MeshBasicMaterial({ map: ringTexture('#ffcf6b'), transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
const markerMatOff = new THREE.MeshBasicMaterial({ map: ringTexture('#7a6c47'), transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
const markerGeo = new THREE.CircleGeometry(0.36, 22);
function buildMarkers() {
  for (let col = 0; col < 8; col++) {
    const [x, z] = offsetOf(col);
    const m = new THREE.Mesh(markerGeo, markerMatOff);
    m.position.set(x, FRAME_R + 0.2, z);
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.userData = { col, enabled: false };
    markerGroup.add(m);
  }
}
buildMarkers();
function updateMarkers() {
  const show = mode === 'drop' && pendingColor != null && !pendingMove;
  for (const m of markerGroup.children) {
    m.visible = show;
    const enabled = show && G.canDrop(game.board, m.userData.col);
    m.userData.enabled = enabled;
    m.material = enabled ? markerMatOn : markerMatOff;
  }
  kick();
}

// ---- 箱（キューブ）。色ごとに 1 枚のテクスチャを作って使い回す ----
const cubeTexCache = new Map();
function cubeTexture(color) {
  if (cubeTexCache.has(color)) return cubeTexCache.get(color);
  const W = 128, cv = document.createElement('canvas');
  cv.width = cv.height = W;
  const x = cv.getContext('2d');
  x.fillStyle = COLOR_META[color].hex;
  x.beginPath(); x.roundRect(3, 3, W - 6, W - 6, 16); x.fill();
  x.fillStyle = 'rgba(0,0,0,0.55)';
  x.font = `${W * 0.52}px system-ui`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(COLOR_META[color].mark, W / 2, W / 2 + W * 0.03);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cubeTexCache.set(color, t);
  return t;
}
const cubeMatCache = new Map();
function cubeMaterial(color, ghost) {
  const key = `${color}-${ghost}`;
  if (cubeMatCache.has(key)) return cubeMatCache.get(key);
  const m = new THREE.MeshStandardMaterial({ map: cubeTexture(color), roughness: 0.55, metalness: 0.05 });
  if (ghost) { m.transparent = true; m.opacity = 0.42; m.depthWrite = false; }
  cubeMatCache.set(key, m);
  return m;
}
// 角を少し丸めた箱（RoundedBoxGeometry 相当を自前で作る）。BoxGeometry を細かく分割し、
// 角・辺に近い頂点だけを中心方向へ丸めることで、面ごとの陰影がはっきり付くようにする。
function roundedBoxGeometry(size, radius, segments) {
  const geo = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
  const half = size / 2, inner = half - radius;
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = THREE.MathUtils.clamp(v.x, -inner, inner);
    const cy = THREE.MathUtils.clamp(v.y, -inner, inner);
    const cz = THREE.MathUtils.clamp(v.z, -inner, inner);
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) pos.setXYZ(i, cx + (dx / len) * radius, cy + (dy / len) * radius, cz + (dz / len) * radius);
  }
  geo.computeVertexNormals();
  return geo;
}
const cubeGeo = roundedBoxGeometry(0.82, 0.12, 4);
function makeCube(color, ghost) {
  return new THREE.Mesh(cubeGeo, cubeMaterial(color, ghost));
}
function cellPos(col, tier) { const [x, z] = offsetOf(col); return [x, yOf(tier), z]; }

// boxes[idx(col,tier)] = 今そのマスに表示している Mesh（見た目の状態。ゲームの状態は game.board）
let boxes = new Array(24).fill(null);
let ghostMeshes = [];
function snap(board, ghost = false) {
  for (const m of boxes) if (m) m.removeFromParent();
  boxes.fill(null);
  for (let col = 0; col < 8; col++) for (let tier = 0; tier < 3; tier++) {
    const v = board[G.idx(col, tier)];
    if (v === G.EMPTY) continue;
    const mesh = makeCube(v, ghost);
    mesh.position.set(...cellPos(col, tier));
    cubesGroup.add(mesh);
    boxes[G.idx(col, tier)] = mesh;
  }
  kick();
}
function clearGhost() { for (const m of ghostMeshes) m.removeFromParent(); ghostMeshes = []; kick(); }

// ---- 勝ったときに、そろった箱を光らせる ----
let winMeshes = [];
let winPulsing = false;
function highlightWin(lines) {
  winMeshes = [];
  const idxSet = new Set(lines.flat());
  for (const i of idxSet) {
    const m = boxes[i];
    if (!m) continue;
    m.material = m.material.clone();
    m.material.emissive = new THREE.Color(0xffe6a8);
    m.material.emissiveIntensity = 0.4;
    winMeshes.push(m);
  }
  winPulsing = winMeshes.length > 0;
  kick();
}

// ---- 描くのは動きがあるときだけ（重い処理を避ける） ----
let raf = 0;
let activeAnims = [];
function tween(dur, onUpdate) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const a = {
      step() {
        const p = dur <= 0 ? 1 : Math.min(1, (performance.now() - t0) / dur);
        onUpdate(p);
        if (p >= 1) { activeAnims = activeAnims.filter((x) => x !== a); resolve(); }
      },
    };
    activeAnims.push(a);
    kick();
  });
}
function kick() { if (!raf) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  for (const a of [...activeAnims]) a.step();
  if (winPulsing && !reduced.matches) {
    const k = 0.32 + 0.22 * Math.sin(now / 300);
    for (const m of winMeshes) m.material.emissiveIntensity = k;
  }
  updateCamera();
  renderer.render(scene, camera);
  if (dragState || activeAnims.length || (winPulsing && !reduced.matches)) raf = requestAnimationFrame(frame);
}

// ---- 視点（空いた所をドラッグで、かごの周りを回って見る） ----
// phi は真上からの角度。小さいほど見下ろす。初めは 3 段の側面と上の面がどちらも見える角度にする。
const HOME = { theta: 0.7, phi: 0.92 };
const PHI_MIN = 0.5, PHI_MAX = 1.32;
let orbit = { ...HOME };
let fitRadius = 6;
function updateCamera() {
  const r = fitRadius;
  camera.position.set(
    r * Math.sin(orbit.phi) * Math.sin(orbit.theta),
    r * Math.cos(orbit.phi),
    r * Math.sin(orbit.phi) * Math.cos(orbit.theta),
  );
  camera.lookAt(0, 0, 0);
}
function fitView() {
  const rect = sceneCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const vHalf = (camera.fov * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const half = Math.min(vHalf, hHalf);
  // かごの水平方向の半径（対角）を基準に、画面の 8 割くらいまで大きく見せる
  const boundRadius = FRAME_R * Math.SQRT2;
  fitRadius = (boundRadius / Math.sin(half)) * 1.25;
  camera.near = fitRadius / 10;
  camera.far = fitRadius * 4;
  kick();
}
addEventListener('resize', fitView);
// ウィンドウの大きさだけでなく、操作欄の開閉でもかごの表示領域が変わるので ResizeObserver で見る
if ('ResizeObserver' in window) new ResizeObserver(fitView).observe(sceneCanvas);

// ---- 指の操作: 空いた所のドラッグ = 視点。入口・段のタップ = 選ぶ ----
const raycaster = new THREE.Raycaster();
function ndc(x, y) {
  const r = sceneCanvas.getBoundingClientRect();
  return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
}
function pickEntry(x, y) {
  raycaster.setFromCamera(ndc(x, y), camera);
  const hit = raycaster.intersectObjects(markerGroup.children, false).find((h) => h.object.visible && h.object.userData.enabled);
  return hit ? hit.object.userData.col : null;
}
function pickTier(x, y) {
  raycaster.setFromCamera(ndc(x, y), camera);
  const targets = [...frameGroup.children, ...panelGroup.children, ...boxes.filter(Boolean)];
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return null;
  const local = cageGroup.worldToLocal(hit.point.clone());
  return Math.max(0, Math.min(2, Math.round(local.y + 1)));
}

let dragState = null;
sceneCanvas.addEventListener('pointerdown', (e) => {
  sceneCanvas.setPointerCapture(e.pointerId);
  let hit = null;
  if (!busy) {
    if (mode === 'drop' && pendingColor != null && !pendingMove) {
      const col = pickEntry(e.clientX, e.clientY);
      if (col != null) hit = { kind: 'entry', v: col };
    } else if (mode === 'rotate' && pendingTier == null && !pendingMove) {
      const tier = pickTier(e.clientX, e.clientY);
      if (tier != null) hit = { kind: 'tier', v: tier };
    }
  }
  dragState = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, hit, moved: false };
  kick();
});
sceneCanvas.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.x, dy = e.clientY - dragState.y;
  dragState.x = e.clientX; dragState.y = e.clientY;
  if (Math.hypot(e.clientX - dragState.x0, e.clientY - dragState.y0) > 8) dragState.moved = true;
  if (!dragState.hit || dragState.moved) {
    orbit.theta -= dx * 0.008;
    orbit.phi = Math.max(PHI_MIN, Math.min(PHI_MAX, orbit.phi - dy * 0.008));
    kick();
  }
});
function endDrag(e) {
  const ds = dragState;
  dragState = null;
  if (!ds || ds.moved || !ds.hit || busy) { kick(); return; }
  if (ds.hit.kind === 'entry') onColumnPick(ds.hit.v);
  else if (ds.hit.kind === 'tier') selectTier(ds.hit.v);
}
sceneCanvas.addEventListener('pointerup', endDrag);
sceneCanvas.addEventListener('pointercancel', () => { dragState = null; kick(); });

$('view-reset').addEventListener('click', () => { orbit = { ...HOME }; Sound.select(); kick(); });

// ---- 重力で落ちる分だけ、位置をなめらかに動かす ----
async function animateGravitySettle(fromBoard, toBoard, dur) {
  const moves = [];
  for (let col = 0; col < 8; col++) {
    const fromTiers = [0, 1, 2].filter((t) => fromBoard[G.idx(col, t)] !== G.EMPTY);
    const toTiers = [0, 1, 2].filter((t) => toBoard[G.idx(col, t)] !== G.EMPTY);
    fromTiers.forEach((ft, i) => {
      const tt = toTiers[i];
      const mesh = boxes[G.idx(col, ft)];
      if (mesh && tt !== ft) moves.push({ mesh, fromY: yOf(ft), toY: yOf(tt) });
    });
  }
  if (!moves.length) return;
  await tween(dur, (p) => {
    const e = easeOutCubic(p);
    for (const mv of moves) mv.mesh.position.y = mv.fromY + (mv.toY - mv.fromY) * e;
  });
}

// ---- 段を回す（予告のときも決定のときも、実際に段が 90° 回る） ----
async function animRotatePhysical(beforeBoard, move, dur, ghost) {
  const pivot = new THREE.Group();
  pivot.position.set(0, yOf(move.tier), 0);
  cageGroup.add(pivot);
  const angle = -move.dir * (Math.PI / 2);
  for (let col = 0; col < 8; col++) {
    const idx = G.idx(col, move.tier);
    const v = beforeBoard[idx];
    if (v === G.EMPTY) continue;
    if (boxes[idx]) { boxes[idx].removeFromParent(); boxes[idx] = null; }
    const [x, , z] = cellPos(col, move.tier);
    const mesh = makeCube(v, false);
    mesh.position.set(x, 0, z);
    pivot.add(mesh);
  }
  highlightTier(move.tier);
  await tween(dur, (p) => pivot.quaternion.setFromAxisAngle(Y_AXIS, angle * easeOutCubic(p)));
  pivot.removeFromParent();
  const rotatedNoGravity = G.rotateBoard(beforeBoard, move.tier, move.dir);
  snap(rotatedNoGravity, ghost);
  const afterGravity = G.gravity(rotatedNoGravity);
  await animateGravitySettle(rotatedNoGravity, afterGravity, Math.max(80, dur * 0.55));
}

// ---- 落とす: 上から落ちる ----
async function animPlayDrop(beforeBoard, move, dur) {
  clearGhost();
  snap(beforeBoard, false);
  const tier = [0, 1, 2].find((t) => beforeBoard[G.idx(move.col, t)] === G.EMPTY);
  if (tier == null) return;
  const mesh = makeCube(move.color, false);
  const [x, , z] = cellPos(move.col, tier);
  const fromY = FRAME_R + 1.1, toY = yOf(tier);
  mesh.position.set(x, fromY, z);
  cubesGroup.add(mesh);
  boxes[G.idx(move.col, tier)] = mesh;
  await tween(dur, (p) => { mesh.position.y = fromY + (toY - fromY) * easeOutCubic(p); });
}

// ---- 返す: かご全体が 180° 回ってから、箱が落ち直す ----
async function animPlayFlip(beforeBoard, afterBoard, dur) {
  clearGhost();
  snap(beforeBoard, false);
  await tween(dur, (p) => cageGroup.quaternion.setFromAxisAngle(X_AXIS, Math.PI * easeInOutCubic(p)));
  cageGroup.quaternion.identity();
  const noGravity = G.flipBoard(beforeBoard);
  snap(noGravity, false);
  await animateGravitySettle(noGravity, afterBoard, Math.max(100, dur * 0.6));
  snap(afterBoard, false);
}

// ==========================================================================
// ---- 対局 ----
// ==========================================================================
let game = null;
let mode = null;          // 'drop' | 'rotate' | 'flip' | null（選んでいる手の種類）
let pendingColor = null;
let pendingTier = null;
let pendingMove = null;   // 確定前の、予告している手
let busy = false;
let animToken = 0;        // 進行中の予告アニメを無効にするための合いことば

function loadGame() {
  const g = load('game', null);
  if (!g || g.over || !G.PLAYER_COLORS[g.players]) return null;
  return g;
}
function persist() {
  if (game && !game.over) save('game', game); else clear('game');
}

function onColumnPick(col) {
  if (mode === 'drop' && pendingColor != null && !pendingMove) trySetMove({ type: 'drop', color: pendingColor, col });
}

function selectTier(tier) {
  pendingTier = tier;
  Sound.select();
  $('rotate-hint').textContent = `${['下', '中', '上'][tier]}の段。向きを選ぶ`;
  $('dirs').hidden = false;
  highlightTier(tier);
  render();
}

function trySetMove(move) {
  if (!G.isLegal(game, move)) {
    Sound.bad();
    $('notice').textContent = reasonFor(move);
    return;
  }
  pendingMove = move;
  if (move.type === 'rotate') Sound.rotate(); else Sound.select();
  $('notice').textContent = '';
  render();
  applyPreview(move);
}

// 予告: 落とす・返すは静かに半透明で見せる。回すは、そのとおりに段を回す。
async function applyPreview(move) {
  const tok = ++animToken;
  if (move.type === 'drop') {
    clearGhost();
    const tier = [0, 1, 2].find((t) => game.board[G.idx(move.col, t)] === G.EMPTY);
    if (tier != null) {
      const mesh = makeCube(move.color, true);
      mesh.position.set(...cellPos(move.col, tier));
      cubesGroup.add(mesh);
      ghostMeshes.push(mesh);
      kick();
    }
  } else if (move.type === 'flip') {
    clearGhost();
    snap(G.previewBoard(game, move), true);
  } else if (move.type === 'rotate') {
    busy = true;
    render();
    clearGhost();
    await animRotatePhysical(game.board, move, reduced.matches ? 90 : 260, true);
    if (tok !== animToken) return;
    busy = false;
    render();
  }
}

function reasonFor(move) {
  if (move.type === 'drop') return 'その列はいっぱいです';
  return '1 手前に戻す手、または何も変わらない手は指せません';
}

function resetScenePreview() {
  animToken++;
  clearGhost();
  highlightTier(null);
  if (game) snap(game.board, false);
}

// ---- 手の種類の選択 ----
$('actions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || busy) return;
  selectAction(b.dataset.act);
});

function selectAction(act) {
  mode = act;
  pendingColor = null;
  pendingTier = null;
  pendingMove = null;
  $('notice').textContent = '';
  clearGhost();
  highlightTier(null);
  Sound.select();
  render();
}
$('flip-preview').addEventListener('click', () => trySetMove({ type: 'flip' }));
$('dir-left').addEventListener('click', () => { if (pendingTier != null) trySetMove({ type: 'rotate', tier: pendingTier, dir: -1 }); });
$('dir-right').addEventListener('click', () => { if (pendingTier != null) trySetMove({ type: 'rotate', tier: pendingTier, dir: 1 }); });

function renderColors() {
  const box = $('colors');
  box.innerHTML = '';
  if (!game) return;
  const hand = game.hand[game.turn];
  Object.entries(hand).forEach(([color, n]) => {
    color = +color;
    const b = document.createElement('button');
    b.className = 'colorbtn';
    b.disabled = n <= 0;
    b.setAttribute('aria-pressed', pendingColor === color);
    b.style.setProperty('--c', COLOR_META[color].hex);
    b.innerHTML = `<span class="colorbtn__mark">${COLOR_META[color].mark}</span><span class="colorbtn__n">${n}</span>`;
    b.addEventListener('click', () => {
      pendingColor = color; pendingMove = null;
      clearGhost();
      Sound.select();
      render();
    });
    box.append(b);
  });
}

// ---- 決定・やめる ----
$('decide').addEventListener('click', () => {
  if (!pendingMove || busy) return;
  commit(pendingMove);
});
$('cancel').addEventListener('click', () => {
  mode = null; pendingColor = null; pendingTier = null; pendingMove = null;
  $('notice').textContent = '';
  resetScenePreview();
  render();
});

async function commit(move) {
  busy = true;
  render();
  const before = game;
  const afterState = G.applyMove(game, move);
  const dur = reduced.matches ? 70 : 320;
  animToken++;
  if (move.type === 'drop') { Sound.land(); await animPlayDrop(before.board, move, dur); }
  else if (move.type === 'rotate') { Sound.rotate(); snap(afterState.board, false); }
  else { Sound.flip(); await animPlayFlip(before.board, afterState.board, dur); }
  game = afterState;
  mode = null; pendingColor = null; pendingTier = null; pendingMove = null;
  highlightTier(null);
  persist();
  busy = false;
  if (game.over) finish(before); else render();
}

// ---- 画面の描画（文字・ボタン。かごの中身はここでは書き換えない） ----
function render() {
  if (!game) return;
  const moverColors = G.PLAYER_COLORS[game.players][game.turn];

  $('turn').textContent = game.over ? '' : `${playerName(game.turn)} の番`;
  $('turn').style.color = game.over ? '' : COLOR_META[moverColors[0]].hex;

  $('sub-drop').hidden = mode !== 'drop';
  $('sub-rotate').hidden = mode !== 'rotate';
  $('sub-flip').hidden = mode !== 'flip';
  if (mode === 'drop') renderColors();
  if (mode === 'rotate' && pendingTier == null) { $('rotate-hint').textContent = '回す段（かご）をタップ'; $('dirs').hidden = true; }

  $('decide').hidden = !pendingMove;
  $('decide').disabled = busy;
  $('cancel').hidden = !mode;
  $('cancel').disabled = busy;

  const moves = G.legalMoves(game);
  const canDropAny = moves.some((m) => m.type === 'drop');
  $('actions').querySelectorAll('[data-act]').forEach((b) => {
    b.disabled = busy || (b.dataset.act === 'drop' && !canDropAny);
  });

  if (game.afterEmpty != null && !game.over) {
    $('notice').textContent = `あと ${game.afterEmpty} 手で引き分け`;
  } else if (!pendingMove) {
    $('notice').textContent = '';
  }

  updateMarkers();
}

// ---- 結果 ----
function finish(before) {
  const r = $('result');
  if (game.draw) {
    $('result-head').textContent = '引き分け';
    $('result-head').style.color = '';
    Sound.draw();
  } else {
    const owner = game.winner;
    const colors = G.PLAYER_COLORS[game.players][owner];
    $('result-head').textContent = `${playerName(owner)} の勝ち`;
    $('result-head').style.color = COLOR_META[colors[0]].hex;
    Sound.win();
  }
  $('result-moves').textContent = `${game.moves} 手`;
  r.hidden = false;
  $('turn').textContent = '';
  const buttons = r.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  setTimeout(() => buttons.forEach((b) => { b.disabled = false; }), 400);
  render();
  if (game.winLines.length) highlightWin(game.winLines);
  void before;
}

function shareText() {
  if (game.draw) return `DROPTURN（${game.players} 人）で ${game.moves} 手の末に引き分け`;
  const owner = game.winner;
  const colors = G.PLAYER_COLORS[game.players][owner];
  return `DROPTURN（${game.players} 人）で ${COLOR_META[colors[0]].mark} ${playerName(owner)} が ${game.moves} 手で勝った！`;
}
$('share-result').addEventListener('click', () => WebAppKit.share({ text: shareText() }));

// ---- 画面の切り替え ----
function show(screen) {
  $('title').hidden = screen !== 'title';
  $('game').hidden = screen !== 'game';
}

function enterGame() {
  animToken++;
  clearGhost();
  highlightTier(null);
  winPulsing = false;
  orbit = { ...HOME };
  show('game');
  snap(game.board, false);
  fitView();
  render();
}

function startGame(players) {
  game = G.newGame(players);
  mode = null; pendingColor = null; pendingTier = null; pendingMove = null;
  busy = false;
  $('result').hidden = true;
  persist();
  enterGame();
}

document.querySelectorAll('[data-players]').forEach((b) => b.addEventListener('click', () => {
  if (!settings.seenHelp) {
    settings = { ...settings, seenHelp: true };
    save('settings', settings);
    openHelp(() => startGame(+b.dataset.players));
  } else {
    startGame(+b.dataset.players);
  }
}));

$('resume').addEventListener('click', () => {
  const g = loadGame();
  if (!g) return;
  game = g;
  mode = null; pendingColor = null; pendingTier = null; pendingMove = null;
  busy = false;
  enterGame();
});

function toTitle() {
  game = null;
  animToken++;
  winPulsing = false;
  show('title');
  renderTitle();
}
function renderTitle() {
  const g = loadGame();
  $('resume').hidden = !g;
}

$('again').addEventListener('click', () => startGame(game.players));
$('to-title').addEventListener('click', toTitle);

// ---- 遊び方・メニュー ----
const help = $('help');
let afterHelp = null;
function openHelp(then = null) { afterHelp = then; help.showModal(); }
help.addEventListener('close', () => { const f = afterHelp; afterHelp = null; if (f) f(); });
$('help-close').addEventListener('click', () => help.close());
$('howto').addEventListener('click', () => openHelp());
$('menu-howto').addEventListener('click', () => { $('menu').close(); openHelp(); });

const menu = $('menu');
$('menu-open').addEventListener('click', () => menu.showModal());
$('menu-close').addEventListener('click', () => menu.close());
$('menu-title').addEventListener('click', () => {
  menu.close();
  if (game.moves === 0 || confirm('対局をやめて、タイトルへ戻りますか？')) toTitle();
});
$('menu-restart').addEventListener('click', () => {
  menu.close();
  if (game.moves === 0 || confirm('最初からやり直しますか？')) startGame(game.players);
});

renderTitle();
window.__dtDebug = { ground, panelGroup, frameGroup, markerGroup, cubesGroup, tierHighlightMesh, scene, kick };
