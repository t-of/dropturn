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
const BANNED_MOVE_MSG = '1 手前に戻す手、または何も変わらない手は指せません';

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
const PANEL_SIZE = FRAME_R * 2 + 0.1;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
// 回す・返すの終わりに少し行き過ぎてから戻る（t=1 でちょうど目標角度に着地する）
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; };
const easeInOutBack = (t) => {
  const c1 = 1.70158, c2 = c1 * 1.525;
  return t < 0.5
    ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2
    : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
};
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sceneCanvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x000000, 0); // 背景は CSS の階調（scene-wrap のradial-gradient）を透かして見せる
// リアルタイムの影（shadow map）は、古いスマホへの負荷と、特定の角度で床とかご・箱の
// 組み合わせがちらつく描画の不具合が出たため使わない。かわりに、床に固定のぼかした影の
// 絵（テクスチャ）を敷いて「浮いていない」感じだけを安く出す。

const scene = new THREE.Scene();
scene.background = null;
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

// ---- 環境マップ（真鍮・箱の照りに使う） ----
// vendor に RoomEnvironment が無いので、色の違う面をいくつか置いた小さな部屋を自前で作り、
// PMREMGenerator でぼかして環境マップにする（見た目は簡易な RoomEnvironment 相当。一度作るだけで毎フレームのコストはない）。
function buildEnvironmentTexture() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(14, 14, 14),
    new THREE.MeshStandardMaterial({ side: THREE.BackSide, color: 0x05070d, roughness: 1, metalness: 0 }),
  );
  envScene.add(room);
  const panel = (x, y, z, w, h, color, intensity) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    m.material.color.multiplyScalar(intensity);
    envScene.add(m);
  };
  panel(0, 6.9, 0, 7, 7, 0xfff1d6, 5);     // 上: 暖かい照明
  panel(-6.9, 1, 3, 5, 9, 0x9fb6ff, 2.2);  // 左: 冷たい反射
  panel(6.9, -1, -3, 5, 8, 0xd8c49a, 2.6); // 右: 真鍮色の反射
  panel(0, -6.9, 0, 6, 6, 0x14181f, 0.6);  // 下: 暗い床の映り込み
  const rt = pmrem.fromScene(envScene, 0.035);
  pmrem.dispose();
  return rt.texture;
}
scene.environment = buildEnvironmentTexture();

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
// つやのある金属の台座（リアルタイム影は使わず、環境マップの映り込みだけで「乗っている」感じを出す）
const pedestal = new THREE.Mesh(
  new THREE.CylinderGeometry(FRAME_R * 1.55, FRAME_R * 1.7, 0.14, 40),
  new THREE.MeshStandardMaterial({ color: 0x141a2c, metalness: 0.6, roughness: 0.22, envMapIntensity: 0.9 }),
);
pedestal.position.y = -FRAME_R - 0.12;
scene.add(pedestal);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(FRAME_R * 1.7, 28),
  new THREE.MeshBasicMaterial({ map: shadowBlobTexture(), transparent: true, depthWrite: false }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -FRAME_R - 0.04;
scene.add(ground);

// 手番の色でうっすら光る、台座の縁の輪（player glow）
const auraMat = new THREE.MeshBasicMaterial({ color: 0xd8c49a, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const aura = new THREE.Mesh(new THREE.RingGeometry(FRAME_R * 1.56, FRAME_R * 1.82, 40), auraMat);
aura.rotation.x = -Math.PI / 2;
aura.position.y = -FRAME_R - 0.1;
scene.add(aura);
function setPlayerGlow(hex) {
  const c = new THREE.Color(hex);
  auraMat.color.copy(c);
  postMat.emissive.copy(c);
  postMat.emissiveIntensity = 0.16;
  kick();
}

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
// envMapIntensity は環境マップ（buildEnvironmentTexture）の映り込みの強さ。
const postMat = new THREE.MeshStandardMaterial({ color: BRASS, metalness: 0.85, roughness: 0.24, envMapIntensity: 1.1, emissive: 0x000000, emissiveIntensity: 0 });
const axisMat = new THREE.MeshStandardMaterial({ color: 0xc2a876, metalness: 0.8, roughness: 0.28, envMapIntensity: 1.0 });
const jointMat = new THREE.MeshStandardMaterial({ color: 0xead9b4, metalness: 0.9, roughness: 0.18, envMapIntensity: 1.2 });

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
  // 柱はマスの境目（±0.5・±1.5）に立てて、各面の窓を 3×3 にする（外周 12 本）
  const R = FRAME_R, lines = [-R, -R / 3, R / 3, R];
  const posts = [];
  for (const x of lines) for (const z of lines) if (Math.abs(x) === R || Math.abs(z) === R) posts.push([x, z]);
  for (const [x, z] of posts) frameGroup.add(edgeBetween([x, Y0, z], [x, Y1, z], 0.07, postMat));
  frameGroup.add(edgeBetween([0, Y0, 0], [0, Y1, 0], 0.14, axisMat)); // ふさがっている中心の軸
  const corners = [[-R, -R], [R, -R], [R, R], [-R, R]];
  for (const y of lines) {
    for (let i = 0; i < 4; i++) {
      const [x1, z1] = corners[i], [x2, z2] = corners[(i + 1) % 4];
      frameGroup.add(edgeBetween([x1, y, z1], [x2, y, z2], 0.05, postMat));
    }
  }
  // 柱の四隅の端に小さな面取りの金具を付けて、組み立てた機械らしくする（角のみ。中の柱は素通し）
  const jointGeo = new THREE.IcosahedronGeometry(0.1, 1);
  for (const y of [Y0, Y1]) {
    for (const [x, z] of corners) {
      const j = new THREE.Mesh(jointGeo, jointMat);
      j.position.set(x, y, z);
      frameGroup.add(j);
    }
    // 中心軸の上下の端にも小さなキャップ
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), jointMat);
    cap.position.set(0, y, 0);
    frameGroup.add(cap);
  }
  // 側面をふさぐ 1 枚のガラス箱（内側だけ描く BackSide）。4 枚の板を別々に置くと、斜めから
  // 見たときに板どうしが重なって格子状のちらつきが出たので、継ぎ目のない 1 個の箱にした。
  // フレネル風のシェーダーで、面を正面から見ると透け、縁（視線が斜めになる場所）ほど明るくする。
  const panelMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(BRASS) } },
    vertexShader: `
      varying vec3 vNormal; varying vec3 vViewPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec3 vNormal; varying vec3 vViewPosition;
      void main() {
        float fresnel = pow(1.0 - clamp(abs(dot(normalize(vNormal), normalize(vViewPosition))), 0.0, 1.0), 2.4);
        gl_FragColor = vec4(uColor, 0.03 + fresnel * 0.5);
      }
    `,
  });
  panelGroup.add(new THREE.Mesh(new THREE.BoxGeometry(PANEL_SIZE, PANEL_SIZE, PANEL_SIZE), panelMat));
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
// 表示は箱をドラッグしている間だけ。指に一番近い、落とせる入口だけを明るく光らせる
// （ほかの落とせる入口は暗いまま、いっぱいの列はそもそも出さない）。
function updateMarkers() {
  const show = handDrag != null && !!game;
  for (const m of markerGroup.children) {
    const enabled = show && G.canDrop(game.board, m.userData.col);
    m.userData.enabled = enabled;
    m.visible = enabled;
    m.material = enabled && handDrag.hoverCol === m.userData.col ? markerMatOn : markerMatOff;
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
  // くぼんで刻印されたように見せる: 右下に薄い影、左上に薄いハイライトをずらして重ねる
  x.font = `${W * 0.52}px system-ui`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  const mx = W / 2, my = W / 2 + W * 0.03;
  x.fillStyle = 'rgba(255,255,255,0.22)';
  x.fillText(COLOR_META[color].mark, mx - 1.5, my - 1.5);
  x.fillStyle = 'rgba(0,0,0,0.58)';
  x.fillText(COLOR_META[color].mark, mx + 1, my + 1);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  cubeTexCache.set(color, t);
  return t;
}
const cubeMatCache = new Map();
function cubeMaterial(color, ghost) {
  const key = `${color}-${ghost}`;
  if (cubeMatCache.has(key)) return cubeMatCache.get(key);
  // MeshPhysicalMaterial の clearcoat で、樹脂のような薄いつやを箱の表面に乗せる
  const m = new THREE.MeshPhysicalMaterial({
    map: cubeTexture(color), roughness: 0.5, metalness: 0.05,
    clearcoat: 0.55, clearcoatRoughness: 0.28, envMapIntensity: 0.55,
  });
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

// ---- 勝ったときに、そろった箱を光らせる。線をつなぐ光の筋と、舞う光の粒も添える ----
let winMeshes = [];
let winPulsing = false;
const winFxGroup = new THREE.Group();
cageGroup.add(winFxGroup);
// depthTest しない: 箱の内側を筋が通っても、箱に隠れず光って見えるように
const winBeamMat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
function sparkleTexture() {
  const W = 32, cv = document.createElement('canvas');
  cv.width = cv.height = W;
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.4, 'rgba(255,225,170,0.55)');
  g.addColorStop(1, 'rgba(255,225,170,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, W);
  return new THREE.CanvasTexture(cv);
}
let sparklePoints = null, sparkleBase = [], sparklePhase = [];
function clearWinFx() {
  winFxGroup.clear();
  sparklePoints = null; sparkleBase = []; sparklePhase = [];
}
function highlightWin(lines) {
  clearWinFx();
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
  // 線をつなぐ光の筋（各線は 3 マス = 隣どうし 2 本）
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [c1, t1] = [Math.floor(line[i] / 3), line[i] % 3];
      const [c2, t2] = [Math.floor(line[i + 1] / 3), line[i + 1] % 3];
      winFxGroup.add(edgeBetween(cellPos(c1, t1), cellPos(c2, t2), 0.07, winBeamMat));
    }
  }
  // 舞う光の粒（そろったマスの近くに少しだけ）
  if (!reduced.matches) {
    const positions = [];
    for (const i of idxSet) {
      const [c, t] = [Math.floor(i / 3), i % 3];
      const [px, py, pz] = cellPos(c, t);
      for (let n = 0; n < 2; n++) {
        const bx = px + (Math.random() - 0.5) * 0.7, by = py + (Math.random() - 0.5) * 0.5, bz = pz + (Math.random() - 0.5) * 0.7;
        sparkleBase.push([bx, by, bz]);
        sparklePhase.push(Math.random() * Math.PI * 2);
        positions.push(bx, by, bz);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ size: 0.16, map: sparkleTexture(), transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    sparklePoints = new THREE.Points(geo, mat);
    winFxGroup.add(sparklePoints);
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
    winBeamMat.opacity = 0.3 + 0.3 * Math.sin(now / 260 + 1);
    if (sparklePoints) {
      const pos = sparklePoints.geometry.attributes.position;
      for (let i = 0; i < sparkleBase.length; i++) {
        const [bx, by, bz] = sparkleBase[i];
        const ph = sparklePhase[i] + now / 900;
        pos.setXYZ(i, bx + Math.sin(ph) * 0.05, by + ((now / 900 + sparklePhase[i]) % 1) * 0.5, bz + Math.cos(ph) * 0.05);
      }
      pos.needsUpdate = true;
    }
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
// 画面上での位置（かご中心・入口）。ドラッグ中の指の下に一番近い入口を、多少ずれていても選べるように
// raycast ではなく「投影した位置との距離」で選ぶ（指で隠れて真下に入口が無いことが多いスマホ向け）。
function projectToScreen(worldPos) {
  const p = worldPos.clone().project(camera);
  const r = sceneCanvas.getBoundingClientRect();
  return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
}
function markerScreenPos(col) {
  const wp = new THREE.Vector3();
  markerGroup.children[col].getWorldPosition(wp);
  return projectToScreen(wp);
}
function pickEntryNear(x, y) {
  const r = sceneCanvas.getBoundingClientRect();
  const maxDist = Math.min(r.width, r.height) * 0.22; // 甘めの当たり判定
  let best = null, bestD = Infinity;
  for (let col = 0; col < 8; col++) {
    if (!G.canDrop(game.board, col)) continue;
    const p = markerScreenPos(col);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = col; }
  }
  return bestD <= maxDist ? best : null;
}
function cageCenterScreenX() {
  const wp = new THREE.Vector3();
  cageGroup.getWorldPosition(wp);
  return projectToScreen(wp).x;
}
function pickTier(x, y) {
  raycaster.setFromCamera(ndc(x, y), camera);
  const targets = [...frameGroup.children, ...panelGroup.children, ...boxes.filter(Boolean)];
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return null;
  const local = cageGroup.worldToLocal(hit.point.clone());
  return Math.max(0, Math.min(2, Math.round(local.y + 1)));
}

// 段は「かごをタップ」で直接決める。動かさずに離すと、離した位置がかごの中心より
// 右なら右回り・左なら左回りで、その場で回す（決定は挟まない）。動かせば、いつもどおり視点が回る。
let dragState = null;
sceneCanvas.addEventListener('pointerdown', (e) => {
  sceneCanvas.setPointerCapture(e.pointerId);
  let hit = null;
  if (!busy && game && !game.over && !handDrag && !pendingFlip) {
    const tier = pickTier(e.clientX, e.clientY);
    if (tier != null) { hit = { tier }; highlightTier(tier); }
  }
  dragState = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, hit, moved: false };
  kick();
});
sceneCanvas.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.x, dy = e.clientY - dragState.y;
  dragState.x = e.clientX; dragState.y = e.clientY;
  if (!dragState.moved && Math.hypot(e.clientX - dragState.x0, e.clientY - dragState.y0) > 8) {
    dragState.moved = true;
    if (dragState.hit) highlightTier(null); // 動いたら視点回転に切り替え、光は消す
  }
  if (!dragState.hit || dragState.moved) {
    orbit.theta -= dx * 0.008;
    orbit.phi = Math.max(PHI_MIN, Math.min(PHI_MAX, orbit.phi - dy * 0.008));
    kick();
  }
});
function endDrag(e) {
  const ds = dragState;
  dragState = null;
  if (!ds) { kick(); return; }
  if (ds.moved || !ds.hit || busy) { highlightTier(null); kick(); return; }
  const dir = e.clientX >= cageCenterScreenX() ? 1 : -1;
  const move = { type: 'rotate', tier: ds.hit.tier, dir };
  highlightTier(null);
  if (G.isLegal(game, move)) { $('notice').textContent = ''; commit(move); }
  else { Sound.bad(); $('notice').textContent = BANNED_MOVE_MSG; kick(); }
}
sceneCanvas.addEventListener('pointerup', endDrag);
sceneCanvas.addEventListener('pointercancel', () => { dragState = null; highlightTier(null); kick(); });

