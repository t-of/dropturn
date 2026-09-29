// エクストラルールの遊びの中身（軸なし・3×3×3 = 27 マス）。DOM には触らない。
// 公式ルール（game.js）とは盤の形が違うので別ファイルにした。色・人数の割り当てだけ game.js を使い回す。
//
// マス = idx(x, y, z)。x は左右 0..2、y は上下（重力の向き）0..2、z は前後 0..2。軸はなく、27 マスすべてに箱が入る。
// 落とす入口は上面の 9 列（x, z の組）すべて。

import { PLAYER_COLORS, colorOwner, boardsEqual } from './game.js';
export { PLAYER_COLORS, colorOwner, boardsEqual };

export const EMPTY = -1;
export const N = 3;
export const TOTAL = N * N * N;
export const idx = (x, y, z) => x * 9 + y * 3 + z;
export const coordsOf = (i) => ({ x: Math.floor(i / 9), y: Math.floor(i / 3) % 3, z: i % 3 });

// 49 本の勝ちの線: 3 成分が -1..1 の向きベクトルのうち、正準形（最初の非 0 が正）だけを使い、
// 各向きで盤に収まる始点をすべて拾う（各方向・重複ぶんを二重に数えない）。
export const LINES = buildLines();
function buildLines() {
  const dirs = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    const first = [dx, dy, dz].find((v) => v !== 0);
    if (first < 0) continue;
    dirs.push([dx, dy, dz]);
  }
  const lines = [];
  for (const [dx, dy, dz] of dirs) {
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
      const x2 = x + 2 * dx, y2 = y + 2 * dy, z2 = z + 2 * dz;
      if (x2 < 0 || x2 >= N || y2 < 0 || y2 >= N || z2 < 0 || z2 >= N) continue;
      lines.push([idx(x, y, z), idx(x + dx, y + dy, z + dz), idx(x2, y2, z2)]);
    }
  }
  return lines; // 27(軸) + 18(面の斜め) + 4(立体の対角線) = 49 本
}

// 手持ちは公式と同じ 24 個（人数でも色数でも割り切れて、全員が同じ数を持つ）。27 マスのうち 3 マスは空いたまま
const HAND_TOTAL = 24;
function initHand(players) {
  const groups = PLAYER_COLORS[players];
  const n = HAND_TOTAL / players / groups[0].length;
  return groups.map((colors) => Object.fromEntries(colors.map((c) => [c, n])));
}

export function newBoard() { return new Array(TOTAL).fill(EMPTY); }

// 列(x,z)は常に「下から詰まっている」前提（drop・gravity のあとの不変条件）
export const canDrop = (board, x, z) => board[idx(x, 2, z)] === EMPTY;

export function drop(board, x, z, color) {
  const b = board.slice();
  for (let y = 0; y < N; y++) {
    if (b[idx(x, y, z)] === EMPTY) { b[idx(x, y, z)] = color; return b; }
  }
  throw new Error('その列は満杯です');
}

// 3×3 の平面を 90° 回す（中心も含む）。dir=+1: (a,b) → (b, 2−a)、dir=-1: その逆
function rotate90(a, b, dir) { return dir === 1 ? [b, 2 - a] : [2 - b, a]; }

// axis に垂直な、layer 番目の 1 枚（9 マス）だけを 90° 回す。ほかのマスはそのまま。重力はかけない
export function rotateSlice(board, axis, layer, dir) {
  const b = new Array(TOTAL).fill(EMPTY);
  for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
    const v = board[idx(x, y, z)];
    let nx = x, ny = y, nz = z;
    if (axis === 'y' && y === layer) { const [a, c] = rotate90(x, z, dir); nx = a; nz = c; }
    else if (axis === 'x' && x === layer) { const [a, c] = rotate90(y, z, dir); ny = a; nz = c; }
    else if (axis === 'z' && z === layer) { const [a, c] = rotate90(x, y, dir); nx = a; ny = c; }
    b[idx(nx, ny, nz)] = v;
  }
  return b;
}

// かご全体を axis まわりに 90° 回す（3 枚すべてを同じ向きに回す）。重力はかけない
export function rotateWhole(board, axis, dir) {
  let b = board;
  for (let layer = 0; layer < N; layer++) b = rotateSlice(b, axis, layer, dir);
  return b;
}

// 「返す」= 上下 180°（x 軸まわりに 90° を 2 回。公式の返す＝上下反転＋前後反転と同じ形になる）
export function flipBoard(board) { return rotateWhole(rotateWhole(board, 'x', 1), 'x', 1); }

// 4 つの「倒す」の元になる、向きだけの一覧（画面に出す方向の名前は main.js が視点から決める）
export const EDGE_TILTS = [
  { axis: 'x', dir: 1 }, { axis: 'x', dir: -1 },
  { axis: 'z', dir: 1 }, { axis: 'z', dir: -1 },
];

// 「下にしたい面」（局所座標のどちらの端か。x-/x+/y+/z-/z+）→ その面が下（y=0）に来る手。
// rotateWhole の座標の対応から出した固定の対応（y- は今も下なので選べない＝キーを持たない）。
export const FACE_TILT = {
  'z-': { type: 'tilt', axis: 'x', dir: 1 },
  'z+': { type: 'tilt', axis: 'x', dir: -1 },
  'x+': { type: 'tilt', axis: 'z', dir: 1 },
  'x-': { type: 'tilt', axis: 'z', dir: -1 },
  'y+': { type: 'flip' },
};

// 各列、下が空いていれば順番を保ったまま詰める
export function gravity(board) {
  const b = newBoard();
  for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
    const vals = [0, 1, 2].map((y) => board[idx(x, y, z)]).filter((v) => v !== EMPTY);
    vals.forEach((v, y) => { b[idx(x, y, z)] = v; });
  }
  return b;
}

