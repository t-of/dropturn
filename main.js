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
const FACE_NAMES = ['前', '右', '奥', '左'];
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

// ---- 対局 ----
let game = null;
let mode = null;          // 'drop' | 'rotate' | 'flip' | null（選んでいる手の種類）
let pendingColor = null;
let pendingTier = null;
let pendingMove = null;   // 確定前の、予告している手
let busy = false;
let viewRot = 0;          // 斜めの図の見る向き（⟲ で 0〜3）

function loadGame() {
  const g = load('game', null);
  if (!g || g.over || !G.PLAYER_COLORS[g.players]) return null;
  return g;
}

function persist() {
  if (game && !game.over) save('game', game); else clear('game');
}

// ---- 斜めの図（Canvas 2D、見るだけ） ----
const cageCanvas = $('cage');
const cageCtx = cageCanvas.getContext('2d');
const titleCanvas = $('title-cage');
const titleCtx = titleCanvas.getContext('2d');

function drawCage(ctx, w, h, board, rot) {
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
    for (let t = 0; t < 3; t++) {
      const boardCol = (k + rot * 2) % 8;
      cells.push({ x, z, t, color: board[G.idx(boardCol, t)], depth: x + z - t });
    }
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

function renderCage() {
  const board = pendingMove ? G.previewBoard(game, pendingMove) : game.board;
  drawCage(cageCtx, cageCanvas.width, cageCanvas.height, board, viewRot);
}

$('spin').addEventListener('click', () => { viewRot = (viewRot + 1) % 4; Sound.select(); renderCage(); });

// タイトルの見本: そこそこ箱が入った、そろっていないかご
function demoCage() {
  let b = G.newBoard();
  const cols = [0, 1, 2, 3, 4, 5, 6, 7];
  let n = 0;
  for (const c of cols) {
    const h = (c * 37 + 11) % 3;
    for (let t = 0; t <= h && n < 15; t++, n++) b = G.drop(b, c, (c + t) % 6);
  }
  drawCage(titleCtx, titleCanvas.width, titleCanvas.height, b, 0);
}
demoCage();

// ---- 帯（展開図） ----
const bandHeads = $('band-heads');
const bandDrops = $('band-drops');
const bandEl = $('band');
const cells = [];   // [tier][displayCol] のボタン（displayCol 0..8、8 は 0 の再掲）

function displayColToBoard(dc) { return dc % 8; }

function buildBand() {
  bandHeads.innerHTML = '';
  bandDrops.innerHTML = '';
  bandEl.innerHTML = '';
  for (let dc = 0; dc < 9; dc++) {
    const head = document.createElement('span');
    head.className = 'band__head';
    // 面の真ん中の列にだけ名前を出す（角の列は 2 つの面にまたがるので空ける）
    const mid = [1, 3, 5, 7].indexOf(dc % 8);
    head.textContent = mid >= 0 ? FACE_NAMES[mid] : '';
    bandHeads.append(head);

    const arrow = document.createElement('button');
    arrow.className = 'band__drop';
    arrow.textContent = '▼';
    arrow.dataset.col = dc;
    arrow.addEventListener('click', () => onColumnPick(displayColToBoard(dc)));
    bandDrops.append(arrow);
  }
  for (let tier = 2; tier >= 0; tier--) {
    const row = [];
    for (let dc = 0; dc < 9; dc++) {
      const b = document.createElement('button');
      b.className = 'band__cell';
      b.dataset.tier = tier;
      b.dataset.col = dc;
      b.addEventListener('click', () => onCellPick(displayColToBoard(dc), tier));
      bandEl.append(b);
      row[dc] = b;
    }
    cells[tier] = row;
  }
}
buildBand();

function onColumnPick(col) {
  if (mode === 'drop' && pendingColor != null) trySetMove({ type: 'drop', color: pendingColor, col });
}
function onCellPick(col, tier) {
  if (mode === 'drop' && pendingColor != null) trySetMove({ type: 'drop', color: pendingColor, col });
  else if (mode === 'rotate' && pendingTier == null) selectTier(tier);
}

function selectTier(tier) {
  pendingTier = tier;
  Sound.select();
  $('rotate-hint').textContent = `${['下', '中', '上'][tier]}の段。向きを選ぶ`;
  $('dirs').hidden = false;
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
}

function reasonFor(move) {
  if (move.type === 'drop') return 'その列はいっぱいです';
  return '1 手前に戻す手、または何も変わらない手は指せません';
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
  render();
});

function commit(move) {
  busy = true;
  const before = game;
  game = G.applyMove(game, move);
  if (move.type === 'drop') Sound.land();
  else if (move.type === 'rotate') Sound.rotate();
  else Sound.flip();
  mode = null; pendingColor = null; pendingTier = null; pendingMove = null;
  persist();
  const dur = reduced.matches ? 60 : 260;
  setTimeout(() => {
    busy = false;
    if (game.over) finish(before);
    else render();
  }, dur);
}

// ---- 画面の描画 ----
function render() {
  if (!game) return;
  const board = pendingMove ? G.previewBoard(game, pendingMove) : game.board;
  const moverColors = G.PLAYER_COLORS[game.players][game.turn];

  $('turn').textContent = game.over ? '' : `${playerName(game.turn)} の番`;
  $('turn').style.color = game.over ? '' : COLOR_META[moverColors[0]].hex;

  for (let tier = 0; tier < 3; tier++) for (let dc = 0; dc < 9; dc++) {
    const col = displayColToBoard(dc);
    const v = board[G.idx(col, tier)];
    const cell = cells[tier][dc];
    cell.textContent = v >= 0 ? COLOR_META[v].mark : '';
    cell.style.setProperty('--c', v >= 0 ? COLOR_META[v].hex : 'transparent');
    cell.classList.toggle('filled', v >= 0);
    cell.classList.toggle('ghost', !!pendingMove);
    cell.classList.toggle('win', game.over && game.winLines.some((l) => l.includes(G.idx(col, tier))));
    cell.disabled = game.over;
  }
  bandDrops.querySelectorAll('.band__drop').forEach((a) => {
    const col = displayColToBoard(+a.dataset.col);
    a.disabled = game.over || !G.canDrop(game.board, col);
  });

  $('sub-drop').hidden = mode !== 'drop';
  $('sub-rotate').hidden = mode !== 'rotate';
  $('sub-flip').hidden = mode !== 'flip';
  if (mode === 'drop') renderColors();
  if (mode === 'rotate' && pendingTier == null) { $('rotate-hint').textContent = '回す段（帯の行）をタップ'; $('dirs').hidden = true; }

  $('decide').hidden = !pendingMove;
  $('cancel').hidden = !mode;

  const moves = G.legalMoves(game);
  const canDropAny = moves.some((m) => m.type === 'drop');
  $('actions').querySelector('[data-act="drop"]').disabled = !canDropAny;

  if (game.afterEmpty != null && !game.over) {
    $('notice').textContent = `あと ${game.afterEmpty} 手で引き分け`;
  } else if (!pendingMove) {
    $('notice').textContent = '';
  }

  renderCage();
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

function startGame(players) {
  game = G.newGame(players);
  mode = null; pendingColor = null; pendingTier = null; pendingMove = null;
  busy = false;
  $('result').hidden = true;
  persist();
  show('game');
  render();
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
  show('game');
  render();
});

function toTitle() {
  game = null;
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