$('view-reset').addEventListener('click', () => { orbit = { ...HOME }; Sound.select(); kick(); });

// ---- 重力で落ちる分だけ、位置をなめらかに動かす ----
// ---- 着地の光の輪（箱が落ちた場所に、広がって消える輪） ----
function spawnLandingRing(x, y, z) {
  const geo = new THREE.RingGeometry(0.26, 0.38, 24);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(geo, mat);
  ring.position.set(x, y - 0.39, z);
  ring.rotation.x = -Math.PI / 2;
  cubesGroup.add(ring);
  tween(320, (p) => {
    const s = 1 + p * 1.5;
    ring.scale.set(s, s, s);
    mat.opacity = 0.6 * (1 - p);
  }).then(() => ring.removeFromParent());
}

// ---- 返すときに、かご全体を上から下へ通り抜ける光の筋（世界座標に置くので、かごの回転につられない） ----
const flipStreakMat = new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
const flipStreak = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_SIZE * 1.15, PANEL_SIZE * 1.15), flipStreakMat);
flipStreak.rotation.x = -Math.PI / 2;
flipStreak.visible = false;
scene.add(flipStreak);
function updateFlipStreak(p) {
  flipStreak.visible = true;
  flipStreak.position.y = FRAME_R * 1.25 - p * FRAME_R * 2.5;
  flipStreakMat.opacity = Math.sin(Math.min(1, p) * Math.PI) * 0.45;
}
function hideFlipStreak() { flipStreak.visible = false; flipStreakMat.opacity = 0; }

