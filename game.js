// 遊びの中身（かご・落とす・回す・返す・重力・戻す手の禁止・勝敗）。
// DOM には触らない。ブラウザでは main.js から、テストでは node test.mjs から読む。
//
// かご: 8 本の外周の列 × 3 段 = 24 マス。board は長さ 24 の配列、値は色番号(0-5)か EMPTY。
// マス番号 = idx(col, tier)。col は 0=前左角 → 右回りに 0..7、tier は 0=下 .. 2=上。

export const EMPTY = -1;
export const idx = (col, tier) => col * 3 + tier;

// 面 = 3 列ずつ、角の列は隣の面と共有（前=0,1,2 / 右=2,3,4 / 奥=4,5,6 / 左=6,7,0）
export const FACES = [[0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 0]];

export const LINES = buildLines();
function buildLines() {
  const lines = [];
  for (const face of FACES) {
    for (let t = 0; t < 3; t++) lines.push(face.map((c) => idx(c, t)));         // 横 3 本
    for (const c of face) lines.push([0, 1, 2].map((t) => idx(c, t)));          // 縦 3 本
    lines.push([idx(face[0], 0), idx(face[1], 1), idx(face[2], 2)]);            // 斜め
    lines.push([idx(face[0], 2), idx(face[1], 1), idx(face[2], 0)]);
  }
  return lines; // 4 面 × 8 本 = 32 本
}

// 人数ごとの色の割り当て（§4 見た目）
export const PLAYER_COLORS = {
  2: [[0, 1, 2], [3, 4, 5]],
  3: [[0, 1], [3, 4], [2, 5]],
  4: [[0], [3], [1], [4]],
};

export function colorOwner(players, color) {
  return PLAYER_COLORS[players].findIndex((cs) => cs.includes(color));
}

function initHand(players) {
  return PLAYER_COLORS[players].map((colors) => {
    const per = 24 / players / colors.length;
    return Object.fromEntries(colors.map((c) => [c, per]));
  });
}

export function newBoard() { return new Array(24).fill(EMPTY); }

// 列は常に「下から詰まっている」前提（drop・gravity のあとの不変条件）
export const canDrop = (board, col) => board[idx(col, 2)] === EMPTY;

export function drop(board, col, color) {
  const b = board.slice();
  for (let t = 0; t < 3; t++) {
    if (b[idx(col, t)] === EMPTY) { b[idx(col, t)] = color; return b; }
  }
  throw new Error('その列は満杯です');
}

// 段 tier を dir(+1/-1) 分だけ回す（列 k → k+2·dir、8 で割った余り）。重力はかけない
export function rotateBoard(board, tier, dir) {
  const b = board.slice();
  for (let k = 0; k < 8; k++) {
    const k2 = ((k + 2 * dir) % 8 + 8) % 8;
    b[idx(k2, tier)] = board[idx(k, tier)];
  }
  return b;
}

// 全体を上下反転（列 k → (6−k) mod 8、段 j → 2−j）。重力はかけない
export function flipBoard(board) {
  const b = newBoard();
  for (let k = 0; k < 8; k++) for (let t = 0; t < 3; t++) {
    b[idx((6 - k + 8) % 8, 2 - t)] = board[idx(k, t)];
  }
  return b;
}

// 各列、下が空いていれば順番を保ったまま詰める
export function gravity(board) {
  const b = newBoard();
  for (let k = 0; k < 8; k++) {
    const vals = [0, 1, 2].map((t) => board[idx(k, t)]).filter((v) => v !== EMPTY);
    vals.forEach((v, t) => { b[idx(k, t)] = v; });
  }
  return b;
}

export const boardsEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- 対局 ----

export function newGame(players, rng = Math.random) {
  const first = Math.floor(rng() * players);
  return {
    v: 1, rules: 'official', players, first, turn: first,
    board: newBoard(),
    hand: initHand(players),
    seen: [newBoard()],  // 最後に「落とす」を指したあとに出た盤の一覧（それを戻す手の禁止に使う）
    afterEmpty: null,    // 全員の手持ちがなくなってからの残り手数。null は未突入
    moves: 0,
    over: false, winner: null, draw: false, drawReason: null, winLines: [],
  };
}

// 古い保存データ（seen を持たない）を読んだときの引き継ぎ。あった prev・board から履歴を始める。
export function migrateSeen(g) {
  if (Array.isArray(g.seen)) return g;
  const seen = [];
  if (g.prev) seen.push(g.prev);
  seen.push(g.board);
  return { ...g, seen };
}