// ---- 対局 ----

export function newGame(players, rng = Math.random) {
  const first = Math.floor(rng() * players);
  return {
    v: 1, rules: 'extra', players, first, turn: first,
    board: newBoard(),
    hand: initHand(players),
    prev: null,
    afterEmpty: null,
    moves: 0,
    over: false, winner: null, draw: false, drawReason: null, winLines: [],
  };
}

const handEmpty = (h) => Object.values(h).every((v) => v === 0);

// かご全体を縦(y)軸まわりに 90° ずつ回しただけの違いは同じ局面とみなす（公式と同じ考え方）
function sameUpToTurn(a, b) {
  let x = a;
  for (let k = 0; k < 4; k++) {
    if (boardsEqual(x, b)) return true;
    x = rotateWhole(x, 'y', 1);
  }
  return false;
}

function isBanned(state, candidate) {
  if (sameUpToTurn(candidate, state.board)) return true;
  if (state.prev && sameUpToTurn(candidate, state.prev)) return true;
  return false;
}

export function previewBoard(state, move) {
  if (move.type === 'drop') return canDrop(state.board, move.x, move.z) ? drop(state.board, move.x, move.z, move.color) : state.board;
  if (move.type === 'rotate') return gravity(rotateSlice(state.board, move.axis, move.layer, move.dir));
  if (move.type === 'tilt') return gravity(rotateWhole(state.board, move.axis, move.dir));
  if (move.type === 'flip') return gravity(flipBoard(state.board));
  return state.board;
}

export function legalMoves(state) {
  if (state.over) return [];
  const moves = [];
  const hand = state.hand[state.turn];
  for (const [color, n] of Object.entries(hand)) {
    if (n <= 0) continue;
    for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) {
      if (canDrop(state.board, x, z)) moves.push({ type: 'drop', color: +color, x, z });
    }
  }
  for (const axis of ['x', 'y', 'z']) for (let layer = 0; layer < N; layer++) for (const dir of [1, -1]) {
    const b = gravity(rotateSlice(state.board, axis, layer, dir));
    if (!isBanned(state, b)) moves.push({ type: 'rotate', axis, layer, dir });
  }
  for (const { axis, dir } of EDGE_TILTS) {
    const b = gravity(rotateWhole(state.board, axis, dir));
    if (!isBanned(state, b)) moves.push({ type: 'tilt', axis, dir });
  }
  const flipped = gravity(flipBoard(state.board));
  if (!isBanned(state, flipped)) moves.push({ type: 'flip' });
  return moves;
}

const sameMove = (a, b) => a.type === b.type && a.color === b.color && a.x === b.x && a.z === b.z
  && a.axis === b.axis && a.layer === b.layer && a.dir === b.dir;
export const isLegal = (state, move) => legalMoves(state).some((m) => sameMove(m, move));

// 手番の人を優先。手番以外で 1 人だけそろっていればその人。2 人以上なら引き分け（公式と同じ考え方）
export function judgeBoard(board, players, mover) {
  const byColor = new Map();
  for (const line of LINES) {
    const v = board[line[0]];
    if (v !== EMPTY && line.every((i) => board[i] === v)) {
      if (!byColor.has(v)) byColor.set(v, []);
      byColor.get(v).push(line);
    }
  }
  if (!byColor.size) return null;
  const byOwner = new Map();
  for (const [color, lines] of byColor) {
    const owner = colorOwner(players, color);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(...lines);
  }
  if (byOwner.has(mover)) return { winner: mover, lines: byOwner.get(mover) };
  if (byOwner.size === 1) { const [[owner, lines]] = byOwner; return { winner: owner, lines }; }
  return { winner: null, draw: true, lines: [...byOwner.values()].flat() };
}

export function applyMove(state, move) {
  if (state.over) throw new Error('対局は終わっています');
  if (!isLegal(state, move)) throw new Error('その手は指せません');
  const mover = state.turn;
  const before = state.board;
  let board, hand = state.hand;

  if (move.type === 'drop') {
    board = drop(before, move.x, move.z, move.color);
    hand = state.hand.map((h, p) => (p === mover ? { ...h, [move.color]: h[move.color] - 1 } : h));
  } else if (move.type === 'rotate') {
    board = gravity(rotateSlice(before, move.axis, move.layer, move.dir));
  } else if (move.type === 'tilt') {
    board = gravity(rotateWhole(before, move.axis, move.dir));
  } else if (move.type === 'flip') {
    board = gravity(flipBoard(before));
  } else {
    throw new Error('不明な手です');
  }

  const moves = state.moves + 1;
  const result = judgeBoard(board, state.players, mover);
  let over = false, winner = null, draw = false, drawReason = null, winLines = [];
  let afterEmpty = state.afterEmpty;

  if (result) {
    over = true; winLines = result.lines;
    if (result.draw) { draw = true; drawReason = 'lines'; } else winner = result.winner;
  } else if (afterEmpty !== null) {
    afterEmpty -= 1;
    if (afterEmpty <= 0) { over = true; draw = true; drawReason = 'limit'; }
  } else if (hand.every(handEmpty)) {
    afterEmpty = 12;
  }

  let next = { ...state, board, hand, prev: before, moves, over, winner, draw, drawReason, winLines, afterEmpty, turn: mover };
  if (!over) next.turn = nextTurn(next, mover);
  return next;
}

// 指せる手がない人は飛ばす（まず起きない。全員だめなら保険でそのまま進める）
function nextTurn(state, mover) {
  let p = (mover + 1) % state.players;
  for (let i = 0; i < state.players; i++) {
    if (legalMoves({ ...state, turn: p }).length > 0) return p;
    p = (p + 1) % state.players;
  }
  return (mover + 1) % state.players;
}