// ---- 物理っぽい落下（自由落下してから、小さく 1〜2 回はねて止まる） ----
// 本物の物理エンジンは使わず、区間ごとに y = h0 − ½g t² の放物線をつないで近似する。
// ponytail: 簡易な 2 回はねモデル（水平方向の物理はなし）。もっと本物らしくしたければ
// 速度を積分する本当の物理シミュレーションに差し替える。値はここ 1 か所にまとめてある。
const FALL_G = 60;          // 世界の単位/秒²
const FALL_BOUNCE_E = 0.3;  // 反発係数
const FALL_MAX_BOUNCES = 2;

function buildFallProfile(height) {
  const h0 = Math.max(0, height);
  const t0 = Math.sqrt((2 * Math.max(h0, 0.001)) / FALL_G);
  const segs = [{ start: 0, dur: t0, kind: 'drop', h0 }];
  let t = t0, h = h0 * FALL_BOUNCE_E ** 2, n = 0;
  while (h > 0.015 && n < FALL_MAX_BOUNCES) {
    const vUp = Math.sqrt(2 * FALL_G * h);
    const dur = (2 * vUp) / FALL_G;
    segs.push({ start: t, dur, kind: 'bounce', vUp });
    t += dur;
    h *= FALL_BOUNCE_E ** 2;
    n += 1;
  }
  return { segs, total: t };
}
function fallHeightAt(profile, elapsed) {
  const segs = profile.segs;
  let s = segs[segs.length - 1];
  for (const seg of segs) if (elapsed <= seg.start + seg.dur) { s = seg; break; }
  const dt = Math.max(0, elapsed - s.start);
  if (s.kind === 'drop') return Math.max(0, s.h0 - 0.5 * FALL_G * dt * dt);
  return Math.max(0, s.vUp * dt - 0.5 * FALL_G * dt * dt);
}
// mesh を fromY → toY へ物理っぽく落とす。onLand は最初に着地面に触れた瞬間に 1 度だけ呼ばれる
// （光の輪・つぶれの合図に使う）。reduced-motion のときは、はねなしで短く落ちるだけにする。
async function dropMesh(mesh, fromY, toY, onLand) {
  if (reduced.matches) {
    await tween(80, (p) => { mesh.position.y = fromY + (toY - fromY) * easeOutCubic(p); });
    mesh.position.y = toY;
    onLand?.();
    return;
  }
  const profile = buildFallProfile(fromY - toY);
  let landed = false;
  await tween(Math.max(60, profile.total * 1000), (p) => {
    const elapsed = p * profile.total;
    mesh.position.y = toY + fallHeightAt(profile, elapsed);
    if (!landed && elapsed >= profile.segs[0].dur) { landed = true; onLand?.(); }
  });
  mesh.position.y = toY;
  if (!landed) onLand?.();
}

