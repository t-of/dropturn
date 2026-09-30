// DROPTURN の AI エンジン（研究用）。src/core.[ch] search.[ch] nn.[ch] ai.c の JS 移植。
// DOM には触らない（ブラウザの Worker でも Node でも動く）。規則は DROPTURN 既定のみ（2 人、
// ban=0 nochange=0 simul=0 end=0 limit=12、手持ち 4,4,4/4,4,4）。詳しい対応は各関数のコメントを参照。
//
// マス番号・LINES は apps/dropturn/game.js と同じ形（col*3+tier、FACES 前→右回り）。

export const FULL24 = 0xFFFFFF;
export const NMOVES = 31;
export const MV_FLIP = 30;
export const TIER0 = 0x249249;
const TOTAL_STOCK = 24; // R.stock 全員分の合計（4*3*2）

export const MATE = 30000;
export const MATEZONE = 29000;
export const INF = 32000;

export const R_NONE = 0, R_WIN = 1, R_LOSS = 2, R_DRAW = 3;

// ---- 盤の形（core.c と同じ 32 本） ----
const FACES = [[0, 1, 2], [2, 3, 4], [4, 5, 6], [6, 7, 0]];
const cellIdx = (col, tier) => col * 3 + tier;

function buildLines() {
  const lines = [];
  for (const face of FACES) {
    for (let t = 0; t < 3; t++) lines.push(face.map((c) => cellIdx(c, t)));
    for (const c of face) lines.push([0, 1, 2].map((t) => cellIdx(c, t)));
    lines.push([cellIdx(face[0], 0), cellIdx(face[1], 1), cellIdx(face[2], 2)]);
    lines.push([cellIdx(face[0], 2), cellIdx(face[1], 1), cellIdx(face[2], 0)]);
  }
  return lines.map((l) => (1 << l[0]) | (1 << l[1]) | (1 << l[2]));
}
export const LINES = buildLines(); // 32 本

// 返す（列 col → (6-col) mod 8、段 t → 2-t）のビットごとの行き先
const FLIP_PERM = new Array(24);
for (let col = 0; col < 8; col++) for (let t = 0; t < 3; t++) {
  FLIP_PERM[cellIdx(col, t)] = cellIdx(((6 - col) % 8 + 8) % 8, 2 - t);
}

// 列ごとの重力表（core.c core_init と同じ作り）: GRAV[占まっているビット][色のビット] → 詰めたあと
const GRAV = Array.from({ length: 8 }, () => new Array(8).fill(0));
for (let o = 0; o < 8; o++) for (let b = 0; b < 8; b++) {
  let r = 0, out = 0;
  for (let t = 0; t < 3; t++) if ((o >> t) & 1) { if ((b >> t) & 1) out |= 1 << r; r++; }
  GRAV[o][b] = (b & ~o) ? 0 : out;
}

// 8bit ごとの立っているビットの数（24bit の popcount に使う）
const POPC8 = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPC8[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1) +
  ((i >> 4) & 1) + ((i >> 5) & 1) + ((i >> 6) & 1) + ((i >> 7) & 1);
function popcount(x) { return POPC8[x & 255] + POPC8[(x >>> 8) & 255] + POPC8[(x >>> 16) & 255]; }

function occOf(m) { return (m[0] | m[1] | m[2] | m[3] | m[4] | m[5]) >>> 0; }

export function hasLine(x) {
  if (popcount(x) < 3) return 0;
  for (const L of LINES) if ((x & L) === L) return 1;
  return 0;
}

function rotl24(x, s) { return (((x << s) | (x >>> (24 - s))) & FULL24) >>> 0; }

function flipBits(x) {
  let r = 0;
  for (let i = 0; i < 24; i++) if ((x >>> i) & 1) r |= 1 << FLIP_PERM[i];
  return r >>> 0;
}

function gravityArr(m) {
  const o = occOf(m);
  const bad = (((o & (TIER0 << 1)) >>> 1) & ~o & TIER0) | (((o & (TIER0 << 2)) >>> 1) & ~o & (TIER0 << 1));
  if (!bad) return;
  for (let c = 0; c < 8; c++) {
    const oc = (o >>> (3 * c)) & 7;
    if (oc === 0 || oc === 1 || oc === 3 || oc === 7) continue;
    for (let k = 0; k < 6; k++) {
      const b = (m[k] >>> (3 * c)) & 7;
      if (b) m[k] = ((m[k] & ~(7 << (3 * c))) | (GRAV[oc][b] << (3 * c))) >>> 0;
    }
  }
}

