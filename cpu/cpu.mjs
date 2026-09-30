// CPU の根の手を選ぶ（探索そのものは engine.mjs、ここは「どの根の手を選ぶか」だけ）。
// DOM にも Worker にも触らないので、cpu/worker.js からも node test.mjs からも呼べる。
import * as engine from './engine.mjs';

export const LEVELS = {
  easy: { depth: 2, jitter: 60 },   // 揺らぎあり（根の手の点に小さな乱数）
  normal: { depth: 4, jitter: 0 },
  // 強い: 持ち時間をそろえた比べ（research/dropturn）で、速い手作りの評価が学習した評価より強かったので evalLines を使う
  strong: { timeMs: 1500, depth: 12, eval: engine.evalLines },
};

function popcount24(x) { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; }
// 手番の人の手持ち（m[0..2]。各色 4 個持ちなので、置いた数が 4 未満なら残っている）
const ownHandLeft = (pos) => [0, 1, 2].some((s) => popcount24(pos.m[s]) < 4);

// 引き延ばし対策（研究の結果: 強い AI どうしは回す・返すを繰り返して終わらなくなる）。一度出た形に
// 戻る手はスーパーコウ規則（engine.mjs の legalAfter）そのものが禁止するので、ここでは根の手を
// 選ぶときに、手持ちがまだあるのに回す・返すを選ぶ手だけ少し下げる（−5）。
function penalize(mv, score, hasHand) {
  if (mv < 24 || !hasHand) return score; // drop、または手持ちがもうない人はそのまま
  return score - 5;
}

// 反復深化で、各深さの根の手すべての点を覚えておき、最後に完了した深さの点に罰を足して選ぶ。
// pos は engine.fromAppState(state)。
export function pickMove(pos, level) {
  const cfg = LEVELS[level] || LEVELS.normal;
  const hasHand = ownHandLeft(pos);
  const deadline = cfg.timeMs ? Date.now() + cfg.timeMs : 0;
  let lastScores = null;
  for (let d = 1; d <= cfg.depth; d++) {
    const r = engine.rootScores(pos, d, { deadline, eval: cfg.eval });
    if (r.stopped) break; // 読みかけ: 1 つ前の深さの結果のまま使う
    lastScores = r.scores;
    if (lastScores.some((s) => Math.abs(s.score) > engine.MATEZONE)) break; // 詰み級ならこれ以上読まない
    if (deadline && Date.now() > deadline) break;
  }
  if (!lastScores || !lastScores.length) {
    const mv = new Array(engine.NMOVES), ch = new Array(engine.NMOVES);
    const n = engine.genMoves(pos, mv, ch);
    return n ? mv[0] : -1;
  }
  let best = lastScores[0].move, bestScore = -Infinity;
  for (const { move, score } of lastScores) {
    let s = penalize(move, score, hasHand);
    if (cfg.jitter) s += (Math.random() - 0.5) * cfg.jitter;
    if (s > bestScore) { bestScore = s; best = move; }
  }
  return best;
}