async function animateGravitySettle(fromBoard, toBoard) {
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
  await Promise.all(moves.map(({ mesh, fromY, toY }) => dropMesh(mesh, fromY, toY)));
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
  const rotEase = reduced.matches ? easeOutCubic : easeOutBack;
  await tween(dur, (p) => pivot.quaternion.setFromAxisAngle(Y_AXIS, angle * rotEase(p)));
  pivot.removeFromParent();
  const rotatedNoGravity = G.rotateBoard(beforeBoard, move.tier, move.dir);
  snap(rotatedNoGravity, ghost);
  const afterGravity = G.gravity(rotatedNoGravity);
  await animateGravitySettle(rotatedNoGravity, afterGravity);
}

// ---- 落とす: 上から物理っぽく落ちる ----
async function animPlayDrop(beforeBoard, move) {
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
  await dropMesh(mesh, fromY, toY, () => {
    if (reduced.matches) return;
    spawnLandingRing(x, toY, z);
    tween(160, (p) => {
      const s = 1 - Math.sin(p * Math.PI) * 0.14;
      mesh.scale.set(1 + (1 - s) * 0.35, s, 1 + (1 - s) * 0.35); // 着地で小さくつぶれてから戻る
    }).then(() => mesh.scale.set(1, 1, 1));
  });
}