const handEmpty = (h) => Object.values(h).every((v) => v === 0);

// かご全体を 90° ずつ回しただけの違いは同じ局面とみなす（下の段と上の段を同じ向きに回す＝真ん中を逆に回す、など）
// CPU（cpu/cpu.mjs）の引き延ばし対策も、実際の盤で同じ判定を使うためこれを import する。
export function sameUpToTurn(a, b) {
  let x = a;
  for (let k = 0; k < 4; k++) {
    if (boardsEqual(x, b)) return true;
    for (let t = 0; t < 3; t++) x = rotateBoard(x, t, 1);
  }
  return false;
}

// その手を指したら、この対局ですでに出た盤（かごごと回した形も同じとみなす）に戻ることになるか。
// 「落とす」は箱の数が増えて他と一致しえないので、seen は最後に落としたあとの盤から数えれば足りる
// （state.seen。同じ理由で「何も変わらない」「1 手前に戻る」もこれに含まれる）。
function isBanned(state, candidate) {
  return state.seen.some((b) => sameUpToTurn(candidate, b));
}

export function previewBoard(state, move) {
  if (move.type === 'drop') return canDrop(state.board, move.col) ? drop(state.board, move.col, move.color) : state.board;
  if (move.type === 'rotate') return gravity(rotateBoard(state.board, move.tier, move.dir));
  if (move.type === 'flip') return gravity(flipBoard(state.board));
  return state.board;
}

// 今の手番の人が指せる手の一覧
export function legalMoves(state) {
  if (state.over) return [];
  const moves = [];
  const hand = state.hand[state.turn];
  for (const [color, n] of Object.entries(hand)) {
    if (n > 0) for (let col = 0; col < 8; col++) if (canDrop(state.board, col)) moves.push({ type: 'drop', color: +color, col });
  }
  for (let tier = 0; tier < 3; tier++) for (const dir of [1, -1]) {
    const b = gravity(rotateBoard(state.board, tier, dir));
    if (!isBanned(state, b)) moves.push({ type: 'rotate', tier, dir });
  }
  const flipped = gravity(flipBoard(state.board));
  if (!isBanned(state, flipped)) moves.push({ type: 'flip' });
  return moves;
}

const sameMove = (a, b) => a.type === b.type && a.color === b.color && a.col === b.col && a.tier === b.tier && a.dir === b.dir;
export const isLegal = (state, move) => legalMoves(state).some((m) => sameMove(m, move));

// 手番の人を優先。手番以外で 1 人だけそろっていればその人。2 人以上なら引き分け
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
    board = drop(before, move.col, move.color);
    hand = state.hand.map((h, p) => (p === mover ? { ...h, [move.color]: h[move.color] - 1 } : h));
  } else if (move.type === 'rotate') {
    board = gravity(rotateBoard(before, move.tier, move.dir));
  } else if (move.type === 'flip') {
    board = gravity(flipBoard(before));
  } else {
    throw new Error('不明な手です');
  }

  const moves = state.moves + 1;
  const result = judgeBoard(board, state.players, mover);
  let over = false, winner = null, draw = false, drawReason = null, winLines = [];
  let afterEmpty = state.afterEmpty;
  const seen = move.type === 'drop' ? [board] : [...state.seen, board];

  if (result) {
    over = true; winLines = result.lines;
    if (result.draw) { draw = true; drawReason = 'lines'; } else winner = result.winner;
  } else if (afterEmpty !== null) {
    afterEmpty -= 1;
    if (afterEmpty <= 0) { over = true; draw = true; drawReason = 'limit'; }
  } else if (hand.every(handEmpty)) {
    afterEmpty = 12;
  }

  let next = { ...state, board, hand, seen, moves, over, winner, draw, drawReason, winLines, afterEmpty, turn: mover };
  if (!over) {
    const t = nextTurn(next, mover);
    if (t === null) next = { ...next, over: true, draw: true, drawReason: 'stuck', winner: null };
    else next.turn = t;
  }
  return next;
}

// 指せる手がない人は飛ばす。全員だめなら引き分け（drawReason: 'stuck'。null を返す）
function nextTurn(state, mover) {
  let p = (mover + 1) % state.players;
  for (let i = 0; i < state.players; i++) {
    if (legalMoves({ ...state, turn: p }).length > 0) return p;
    p = (p + 1) % state.players;
  }
  return null;
}