// ---- 手持ち（DROPTURN 既定: 両者とも各色 4 個） ----
function stockRel(pos, s) { return 4; }
function handRel(pos, s) { return stockRel(pos, s) - popcount(pos.m[s]); }

// ---- 盤（Pos）----
// pos = { m:number[6], seen:number[6][], after:number(-1=まだ), side:0|1 }
// seen は「最後に drop を指したあと」に出た盤の一覧（apps/dropturn/game.js の state.seen と同じ役
// 目・同じスーパーコウの規則）。ただし向き（0=手番の人が先頭）で入れ替わる m とは違い、絶対の色の
// 並び（P0 の色が常に 0..2）で持つ（toAbs）。手番が変わっても比べられるようにするため。
export function posStart() {
  return { m: [0, 0, 0, 0, 0, 0], seen: [[0, 0, 0, 0, 0, 0]], after: -1, side: 0 };
}
// m（pos.side から見た相対の色）と、絶対の色（P0=0..2 固定）を行き来する。自分自身が逆変換でもある。
function toAbs(side, arr) { return side === 0 ? arr : [arr[3], arr[4], arr[5], arr[0], arr[1], arr[2]]; }

function boardsEq(a, b) { for (let k = 0; k < 6; k++) if (a[k] !== b[k]) return false; return true; }

// かご全体を 90° 回しただけの違いも同じ局面とみなす（apps/dropturn/game.js の sameUpToTurn と同じ）。
// 列 col → col+2 (mod 8)、段は変えない。DROPTURN 既定の禁止手の判定に使う。
const ROT_PERM = new Array(24);
for (let col = 0; col < 8; col++) for (let t = 0; t < 3; t++) {
  ROT_PERM[cellIdx(col, t)] = cellIdx((col + 2) % 8, t);
}
function rotWholeBits(x) {
  let r = 0;
  for (let i = 0; i < 24; i++) if ((x >>> i) & 1) r |= 1 << ROT_PERM[i];
  return r >>> 0;
}
function rotateWholeArr(m) { return m.map(rotWholeBits); }
function boardsEqUpToRot(a, b) {
  let x = a;
  for (let k = 0; k < 4; k++) {
    if (boardsEq(x, b)) return true;
    x = rotateWholeArr(x);
  }
  return false;
}

// 手を指した盤を c(長さ6の配列) に作る。指せなければ false
export function makeBoard(pos, mv, c) {
  for (let k = 0; k < 6; k++) c[k] = pos.m[k];
  if (mv < 24) {
    const s = mv >> 3, col = mv & 7;
    const o = occOf(pos.m);
    if (o & (4 << (3 * col))) return false;
    if (handRel(pos, s) <= 0) return false;
    const col3 = (o >>> (3 * col)) & 7;
    const t = (col3 & 1) ? ((col3 & 2) ? 2 : 1) : 0;
    c[s] = (c[s] | (1 << (3 * col + t))) >>> 0;
    return true;
  }
  if (mv < MV_FLIP) {
    const t = (mv - 24) >> 1, sh = (mv & 1) ? 18 : 6;
    const tm = (TIER0 << t) >>> 0;
    for (let k = 0; k < 6; k++) c[k] = ((c[k] & ~tm) | rotl24(c[k] & tm, sh)) >>> 0;
  } else {
    for (let k = 0; k < 6; k++) c[k] = flipBits(c[k]);
  }
  gravityArr(c);
  return true;
}

// 規則上指せるか（DROPTURN 既定を、今のアプリのスーパーコウ規則に合わせたもの）。drop は箱が増える
// ので制限なし。rotate・flip は、結果の盤が pos.seen（最後に drop を指したあとに出た盤の一覧）の
// どれかと、かごごと回しただけの違いも同じとみなして一致するなら禁止（apps/dropturn/game.js の
// isBanned と同じ判定。研究の core.c は 1 手前だけ・向きも区別しないため、そのままでは今のアプリの
// 禁止手より緩く、AI がアプリでは反則の手を選んでしまう）。
export function legalAfter(pos, mv, c) {
  if (mv < 24) return true;
  const abs = toAbs(pos.side, c);
  for (let i = 0; i < pos.seen.length; i++) if (boardsEqUpToRot(abs, pos.seen[i])) return false;
  return true;
}