// ---- 返す: かご全体が 180° 回ってから、箱が落ち直す ----
async function animPlayFlip(beforeBoard, afterBoard, dur) {
  clearGhost();
  snap(beforeBoard, false);
  const flipEase = reduced.matches ? easeInOutCubic : easeInOutBack;
  await tween(dur, (p) => {
    cageGroup.quaternion.setFromAxisAngle(X_AXIS, Math.PI * flipEase(p));
    if (!reduced.matches) updateFlipStreak(p);
  });
  hideFlipStreak();
  cageGroup.quaternion.identity();
  const noGravity = G.flipBoard(beforeBoard);
  snap(noGravity, false);
  await animateGravitySettle(noGravity, afterBoard);
  snap(afterBoard, false);
}

// ==========================================================================
// ---- 対局 ----
// ==========================================================================
let game = null;
let pendingFlip = false;  // 「返す」の確認中か
let busy = false;
let animToken = 0;        // 進行中のアニメを無効にするための合いことば
let lastSnapshot = null;  // 「戻る」用に、直前の commit の前の game を 1 手分だけ持っておく
let handDrag = null;      // 手持ちの箱をドラッグ中の状態 { color, pointerId, el, ghost, hoverCol }

function loadGame() {
  const g = load('game', null);
  if (!g || g.over || !G.PLAYER_COLORS[g.players]) return null;
  return g;
}
function persist() {
  if (game && !game.over) save('game', game); else clear('game');
}

