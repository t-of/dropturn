// エクストラルール（game-extra.js・2 人だけ）の CPU。持ち時間つきの反復深化 αβ 探索。
// DOM にも Worker にも触らないので、cpu/worker.js からも node test.mjs からも呼べる。
import * as GE from '../game-extra.js';

const TIME_MS = 1500;
const WIN = 100000;
// 色ごとの持ち主（2 人だけ）
const OWNER = [];
GE.PLAYER_COLORS[2].forEach((cs, p) => cs.forEach((c) => { OWNER[c] = p; }));

// 盤の点（player から見て）: 同じ色だけが入った線を、2 個なら 10 点・1 個なら 1 点で数える
function evaluate(board, player) {
  let s = 0;
  for (const [a, b, c] of GE.LINES) {
    const va = board[a], vb = board[b], vc = board[c];
    let color = -1, n = 0, ok = true;
    for (const v of [va, vb, vc]) {
      if (v === GE.EMPTY) continue;
      if (color === -1) color = v; else if (v !== color) { ok = false; break; }
      n++;
    }
    if (!ok || !n) continue;
    const w = n === 2 ? 10 : 1;
    s += OWNER[color] === player ? w : -w;
  }
  return s;
}

// 探索の中の手（一度出た形の禁止は根だけで見る）
// ponytail: 探索の中はスーパーコウを見ない。読み筋に禁じ手が混じって読み違えることがある
function children(board, hand, turn) {
  const out = [];
  for (const [color, n] of Object.entries(hand[turn])) {
    if (n <= 0) continue;
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
      if (GE.canDrop(board, x, z)) out.push({ move: { type: 'drop', color: +color, x, z }, board: GE.drop(board, x, z, +color) });
    }
  }
  for (const axis of ['x', 'y', 'z']) for (let layer = 0; layer < 3; layer++) for (const dir of [1, -1]) {
    out.push({ move: { type: 'rotate', axis, layer, dir }, board: GE.gravity(GE.rotateSlice(board, axis, layer, dir)) });
  }
  for (const { axis, dir } of GE.EDGE_TILTS) out.push({ move: { type: 'tilt', axis, dir }, board: GE.gravity(GE.rotateWhole(board, axis, dir)) });
  out.push({ move: { type: 'flip' }, board: GE.gravity(GE.flipBoard(board)) });
  return out;
}

const useHand = (hand, turn, move) => (move.type !== 'drop' ? hand
  : hand.map((h, p) => (p === turn ? { ...h, [move.color]: h[move.color] - 1 } : h)));

class Timeout extends Error {}

// 手を指したあとの点（mover から見て）。勝ち負けが決まればそれを返す
function scoreAfter(board, hand, mover, depth, alpha, beta, deadline) {
  const r = GE.judgeBoard(board, 2, mover);
  if (r) return r.draw ? 0 : r.winner === mover ? WIN + depth : -WIN - depth; // 早い勝ち・遅い負けを好む
  if (depth <= 0) return evaluate(board, mover);
  return -search(board, hand, 1 - mover, depth, -beta, -alpha, deadline);
}

function search(board, hand, turn, depth, alpha, beta, deadline) {
  if (Date.now() > deadline) throw new Timeout();
  let best = -Infinity;
  for (const c of children(board, hand, turn)) {
    const s = scoreAfter(c.board, useHand(hand, turn, c.move), turn, depth - 1, alpha, beta, deadline);
    if (s > best) best = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break;
  }
  return best;
}

// state は game-extra.js の対局（2 人）。指す手（game-extra.js の手の形）を返す
export function pickMove(state, timeMs = TIME_MS) {
  const deadline = Date.now() + timeMs;
  const me = state.turn;
  let roots = GE.legalMoves(state).map((move) => ({ move, board: GE.previewBoard(state, move), score: 0 }));
  if (!roots.length) return null;
  let best = roots[0].move;
  for (let d = 1; d <= 8; d++) {
    try {
      let alpha = -Infinity;
      for (const r of roots) {
        r.score = scoreAfter(r.board, useHand(state.hand, me, r.move), me, d - 1, alpha, Infinity, deadline);
        if (r.score > alpha) alpha = r.score;
      }
    } catch (e) {
      if (e instanceof Timeout) break; // 読みかけ: 1 つ前の深さの結果のまま使う
      throw e;
    }
    roots.sort((a, b) => b.score - a.score); // 次の深さはよい手から読む（αβ がよく効く）
    best = roots[0].move;
    if (Math.abs(roots[0].score) >= WIN) break; // 勝ち・負けが読み切れた
  }
  return best;
}