// 手を指したあとの勝ち負け。R_NONE のときは [R_NONE, 次の局面]
export function playMove(pos, mv, c) {
  const mw = hasLine(c[0]) | hasLine(c[1]) | hasLine(c[2]);
  const ow = hasLine(c[3]) | hasLine(c[4]) | hasLine(c[5]);
  if (mw) return [R_WIN, null];
  if (ow) return [R_LOSS, null];
  let after = pos.after;
  if (after >= 0) { after--; if (after <= 0) return [R_DRAW, null]; }
  else if (popcount(occOf(c)) === TOTAL_STOCK) after = 12;
  const abs = toAbs(pos.side, c);
  const seen = mv < 24 ? [abs] : [...pos.seen, abs]; // drop なら履歴をリセット、それ以外は積む
  const q = { m: [c[3], c[4], c[5], c[0], c[1], c[2]], seen, after, side: pos.side ^ 1 };
  return [R_NONE, q];
}

// 指せる手がないときの「飛ばし」。盤は変わらないので、seen（絶対の色の並びで持つ）はそのまま引き継ぐ
export function passMove(pos) {
  return {
    m: [pos.m[3], pos.m[4], pos.m[5], pos.m[0], pos.m[1], pos.m[2]],
    seen: pos.seen, after: pos.after, side: pos.side ^ 1,
  };
}

// 手の一覧。mv・ch（それぞれ長さ NMOVES 分使える配列）に詰めて数を返す
export function genMoves(pos, mv, ch) {
  let n = 0;
  for (let m = 0; m < NMOVES; m++) {
    const c = new Array(6);
    if (makeBoard(pos, m, c) && legalAfter(pos, m, c)) { mv[n] = m; ch[n] = c; n++; }
  }
  return n;
}

// ---- 評価: 列の揃い具合だけを見る単純な評価（nn.c eval_lines） ----
export function evalLines(pos) {
  const o = occOf(pos.m);
  let sc = 0;
  for (let k = 0; k < 6; k++) {
    const x = pos.m[k];
    if (!x || stockRel(pos, k) < 3) continue;
    const h = handRel(pos, k);
    let v = 0;
    const others = (o & ~x) >>> 0;
    for (const L of LINES) {
      if (L & others) continue;
      const n = popcount(L & x);
      if (n === 2) {
        const e = (L & ~o) >>> 0;
        const support = (e & TIER0) || ((e >>> 1) & o);
        v += (support && h > 0) ? 30 : 8;
      } else if (n === 1) v += 1;
    }
    sc += k < 3 ? v : -v;
  }
  return sc;
}

// ---- パターン評価（nn.c pat_features / eval_pat） ----
export const PAT_TYPES = 8, PAT_CFG = 64, PAT_HB = 3;
export const PAT_N = 2 * PAT_TYPES * PAT_CFG * PAT_HB;
export const PAT_EXTRA = 4;
export const PAT_DIM = PAT_N + PAT_EXTRA;
const PAT_MAXF = 6 * 32 + PAT_EXTRA;
const PAT_SCALE = Math.fround(400.0);

let WEIGHTS = null;
export function loadPatWeights(float32arr) {
  if (float32arr.length !== PAT_DIM) throw new Error(`重みの長さが ${PAT_DIM} でない: ${float32arr.length}`);
  WEIGHTS = float32arr;
}

// 特徴の番号(idx)と値(val)を詰め、数を返す
export function patFeatures(pos, idx, val) {
  const o = occOf(pos.m);
  const empty = (~o & FULL24) >>> 0;
  const support = (empty & (TIER0 | ((o & ~(TIER0 << 2)) << 1))) >>> 0;
  let n = 0;
  for (let k = 0; k < 6; k++) {
    if (stockRel(pos, k) < 3) continue;
    const x = pos.m[k];
    const h = handRel(pos, k), hb = h <= 0 ? 0 : h === 1 ? 1 : 2;
    const own = k < 3 ? 0 : 1;
    if (popcount(x) + h < 3) continue;
    for (let l = 0; l < 32; l++) {
      const L = LINES[l];
      if (!(L & x)) continue;
      let cfg = 0, mul = 1;
      for (let b = 0; b < 24; b++) {
        if (!((L >>> b) & 1)) continue;
        const s = (x >>> b) & 1 ? 0 : (o >>> b) & 1 ? 1 : (support >>> b) & 1 ? 2 : 3;
        cfg += s * mul; mul *= 4;
      }
      idx[n] = ((own * PAT_TYPES + (l & 7)) * PAT_CFG + cfg) * PAT_HB + hb; val[n] = 1; n++;
    }
  }
  let hm = 0, ho = 0;
  for (let k = 0; k < 3; k++) { hm += handRel(pos, k); ho += handRel(pos, k + 3); }
  idx[n] = PAT_N + 0; val[n++] = 1;
  idx[n] = PAT_N + 1; val[n++] = pos.after >= 0 ? 1 : 0;
  idx[n] = PAT_N + 2; val[n++] = pos.seen.length > 1 ? 1 : 0; // 旧 hasban 相当（学習時の特徴と同じ並びを保つ）
  idx[n] = PAT_N + 3; val[n++] = (hm - ho) / 4.0;
  return n;
}