function resetScenePreview() {
  animToken++;
  clearGhost();
  highlightTier(null);
  if (game) snap(game.board, false);
}

// ---- 手持ちの箱（ドラッグ元）。落とすは「箱を押さえてかごの上へドラッグし、離す」だけ ----
function renderHand() {
  const box = $('hand');
  box.innerHTML = '';
  if (!game || game.over) return;
  const hand = game.hand[game.turn];
  Object.entries(hand).forEach(([color, n]) => {
    color = +color;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'colorbtn';
    b.disabled = n <= 0 || busy;
    b.style.setProperty('--c', COLOR_META[color].hex);
    b.innerHTML = `<span class="colorbtn__mark">${COLOR_META[color].mark}</span><span class="colorbtn__n">${n}</span>`;
    b.addEventListener('pointerdown', (e) => startHandDrag(e, b, color));
    box.append(b);
  });
}

function startHandDrag(e, el, color) {
  if (busy || !game || game.over || handDrag) return;
  e.preventDefault();
  if (pendingFlip) { pendingFlip = false; render(); }
  el.setPointerCapture(e.pointerId);
  const ghost = document.createElement('div');
  ghost.className = 'colorbtn colorbtn--ghost';
  ghost.style.setProperty('--c', COLOR_META[color].hex);
  ghost.innerHTML = `<span class="colorbtn__mark">${COLOR_META[color].mark}</span>`;
  document.body.append(ghost);
  handDrag = { color, pointerId: e.pointerId, el, ghost, hoverCol: null };
  positionGhost(e.clientX, e.clientY);
  Sound.select();
  updateMarkers();
  el.addEventListener('pointermove', onHandDragMove);
  el.addEventListener('pointerup', onHandDragEnd);
  el.addEventListener('pointercancel', onHandDragEnd);
}
function positionGhost(x, y) {
  handDrag.ghost.style.left = `${x}px`;
  handDrag.ghost.style.top = `${y}px`;
}
function onHandDragMove(e) {
  if (!handDrag || e.pointerId !== handDrag.pointerId) return;
  positionGhost(e.clientX, e.clientY);
  const col = pickEntryNear(e.clientX, e.clientY);
  if (col !== handDrag.hoverCol) {
    handDrag.hoverCol = col;
    updateMarkers();
    updateDropGhostPreview(col, handDrag.color);
  }
}
function updateDropGhostPreview(col, color) {
  clearGhost();
  if (col == null) { kick(); return; }
  const tier = [0, 1, 2].find((t) => game.board[G.idx(col, t)] === G.EMPTY);
  if (tier == null) return;
  const mesh = makeCube(color, true);
  mesh.position.set(...cellPos(col, tier));
  cubesGroup.add(mesh);
  ghostMeshes.push(mesh);
  kick();
}
function endHandDragListeners(el) {
  el.removeEventListener('pointermove', onHandDragMove);
  el.removeEventListener('pointerup', onHandDragEnd);
  el.removeEventListener('pointercancel', onHandDragEnd);
}
function onHandDragEnd(e) {
  if (!handDrag || e.pointerId !== handDrag.pointerId) return;
  const { color, hoverCol, ghost, el } = handDrag;
  endHandDragListeners(el);
  clearGhost();
  handDrag = null;
  updateMarkers();
  if (hoverCol != null) {
    const move = { type: 'drop', color, col: hoverCol };
    if (G.isLegal(game, move)) { ghost.remove(); $('notice').textContent = ''; commit(move); return; }
  }
  returnGhostHome(ghost, el);
  render();
}
// 入口から外れた所で離したら、指を離した所から手持ちの元の位置へふわっと戻す
function returnGhostHome(ghost, el) {
  if (reduced.matches) { ghost.remove(); return; }
  const r = el.getBoundingClientRect();
  ghost.style.transition = 'left 0.22s cubic-bezier(.2,.8,.2,1), top 0.22s cubic-bezier(.2,.8,.2,1), transform 0.22s';
  ghost.style.left = `${r.left + r.width / 2}px`;
  ghost.style.top = `${r.top + r.height / 2}px`;
  ghost.style.transform = 'translate(-50%, -50%) scale(0.85)';
  ghost.addEventListener('transitionend', () => ghost.remove(), { once: true });
  setTimeout(() => ghost.remove(), 260); // 保険（transitionend が来ない環境向け）
}

// ---- 返す（確認してから） ----
$('actions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="flip"]');
  if (!b || busy || pendingFlip) return;
  const move = { type: 'flip' };
  if (!G.isLegal(game, move)) { Sound.bad(); $('notice').textContent = BANNED_MOVE_MSG; return; }
  pendingFlip = true;
  $('notice').textContent = '';
  Sound.select();
  render();
});
$('decide').addEventListener('click', () => {
  if (!pendingFlip || busy) return;
  pendingFlip = false;
  commit({ type: 'flip' });
});
$('cancel').addEventListener('click', () => {
  pendingFlip = false;
  $('notice').textContent = '';
  render();
});

// ---- 戻る（直前の 1 手だけ取り消す） ----
$('undo').addEventListener('click', () => {
  if (busy || !lastSnapshot || !game || game.over) return;
  game = lastSnapshot;
  lastSnapshot = null;
  pendingFlip = false;
  resetScenePreview();
  persist();
  Sound.select();
  render();
});

async function commit(move) {
  const before = game;
  lastSnapshot = structuredClone(before); // 「戻る」用。1 手分だけでよい
  busy = true;
  render();
  const afterState = G.applyMove(before, move);
  const dur = reduced.matches ? 70 : 320;
  animToken++;
  clearGhost();
  if (move.type === 'drop') { Sound.land(); await animPlayDrop(before.board, move); }
  else if (move.type === 'rotate') { Sound.rotate(); await animRotatePhysical(before.board, move, dur, false); }
  else { Sound.flip(); await animPlayFlip(before.board, afterState.board, dur); }
  snap(afterState.board, false); // アニメの内部で見た目がずれても、確定時に必ず作り直す
  game = afterState;
  pendingFlip = false;
  highlightTier(null);
  persist();
  busy = false;
  if (game.over) finish(before); else render();
}