const featIdx = new Int32Array(PAT_MAXF), featVal = new Float64Array(PAT_MAXF);
// float32 の積み上げ（C の `float s` と同じ丸めにするため、足すたびに Math.fround する）
export function evalPat(pos) {
  const n = patFeatures(pos, featIdx, featVal);
  let s = 0;
  for (let i = 0; i < n; i++) s = Math.fround(s + Math.fround(WEIGHTS[featIdx[i]] * featVal[i]));
  let v = Math.trunc(Math.fround(s * PAT_SCALE));
  return v > 20000 ? 20000 : v < -20000 ? -20000 : v;
}

// ---- 探索（置換表なし版。search.c と同じ負の最大＋アルファベータ）----
// 検証用に残してある（js/test.mjs が C の置換表なし版と比べるのに使う）。実際に指すときは
// 下の置換表ありの search/rootSearch（bestMove が使う）のほうを使う。
function searchNoTT(pos, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if (depth <= 0) {
    if (ctx.qwin) {
      const c = new Array(6);
      for (let mv = 0; mv < NMOVES; mv++) {
        if (!makeBoard(pos, mv, c) || !legalAfter(pos, mv, c)) continue;
        if (hasLine(c[0]) | hasLine(c[1]) | hasLine(c[2])) return MATE - ply - 1;
      }
    }
    return ctx.eval(pos);
  }
  const mv = new Array(NMOVES), ch = new Array(NMOVES);
  const n = genMoves(pos, mv, ch);
  if (n === 0) {
    const q = passMove(pos);
    const mv2 = new Array(NMOVES), ch2 = new Array(NMOVES);
    if (genMoves(q, mv2, ch2) === 0) return 0;
    return -searchNoTT(q, depth - 1, -beta, -alpha, ply + 1, ctx);
  }
  const kids = new Array(n), res = new Array(n);
  for (let i = 0; i < n; i++) {
    const [r, q] = playMove(pos, mv[i], ch[i]);
    res[i] = r; kids[i] = q;
    if (r === R_WIN) return MATE - ply - 1;
  }
  let best = -INF;
  for (let i = 0; i < n; i++) {
    let v;
    if (res[i] === R_LOSS) v = -(MATE - ply - 1);
    else if (res[i] === R_DRAW) v = 0;
    else v = -searchNoTT(kids[i], depth - 1, -beta, -alpha, ply + 1, ctx);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

// 深さ depth の root_search（置換表なし）。{score, move, nodes}
export function rootSearchNoTT(pos, depth, alpha, beta, opts = {}) {
  const ctx = { nodes: 0, qwin: opts.qwin ?? true, eval: opts.eval ?? (WEIGHTS ? evalPat : evalLines) };
  const mv = new Array(NMOVES), ch = new Array(NMOVES);
  const n = genMoves(pos, mv, ch);
  let bs = -INF, best = n ? mv[0] : -1;
  for (let i = 0; i < n; i++) {
    const [r, q] = playMove(pos, mv[i], ch[i]);
    let v;
    if (r === R_WIN) v = MATE - 1;
    else if (r === R_LOSS) v = -(MATE - 1);
    else if (r === R_DRAW) v = 0;
    else v = -searchNoTT(q, depth - 1, -beta, -Math.max(alpha, bs), 1, ctx);
    if (v > bs) { bs = v; best = mv[i]; }
    if (bs >= beta) break;
  }
  return { score: bs, move: best, nodes: ctx.nodes };
}

// ---- 置換表あり探索（search.c の最新版と同じ）----
// 評価つきの探索では向きの同一視をしない（nsym=1、色の並べ替えだけ）。理由は search.c のコメント参照
// （eval_pat は向きで値が変わるため、向きをまとめると C の置換表と食い違う）。
//
// 手番の人の 3 色・相手の 3 色は、DROPTURN の手持ちがいつも 4,4,4 で対称なので、いつも並べ替えてよい。
function sort3(t, pm, base) {
  pm[base] = base; pm[base + 1] = base + 1; pm[base + 2] = base + 2;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2 - i; j++) {
    if (t[pm[base + j]] < t[pm[base + j + 1]]) { const x = pm[base + j]; pm[base + j] = pm[base + j + 1]; pm[base + j + 1] = x; }
  }
}

// 標準形。a(長さ7) と perm(長さ6) に書き込む（呼び出し側があらかじめ用意した配列を使い、確保しない）。
// pos.seen の履歴は含めない（TT はそもそも pos.seen.length <= 1 のノードでしか使わない。search 参照）。
function canon(pos, a, perm) {
  const t = pos.m;
  sort3(t, perm, 0);
  sort3(t, perm, 3);
  for (let k = 0; k < 6; k++) a[k] = t[perm[k]];
  a[6] = pos.after + 1;
}

function toCanonMove(perm, mv) {
  if (mv < 24) {
    const slot = mv >> 3, col = mv & 7;
    let i = 0; for (; i < 3; i++) if (perm[i] === slot) break;
    return i * 8 + col;
  }
  return mv;
}
function fromCanonMove(perm, cm) {
  if (cm < 24) { const i = cm >> 3, col = cm & 7; return perm[i] * 8 + col; }
  return cm;
}

// 64 ビット相当のハッシュを 32 ビット×2（h1, h2）で持つ（BigInt は遅いので避ける）
function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
const HASH_OUT = { h1: 0, h2: 0 }; // 確保を避けるための使い回し
function canonHash(a) {
  let h1 = 0, h2 = 0x9e3779b9;
  for (let i = 0; i < 7; i++) {
    const v = (a[i] + Math.imul(i, 0x1000193)) >>> 0;
    h1 = mix32((h1 ^ v) >>> 0);
    h2 = mix32((h2 + v + 0x517cc1b7) >>> 0);
  }
  HASH_OUT.h1 = h1; HASH_OUT.h2 = h2;
}

// ---- 置換表本体 ----
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
let ttBits = 0, ttMask = 0, ttKeyHi, ttKeyLo, ttScore, ttDepth, ttFlag, ttMove;
export function ttInit(bits) {
  ttBits = bits;
  const size = 1 << bits;
  ttMask = size - 1;
  ttKeyHi = new Int32Array(size);
  ttKeyLo = new Int32Array(size);
  ttScore = new Int16Array(size);
  ttDepth = new Int8Array(size);
  ttFlag = new Uint8Array(size);
  ttMove = new Uint8Array(size);
}
export function ttClear() {
  ttKeyHi.fill(0); ttKeyLo.fill(0); ttScore.fill(0); ttDepth.fill(0); ttFlag.fill(0); ttMove.fill(0);
}
ttInit(22); // 既定で確保しておく（約 4M 局面ぶん、50MB ほど）。要れば ttInit(bits) で作り直す

const HIST = [new Int32Array(NMOVES), new Int32Array(NMOVES)]; // 手の並べ替え用の履歴（history heuristic）
export function resetSearchState() { ttClear(); HIST[0].fill(0); HIST[1].fill(0); }

const to_tt = (s, ply) => (s > MATEZONE ? s + ply : s < -MATEZONE ? s - ply : s);
const from_tt = (s, ply) => (s > MATEZONE ? s - ply : s < -MATEZONE ? s + ply : s);

// 各深さ（ply）ごとに使い回す作業用の配列（再帰しても深さが違えば取り合わないので安全）
function makePlyPool() {
  const N = NMOVES;
  const kidMFlat = new Int32Array(N * 6);
  const kidPos = [];
  // seen は履歴つき（可変長）なので、m と違って固定サイズの一枚岩には積めない。ノードごとに
  // 配列を作り直す（playMoveInto）。ponytail: 深く探索するときはここが確保のコストになるが、
  // pos.seen が短いこと（1 回の drop〜drop の間だけ）に助けられて実用上は問題にならない。
  for (let i = 0; i < N; i++) kidPos.push({ m: kidMFlat.subarray(i * 6, i * 6 + 6), seen: null, after: -1, side: 0 });
  return {
    trial: new Int32Array(6),
    chFlat: new Int32Array(N * 6),
    mv: new Int32Array(N),
    kidPos,
    res: new Int32Array(N),
    ord: new Int32Array(N),
    key2: new Int32Array(N),
    canonA: new Int32Array(7),
    canonPerm: new Int32Array(6),
    leafC: new Int32Array(6),
  };
}
const PLY_POOL = [];
function getPool(ply) { while (PLY_POOL.length <= ply) PLY_POOL.push(makePlyPool()); return PLY_POOL[ply]; }

// 手の一覧を pool に詰める（確保しない版。gen_moves と同じ順）
function genMovesPool(pos, pool) {
  let n = 0;
  const trial = pool.trial;
  for (let m = 0; m < NMOVES; m++) {
    if (makeBoard(pos, m, trial) && legalAfter(pos, m, trial)) {
      pool.mv[n] = m;
      pool.chFlat.set(trial, n * 6);
      n++;
    }
  }
  return n;
}

// 手を指した子局面を kid（pool.kidPos[i]）に書き込む（確保しない版。play_move と同じ）
function playMoveInto(pos, mv, c, kid) {
  if (hasLine(c[0]) | hasLine(c[1]) | hasLine(c[2])) return R_WIN;
  if (hasLine(c[3]) | hasLine(c[4]) | hasLine(c[5])) return R_LOSS;
  let after = pos.after;
  if (after >= 0) { after--; if (after <= 0) return R_DRAW; }
  else if (popcount(occOf(c)) === TOTAL_STOCK) after = 12;
  kid.m[0] = c[3]; kid.m[1] = c[4]; kid.m[2] = c[5]; kid.m[3] = c[0]; kid.m[4] = c[1]; kid.m[5] = c[2];
  const abs = toAbs(pos.side, c);
  kid.seen = mv < 24 ? [abs] : pos.seen.concat([abs]); // drop なら履歴をリセット、それ以外は積む
  kid.after = after; kid.side = pos.side ^ 1;
  return R_NONE;
}

// search.c の search() と同じ中身（置換表あり、色の並べ替えだけの canon）
function search(pos, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if (ctx.deadline && (ctx.nodes & 4095) === 0 && Date.now() > ctx.deadline) ctx.stop = 1;
  if (ctx.stop) return 0;
  if (depth <= 0) {
    if (ctx.qwin) {
      const c = ctx.leafC;
      for (let mv = 0; mv < NMOVES; mv++) {
        if (!makeBoard(pos, mv, c) || !legalAfter(pos, mv, c)) continue;
        if (hasLine(c[0]) | hasLine(c[1]) | hasLine(c[2])) return MATE - ply - 1;
      }
    }
    return ctx.eval(pos);
  }

  const pool = getPool(ply);
  // 置換表は pos.seen.length <= 1（drop の直後、または履歴がまだ 1 つだけ）のノードでだけ使う。
  // legalAfter が pos.seen を見る以上、同じ盤でも履歴（ここまでの経路）によって指せる手が変わり
  // うる（GHI 問題）。盤だけをキーにした置換表はその違いを区別できないので、正しさを優先して
  // 履歴が積み上がったノードでは probe も store もしない（search そのものは変えない）。
  const ttOk = pos.seen.length <= 1;
  let h1 = 0, h2 = 0, idx = 0, ttmove = -1, hit = false;
  if (ttOk) {
    canon(pos, pool.canonA, pool.canonPerm);
    canonHash(pool.canonA);
    h1 = HASH_OUT.h1; h2 = HASH_OUT.h2;
    idx = h1 & ttMask;
    hit = ttFlag[idx] !== 0 && ttKeyHi[idx] === h1 && ttKeyLo[idx] === h2;
    if (hit) {
      const s = from_tt(ttScore[idx], ply);
      ttmove = ttMove[idx] === 255 ? -1 : fromCanonMove(pool.canonPerm, ttMove[idx]);
      const usable = ttDepth[idx] >= depth || ((s > MATEZONE && ttFlag[idx] !== TT_UPPER) || (s < -MATEZONE && ttFlag[idx] !== TT_LOWER));
      if (usable) {
        if (ttFlag[idx] === TT_EXACT) return s;
        if (ttFlag[idx] === TT_LOWER && s >= beta) return s;
        if (ttFlag[idx] === TT_UPPER && s <= alpha) return s;
      }
    }
  }

  const n = genMovesPool(pos, pool);
  if (n === 0) {
    const q = passMove(pos);
    const mv2 = new Array(NMOVES), ch2 = new Array(NMOVES);
    if (genMoves(q, mv2, ch2) === 0) return 0;
    return -search(q, depth - 1, -beta, -alpha, ply + 1, ctx);
  }

  const { mv, chFlat, kidPos, res, ord, key2 } = pool;
  for (let i = 0; i < n; i++) {
    res[i] = playMoveInto(pos, mv[i], chFlat.subarray(i * 6, i * 6 + 6), kidPos[i]);
    if (res[i] === R_WIN) return MATE - ply - 1;
  }
  const side = pos.side;
  const hist = HIST[side];
  for (let i = 0; i < n; i++) {
    ord[i] = i;
    let k;
    if (res[i] === R_LOSS) k = -1000000;
    else if (res[i] === R_DRAW) k = -500;
    else k = hist[mv[i]];
    if (mv[i] === ttmove) k = 2000000;
    else if (res[i] === R_NONE && depth >= 2) k += -evalLines(kidPos[i]) * 64;
    key2[i] = k;
  }
  for (let i = 1; i < n; i++) {
    const x = ord[i]; let j = i;
    while (j > 0 && key2[ord[j - 1]] < key2[x]) { ord[j] = ord[j - 1]; j--; }
    ord[j] = x;
  }

  let best = -INF, bestmv = -1; const a0 = alpha;
  for (let oi = 0; oi < n; oi++) {
    const i = ord[oi];
    let v;
    if (res[i] === R_LOSS) v = -(MATE - ply - 1);
    else if (res[i] === R_DRAW) v = 0;
    else v = -search(kidPos[i], depth - 1, -beta, -alpha, ply + 1, ctx);
    if (ctx.stop) return 0;
    if (v > best) { best = v; bestmv = mv[i]; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) { hist[mv[i]] += depth * depth; break; }
  }

  if (ttOk && (!hit || depth >= ttDepth[idx] || best > MATEZONE || best < -MATEZONE)) {
    ttKeyHi[idx] = h1; ttKeyLo[idx] = h2;
    ttScore[idx] = to_tt(best, ply); ttDepth[idx] = depth;
    ttFlag[idx] = best <= a0 ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
    ttMove[idx] = bestmv < 0 ? 255 : toCanonMove(pool.canonPerm, bestmv);
  }
  return best;
}

// 深さ depth の root_search（置換表あり）。{score, move, nodes, stopped}
export function rootSearch(pos, depth, alpha, beta, opts = {}) {
  const ctx = {
    nodes: 0, stop: 0,
    qwin: opts.qwin ?? true, eval: opts.eval ?? (WEIGHTS ? evalPat : evalLines),
    deadline: opts.deadline || 0,
    leafC: new Int32Array(6),
  };
  const pool = getPool(0);
  const n = genMovesPool(pos, pool);
  const { mv, chFlat, kidPos } = pool;
  let bs = -INF, best = n ? mv[0] : -1;

  // 置換表は pos.seen.length <= 1 のときだけ（search() 冒頭のコメント参照）
  const ttOk = pos.seen.length <= 1;
  let h1 = 0, h2 = 0, idx = 0;
  if (ttOk) {
    canon(pos, pool.canonA, pool.canonPerm);
    canonHash(pool.canonA);
    h1 = HASH_OUT.h1; h2 = HASH_OUT.h2; idx = h1 & ttMask;
    const hit = ttFlag[idx] !== 0 && ttKeyHi[idx] === h1 && ttKeyLo[idx] === h2;
    if (hit && ttMove[idx] !== 255) {
      const tm = fromCanonMove(pool.canonPerm, ttMove[idx]);
      for (let i = 0; i < n; i++) if (mv[i] === tm) {
        const t = mv[0]; mv[0] = mv[i]; mv[i] = t;
        const tmp = chFlat.slice(0, 6);
        chFlat.copyWithin(0, i * 6, i * 6 + 6);
        chFlat.set(tmp, i * 6);
        break;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const c = chFlat.subarray(i * 6, i * 6 + 6);
    const r = playMoveInto(pos, mv[i], c, kidPos[i]);
    let v;
    if (r === R_WIN) v = MATE - 1;
    else if (r === R_LOSS) v = -(MATE - 1);
    else if (r === R_DRAW) v = 0;
    else v = -search(kidPos[i], depth - 1, -beta, -Math.max(alpha, bs), 1, ctx);
    if (ctx.stop) break;
    if (v > bs) { bs = v; best = mv[i]; }
    if (bs >= beta) break;
  }
  if (ttOk && !ctx.stop && best >= 0) {
    ttKeyHi[idx] = h1; ttKeyLo[idx] = h2;
    ttScore[idx] = to_tt(bs, 0); ttDepth[idx] = depth;
    ttFlag[idx] = bs <= alpha ? TT_UPPER : bs >= beta ? TT_LOWER : TT_EXACT;
    ttMove[idx] = toCanonMove(pool.canonPerm, best);
  }
  return { score: bs, move: best, nodes: ctx.nodes, stopped: !!ctx.stop };
}

// rootSearch と同じ深さ depth の根の手を探すが、best の 1 手だけでなく全部の手の点を返す
// （終わらない対策で、根の手を選び直すときに使う。search() 自体は変えない）。
// 兄弟の点で alpha を締めないぶん rootSearch より遅いが、深さは時間切れなら 1 つ前のまま使う。
// {scores: [{move, score}] | null, nodes, stopped}
export function rootScores(pos, depth, opts = {}) {
  const ctx = {
    nodes: 0, stop: 0,
    qwin: opts.qwin ?? true, eval: opts.eval ?? (WEIGHTS ? evalPat : evalLines),
    deadline: opts.deadline || 0,
    leafC: new Int32Array(6),
  };
  const pool = getPool(0);
  const n = genMovesPool(pos, pool);
  const { mv, chFlat, kidPos } = pool;
  const scores = [];
  let bs = -INF, bestmv = n ? mv[0] : -1;

  // 置換表は pos.seen.length <= 1 のときだけ（search() 冒頭のコメント参照）
  const ttOk = pos.seen.length <= 1;
  let h1 = 0, h2 = 0, idx = 0;
  if (ttOk) { canon(pos, pool.canonA, pool.canonPerm); canonHash(pool.canonA); h1 = HASH_OUT.h1; h2 = HASH_OUT.h2; idx = h1 & ttMask; }

  for (let i = 0; i < n; i++) {
    const c = chFlat.subarray(i * 6, i * 6 + 6);
    const r = playMoveInto(pos, mv[i], c, kidPos[i]);
    let v;
    if (r === R_WIN) v = MATE - 1;
    else if (r === R_LOSS) v = -(MATE - 1);
    else if (r === R_DRAW) v = 0;
    else v = -search(kidPos[i], depth - 1, -INF, INF, 1, ctx);
    if (ctx.stop) return { scores: null, nodes: ctx.nodes, stopped: true };
    scores.push({ move: mv[i], score: v });
    if (v > bs) { bs = v; bestmv = mv[i]; }
  }
  if (ttOk && bestmv >= 0) {
    ttKeyHi[idx] = h1; ttKeyLo[idx] = h2;
    ttScore[idx] = to_tt(bs, 0); ttDepth[idx] = depth;
    ttFlag[idx] = TT_EXACT;
    ttMove[idx] = toCanonMove(pool.canonPerm, bestmv);
  }
  return { scores, nodes: ctx.nodes, stopped: false };
}

// 反復深化で最善手を探す。{move, score, depth}（アプリの手への変換は toAppMove）
// timeMs で時間切れになったときは、そこまでに最後まで読み切った深さの結果を返す（読みかけの深さは捨てる）
export function bestMove(pos, { depth = 30, timeMs = 0, qwin = true, eval: evalFn } = {}) {
  const deadline = timeMs ? Date.now() + timeMs : 0;
  let best = -1, bv = 0, dd = 0;
  for (let d = 1; d <= depth; d++) {
    const r = rootSearch(pos, d, -INF, INF, { qwin, eval: evalFn, deadline });
    if (r.stopped) break; // 読みかけ: 1 つ前の深さの結果のまま返す
    best = r.move; bv = r.score; dd = d;
    if (bv > MATEZONE || bv < -MATEZONE) break;
    if (deadline && Date.now() > deadline) break;
  }
  if (best < 0) {
    const mv = new Array(NMOVES), ch = new Array(NMOVES);
    if (genMoves(pos, mv, ch)) best = mv[0];
  }
  return { move: best, score: bv, depth: dd };
}

// ---- アプリ（apps/dropturn/game.js）の状態・手との行き来。2 人用のみ ----

// board（長さ24, 値 0..5 か -1）→ 絶対の色の並びの m（6 個のビット列）
function boardToAbsM(board) {
  const m = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 24; i++) {
    const v = board[i];
    if (v === -1 || v === undefined) continue;
    m[v] |= 1 << i;
  }
  return m;
}

// state: { players, turn, board(長さ24, 値 0..5 か -1), seen(state.seen。絶対の色のままの盤の一覧),
//          afterEmpty(null か残り手数) }。古い保存データ（seen がなく prev だけ）にも対応する。
export function fromAppState(state) {
  if (state.players !== 2) throw new Error('fromAppState は 2 人用のみ対応');
  const turn = state.turn;
  const relColor = (v) => (turn === 0 ? v : v < 3 ? v + 3 : v - 3);
  const m = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 24; i++) {
    const v = state.board[i];
    if (v === -1 || v === undefined) continue;
    m[relColor(v)] |= 1 << i;
  }
  const seenBoards = Array.isArray(state.seen) ? state.seen : (state.prev ? [state.prev, state.board] : [state.board]);
  const seen = seenBoards.map(boardToAbsM); // 絶対の色のまま（toAbs と対応）
  const after = state.afterEmpty === null || state.afterEmpty === undefined ? -1 : state.afterEmpty;
  return { m, seen, after, side: turn };
}

// mv 番号 → アプリの手（drop の色は pos.side から絶対色に戻す）
export function toAppMove(pos, mv) {
  if (mv < 24) {
    const s = mv >> 3, col = mv & 7;
    return { type: 'drop', color: pos.side === 0 ? s : s + 3, col };
  }
  if (mv < MV_FLIP) return { type: 'rotate', tier: (mv - 24) >> 1, dir: (mv & 1) ? -1 : 1 };
  return { type: 'flip' };
}