// ---- 画面の描画（文字・ボタン。かごの中身はここでは書き換えない） ----
function render() {
  if (!game) return;
  const moverColors = G.PLAYER_COLORS[game.players][game.turn];

  $('turn-text').textContent = game.over ? '' : `${playerName(game.turn)} の番`;
  if (!game.over) {
    const hex = COLOR_META[moverColors[0]].hex;
    $('game').style.setProperty('--pc', hex);
    setPlayerGlow(hex);
  }

  renderHand();

  $('flip-confirm').hidden = !pendingFlip;

  $('actions').hidden = game.over; // 結果カードの左右から操作ボタンがのぞかないように
  $('actions').querySelectorAll('[data-act]').forEach((b) => { b.disabled = busy || pendingFlip; });

  $('undo').disabled = busy || !lastSnapshot || game.over;

  if (game.afterEmpty != null && !game.over) {
    $('notice').textContent = `あと ${game.afterEmpty} 手で引き分け`;
  } else if (!pendingFlip) {
    $('notice').textContent = '';
  }

  updateMarkers();
}

// ---- 結果 ----
function finish(before) {
  const r = $('result');
  const isWin = !game.draw && game.winLines.length;
  $('turn-text').textContent = '';
  if (isWin) highlightWin(game.winLines); // 先にそろった箱・光の筋・光の粒を出す

  const reveal = () => {
    if (game.draw) {
      $('result-head').textContent = '引き分け';
      $('result-head').style.color = '';
      $('game').style.setProperty('--pc', 'var(--brass)');
      setPlayerGlow('#d8c49a');
      Sound.draw();
    } else {
      const owner = game.winner;
      const colors = G.PLAYER_COLORS[game.players][owner];
      const hex = COLOR_META[colors[0]].hex;
      $('result-head').textContent = `${playerName(owner)} の勝ち`;
      $('result-head').style.color = hex;
      $('game').style.setProperty('--pc', hex);
      setPlayerGlow(hex);
      Sound.win();
    }
    $('result-moves').textContent = `${game.moves} 手`;
    r.hidden = false;
    const buttons = r.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    setTimeout(() => buttons.forEach((b) => { b.disabled = false; }), 400);
    render();
  };
  // 勝ったときは、光の演出を少し見せてから結果カードを出す
  if (isWin && !reduced.matches) setTimeout(reveal, 700); else reveal();
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
  clearWinFx();
  orbit = { ...HOME };
  show('game');
  snap(game.board, false);
  fitView();
  render();
}

function startGame(players) {
  game = G.newGame(players);
  pendingFlip = false;
  lastSnapshot = null;
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
  pendingFlip = false;
  lastSnapshot = null;
  busy = false;
  enterGame();
});

function toTitle() {
  game = null;
  animToken++;
  winPulsing = false;
  clearWinFx();
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
window.__dtDebug = { ground, panelGroup, frameGroup, markerGroup, cubesGroup, tierHighlightMesh, scene, camera, kick };
