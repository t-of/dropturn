// 遊びの中身の確かめ。node test.mjs
import assert from 'node:assert/strict';
import {
  EMPTY, idx, LINES, PLAYER_COLORS, newBoard, drop, canDrop, rotateBoard, flipBoard, gravity,
  boardsEqual, newGame, legalMoves, isLegal, applyMove, judgeBoard, colorOwner, migrateSeen,
} from './game.js';
import * as E from './game-extra.js';

const isCompact = (board) => {
  for (let k = 0; k < 8; k++) {
    let gap = false;
    for (let t = 0; t < 3; t++) {
      if (board[idx(k, t)] === EMPTY) gap = true;
      else if (gap) return false;
    }
  }
  return true;
};
const boxCount = (board) => board.filter((v) => v !== EMPTY).length;
const randomBoard = (fill = 24) => {
  let b = newBoard();
  for (let i = 0; i < fill; i++) {
    const cols = [...Array(8).keys()].filter((c) => canDrop(b, c));
    if (!cols.length) break;
    b = drop(b, cols[Math.floor(Math.random() * cols.length)], Math.floor(Math.random() * 6));
  }
  return b;
};

// ---- 32 本の線 ----
assert.equal(LINES.length, 32);
LINES.forEach((l) => assert.equal(new Set(l).size, 3));

// ---- 重力・箱の数はいつも変わらない ----
for (let r = 0; r < 30; r++) {
  const b = randomBoard(Math.floor(Math.random() * 25));
  assert.ok(isCompact(b), 'drop のあと、列が下から詰まっていない');
  const rt = gravity(rotateBoard(b, Math.floor(Math.random() * 3), Math.random() < 0.5 ? 1 : -1));
  assert.equal(boxCount(rt), boxCount(b), '回すで箱の数が変わった');
  assert.ok(isCompact(rt), '回して重力をかけたのに詰まっていない');
  const fl = gravity(flipBoard(b));
  assert.equal(boxCount(fl), boxCount(b), '返すで箱の数が変わった');
  assert.ok(isCompact(fl), '返して重力をかけたのに詰まっていない');
}
console.log('重力・箱の数: ok');

// ---- 返すを 2 回で元に戻る（重力のあとでも。列ごとの並び替えが自己逆になる） ----
for (let r = 0; r < 30; r++) {
  const b = randomBoard(Math.floor(Math.random() * 25));
  const twice = gravity(flipBoard(gravity(flipBoard(b))));
  assert.ok(boardsEqual(twice, b), '返す×2 が元に戻らない');
}
console.log('返す×2 = 元に戻る: ok');

// ---- 回すを 4 回で元に戻る ----
// 回転は列を 2 つ飛ばしの輪（{0,2,4,6} と {1,3,5,7}）で回す。輪の中がすべて満杯（またはすべて空）なら
// 重力で崩れる列がないので、そのまま 4 回で一周して戻る。
{
  let b = newBoard();
  for (const c of [0, 2, 4, 6]) for (let t = 0; t < 3; t++) b[idx(c, t)] = t; // 輪をまるごと満杯に
  let x = b;
  for (let i = 0; i < 4; i++) x = gravity(rotateBoard(x, 1, 1));
  assert.ok(boardsEqual(x, b), '回す×4（満杯の列）が元に戻らない');
}
// 空のかごも自明に戻る
{
  const b = newBoard();
  let x = b;
  for (let i = 0; i < 4; i++) x = gravity(rotateBoard(x, 0, -1));
  assert.ok(boardsEqual(x, b));
}
console.log('回す×4（満杯・空の列）= 元に戻る: ok');

// ---- 勝敗の判定（手で作った局面） ----
{
  // マスが重ならない 2 本の線（面 0 の横と、面 2 の縦）
  const lineA = LINES[0], lineB = LINES[20];
  assert.equal(new Set([...lineA, ...lineB]).size, 6, 'テスト用の 2 本の線が重なっている');

  // 手番の人の列と、ほかの人の列が同時にできても手番の人の勝ち
  let b = newBoard();
  lineA.forEach((i) => { b[i] = 0; });          // 色 0（2 人戦なら P1）
  lineB.forEach((i) => { b[i] = 3; });          // 色 3（P2）
  let r = judgeBoard(b, 2, 0);
  assert.equal(r.winner, 0);
  r = judgeBoard(b, 2, 1);
  assert.equal(r.winner, 1);

  // 手番の人はそろわず、ほかの 1 人だけそろっていればその人の勝ち
  b = newBoard();
  lineA.forEach((i) => { b[i] = 3; });
  r = judgeBoard(b, 2, 0);
  assert.equal(r.winner, 1);

  // 3 人戦で、手番でない 2 人がそろえば引き分け
  b = newBoard();
  lineA.forEach((i) => { b[i] = 0; });   // P1 の色
  lineB.forEach((i) => { b[i] = 3; });   // P2 の色
  r = judgeBoard(b, 3, 2);               // 手番は P3
  assert.equal(r.draw, true);

  // どこもそろっていなければ null
  assert.equal(judgeBoard(newBoard(), 2, 0), null);
}
console.log('勝敗判定: ok');

// ---- 色と人数の割り当て ----
for (const players of [2, 3, 4]) {
  const all = PLAYER_COLORS[players].flat();
  assert.equal(new Set(all).size, all.length, '色が重複している');
  const g = newGame(players, () => 0);
  const total = g.hand.reduce((s, h) => s + Object.values(h).reduce((a, b) => a + b, 0), 0);
  assert.equal(total, 24, `合計 24 個にならない（${players} 人）`);
  g.hand.forEach((h) => {
    const n = Object.values(h)[0];
    assert.ok(Object.values(h).every((v) => v === n), '同じ人の色ごとの数がそろっていない');
  });
}
console.log('色・手持ちの割り当て: ok');

// ---- 戻す手の禁止 ----
{
  // 下の段を埋めておく（回しても箱が落ちず、かごごと回した形とも違う盤）
  const a = newBoard();
  for (let c = 0; c < 8; c++) a[idx(c, 0)] = c % 3;
  a[idx(0, 1)] = 3;
  let g = { ...newGame(2, () => 0), board: a, seen: [a] };
  const beforeRotate = g.board;
  g = applyMove(g, { type: 'rotate', tier: 0, dir: 1 }); // P2 が回す
  // P1 が同じ回転を逆に戻す手は禁止
  assert.equal(isLegal(g, { type: 'rotate', tier: 0, dir: -1 }), false, '1 手前へ戻す手が指せてしまう');
  // 何も変わらない手（からの段を回す）も禁止
  assert.equal(isLegal(g, { type: 'rotate', tier: 2, dir: 1 }), false, '何も変わらない手が指せてしまう');
  void beforeRotate;
}
// 下を右、次に上を右で、かご全体を回しただけの形（= 1 手前と同じ局面）に戻るなら禁止
{
  const a = newBoard();
  for (let c = 0; c < 8; c++) { a[idx(c, 0)] = c % 3; a[idx(c, 1)] = 4 + c % 2; } // 真ん中は 90° 回しても同じ
  a[idx(0, 2)] = 5; a[idx(3, 2)] = 3;
  let g = { ...newGame(2, () => 0), board: a, seen: [a] };
  g = applyMove(g, { type: 'rotate', tier: 0, dir: 1 });
  assert.equal(isLegal(g, { type: 'rotate', tier: 2, dir: 1 }), false, 'かごごと回した形に戻る手が指せてしまう');
  assert.equal(isLegal(g, { type: 'rotate', tier: 2, dir: -1 }), true, '戻らない手が禁止されている');
}
console.log('戻す手の禁止: ok');

// ---- 一度出た形には戻せない（スーパーコウ。1 手前より前の形でも禁止） ----
{
  // 実際の対局から見つけた例: 下段を右に 3 回回すと、4 回目は「落とした直後」の形（3 手前）に戻る。
  // 1 手前ルールだけなら指せてしまうが、履歴（seen）を全部見るスーパーコウでは禁止になる。
  let g = newGame(2, () => 0);
  const seq = [
    { type: 'drop', color: 0, col: 6 }, { type: 'drop', color: 3, col: 3 }, { type: 'drop', color: 2, col: 3 },
    { type: 'drop', color: 4, col: 7 }, { type: 'drop', color: 2, col: 3 }, { type: 'rotate', tier: 2, dir: 1 },
    { type: 'drop', color: 0, col: 3 }, { type: 'drop', color: 4, col: 6 }, { type: 'drop', color: 0, col: 2 },
    { type: 'drop', color: 4, col: 0 }, { type: 'drop', color: 2, col: 1 }, { type: 'drop', color: 5, col: 0 },
    { type: 'drop', color: 0, col: 1 }, { type: 'drop', color: 4, col: 5 }, { type: 'drop', color: 2, col: 5 },
    { type: 'drop', color: 3, col: 4 }, { type: 'rotate', tier: 0, dir: 1 }, { type: 'rotate', tier: 0, dir: 1 },
    { type: 'rotate', tier: 0, dir: 1 },
  ];
  for (const move of seq) g = applyMove(g, move);
  assert.equal(g.seen.length, 4, '落としたあとの履歴の長さが想定と違う');
  assert.equal(isLegal(g, { type: 'rotate', tier: 0, dir: 1 }), false, '3 手前の形に戻る手が指せてしまう（スーパーコウ）');
  // 「落とす」を挟むと、落とす前の履歴は要らなくなる
  const dropMove = legalMoves(g).find((m) => m.type === 'drop');
  const dropped = applyMove(g, dropMove);
  assert.deepEqual(dropped.seen, [dropped.board], '落としたあと、履歴が最新の盤 1 つにリセットされていない');
}
console.log('スーパーコウ（一度出た形には戻せない）: ok');

// ---- 全員が指せないと引き分け（drawReason: 'stuck'） ----
{
  // 手持ちを両者とも 0 にし、盤を「2 列おきに同じ配色」にする（列を 2 つ飛ばす回転を打ち消し合い、
  // どの段を回しても「何も変わらない」で禁止になる）。「返す」だけがまだ指せるので、それも
  // seen に足してふさぐと、誰にとっても legalMoves が空になる。
  const a = newBoard();
  for (let c = 0; c < 8; c++) for (let t = 0; t < 3; t++) a[idx(c, t)] = (c % 2) * 3 + t;
  const g0 = { ...newGame(2, () => 0), board: a, seen: [a], hand: [{ 0: 0, 1: 0, 2: 0 }, { 3: 0, 4: 0, 5: 0 }] };
  assert.deepEqual(legalMoves(g0), [{ type: 'flip' }], 'この盤で「返す」以外が指せてしまう（テストの前提が崩れている）');
  const g1 = applyMove(g0, { type: 'flip' }); // 返した先の盤はまだ空いていて、次の人（＝もう片方）も同じく手がない
  assert.equal(legalMoves(g1).length, 0, '返したあと、まだ指せる手が残っている（テストの前提が崩れている）');
  assert.equal(g1.over, true);
  assert.equal(g1.draw, true);
  assert.equal(g1.drawReason, 'stuck');
}
console.log('全員だめなら引き分け: ok');

// ---- 引き分け（手持ちがなくなってから 12 手） ----
{
  // 2 人、色を偏らせて手持ちをすぐ使い切り、そろわない盤で回す・返すだけを続ける
  let g = newGame(2, () => 0);
  // 手で「手持ちがなくなった直後」の局面を作る
  g.hand = [{ 0: 0, 1: 0, 2: 0 }, { 3: 0, 4: 0, 5: 0 }];
  g.afterEmpty = 1; // 次の手で引き分けになるように
  // かごを埋める。今も、最初の手を指したあとも勝ち筋がない盤になるまで作り直す
  let moves;
  do {
    g.board = randomBoard(24);
    g.seen = [g.board];
    moves = judgeBoard(g.board, 2, g.turn) ? [] : legalMoves(g);
  } while (!moves.length || judgeBoard(applyMove(g, moves[0]).board, 2, g.turn));
  const before = g.board;
  g = applyMove(g, moves[0]);
  assert.equal(g.over, true);
  assert.equal(g.draw, true);
  assert.equal(g.drawReason, 'limit');
  void before;
}
console.log('12 手引き分け: ok');

console.log('すべて合格（公式ルール）');

// ==========================================================================
// ---- エクストラルール（軸なし・3×3×3 = 27 マス） ----
// ==========================================================================

// ---- 49 本の線 ----
assert.equal(E.LINES.length, 49);
E.LINES.forEach((l) => assert.equal(new Set(l).size, 3));
{
  const key = (l) => l.slice().sort((a, b) => a - b).join(',');
  assert.equal(new Set(E.LINES.map(key)).size, 49, '線が重複している');
}
console.log('49 本の線: ok');

// ---- 軸ごとの回転を 4 回で元に戻る（重力で崩れない、全マス埋まった盤で） ----
{
  const b = E.newBoard();
  for (let i = 0; i < E.TOTAL; i++) b[i] = i % 6;
  for (const axis of ['x', 'y', 'z']) {
    let x = b;
    for (let k = 0; k < 4; k++) x = E.rotateWhole(x, axis, 1);
    assert.ok(E.boardsEqual(x, b), `${axis} 軸を 4 回で元に戻らない`);
    x = b;
    for (let k = 0; k < 4; k++) x = E.rotateWhole(x, axis, -1);
    assert.ok(E.boardsEqual(x, b), `${axis} 軸を逆向きに 4 回で元に戻らない`);
  }
}
console.log('軸ごとの回転×4 = 元に戻る: ok');

// ---- 倒すを同じ向きに 4 回で元に戻る ----
{
  const b = E.newBoard();
  for (let i = 0; i < E.TOTAL; i++) b[i] = i % 6;
  for (const { axis, dir } of E.EDGE_TILTS) {
    let x = b;
    for (let k = 0; k < 4; k++) x = E.rotateWhole(x, axis, dir);
    assert.ok(E.boardsEqual(x, b), `倒す(${axis},${dir})×4 が元に戻らない`);
  }
  // 返す（180°）は 2 回で元に戻る
  assert.ok(E.boardsEqual(E.flipBoard(E.flipBoard(b)), b), '返す×2 が元に戻らない');
}
console.log('倒す×4・返す×2 = 元に戻る: ok');

// ---- 重力・箱の数はいつも変わらない ----
{
  const boxCount = (board) => board.filter((v) => v !== E.EMPTY).length;
  const isCompact = (board) => {
    for (let x = 0; x < E.N; x++) for (let z = 0; z < E.N; z++) {
      let gap = false;
      for (let y = 0; y < E.N; y++) {
        if (board[E.idx(x, y, z)] === E.EMPTY) gap = true;
        else if (gap) return false;
      }
    }
    return true;
  };
  const randomBoard = (fill) => {
    let b = E.newBoard();
    for (let i = 0; i < fill; i++) {
      const cols = [];
      for (let x = 0; x < E.N; x++) for (let z = 0; z < E.N; z++) if (E.canDrop(b, x, z)) cols.push([x, z]);
      if (!cols.length) break;
      const [x, z] = cols[Math.floor(Math.random() * cols.length)];
      b = E.drop(b, x, z, Math.floor(Math.random() * 6));
    }
    return b;
  };
  for (let r = 0; r < 20; r++) {
    const b = randomBoard(Math.floor(Math.random() * (E.TOTAL + 1)));
    assert.ok(isCompact(b), 'drop のあと、列が下から詰まっていない');
    const axis = ['x', 'y', 'z'][Math.floor(Math.random() * 3)];
    const layer = Math.floor(Math.random() * E.N);
    const rt = E.gravity(E.rotateSlice(b, axis, layer, Math.random() < 0.5 ? 1 : -1));
    assert.equal(boxCount(rt), boxCount(b), '回すで箱の数が変わった');
    assert.ok(isCompact(rt), '回して重力をかけたのに詰まっていない');
    const { axis: ta, dir: td } = E.EDGE_TILTS[Math.floor(Math.random() * 4)];
    const tl = E.gravity(E.rotateWhole(b, ta, td));
    assert.equal(boxCount(tl), boxCount(b), '倒すで箱の数が変わった');
    assert.ok(isCompact(tl), '倒して重力をかけたのに詰まっていない');
  }
}
console.log('エクストラ 重力・箱の数: ok');

// ---- 真ん中を通る線・立体の対角線でそろって勝つ ----
{
  // 真ん中の縦の柱 (1,0,1)-(1,1,1)-(1,2,1)
  let b = E.newBoard();
  b[E.idx(1, 0, 1)] = 0; b[E.idx(1, 1, 1)] = 0; b[E.idx(1, 2, 1)] = 0;
  let r = E.judgeBoard(b, 2, 0);
  assert.equal(r.winner, 0, '真ん中を通る柱でそろわない');

  // 立体の対角線 (0,0,0)-(1,1,1)-(2,2,2)
  b = E.newBoard();
  b[E.idx(0, 0, 0)] = 3; b[E.idx(1, 1, 1)] = 3; b[E.idx(2, 2, 2)] = 3;
  r = E.judgeBoard(b, 2, 1);
  assert.equal(r.winner, 1, '立体の対角線でそろわない');
}
console.log('エクストラ 真ん中・立体対角線の勝ち: ok');

// ---- 戻す手の禁止 ----
{
  const a = E.newBoard();
  a[E.idx(0, 0, 0)] = 0; a[E.idx(1, 0, 0)] = 1; a[E.idx(2, 0, 0)] = 2;
  a[E.idx(0, 0, 1)] = 3; a[E.idx(1, 0, 1)] = 4; a[E.idx(2, 0, 1)] = 0;
  a[E.idx(0, 0, 2)] = 1; a[E.idx(1, 0, 2)] = 2; a[E.idx(2, 0, 2)] = 3;
  a[E.idx(0, 1, 0)] = 5; a[E.idx(1, 1, 0)] = 0; // 上の段も一部埋めて、層だけの回転が全体回転と同じにならないようにする
  let g = { ...E.newGame(2, () => 0), board: a, seen: [a] };
  g = E.applyMove(g, { type: 'rotate', axis: 'y', layer: 0, dir: 1 });
  assert.equal(E.isLegal(g, { type: 'rotate', axis: 'y', layer: 0, dir: -1 }), false, '1 手前へ戻す手が指せてしまう');
  assert.equal(E.isLegal(g, { type: 'rotate', axis: 'y', layer: 2, dir: 1 }), false, '何も変わらない手（空の層）が指せてしまう');
}
console.log('エクストラ 戻す手の禁止: ok');

// ---- 色・手持ちの割り当て（公式と同じ 24 個。全員・全色が同じ数） ----
for (const players of [2, 3, 4]) {
  const g = E.newGame(players, () => 0);
  const counts = g.hand.flatMap((h) => Object.values(h));
  assert.equal(counts.reduce((a, b) => a + b, 0), 24, `合計 24 個にならない（${players} 人）`);
  assert.ok(counts.every((n) => n === counts[0]), '人・色ごとの数がそろっていない');
}
console.log('エクストラ 色・手持ちの割り当て: ok');

// ---- エクストラ 2 人だけ、1 人 4 色×3 個（公式の 3 色×4 個だと先手必勝と分かったため） ----
{
  const g = E.newGame(2, () => 0);
  assert.deepEqual(Object.keys(g.hand[0]).map(Number).sort(), [0, 1, 2, 6], '先手の持ち色が 0,1,2,6 でない');
  assert.deepEqual(Object.keys(g.hand[1]).map(Number).sort(), [3, 4, 5, 7], '後手の持ち色が 3,4,5,7 でない');
  assert.ok(Object.values(g.hand[0]).every((n) => n === 3), '先手の持ち数が 4 色×3 個でない');
  assert.ok(Object.values(g.hand[1]).every((n) => n === 3), '後手の持ち数が 4 色×3 個でない');
  assert.equal(E.colorOwner(2, 6), 0, '色 6 の持ち主が先手でない');
  assert.equal(E.colorOwner(2, 7), 1, '色 7 の持ち主が後手でない');
  // 公式（game.js）は今まで通り 1 人 3 色×4 個のまま
  assert.deepEqual(Object.keys(newGame(2, () => 0).hand[0]).map(Number).sort(), [0, 1, 2], '公式の先手の持ち色が変わってしまった');
}
console.log('エクストラ 2 人の 4 色×3 個: ok');

// ---- 「下にしたい面」をタップしたときの対応（FACE_TILT）。その面がちょうど下（y=0）に来る ----
{
  const faceCells = (key) => {
    const [axis, side] = [key[0], key[1]];
    const v = side === '+' ? 2 : 0;
    const cells = [];
    for (let x = 0; x < E.N; x++) for (let y = 0; y < E.N; y++) for (let z = 0; z < E.N; z++) {
      const c = { x, y, z }[axis];
      if (c === v) cells.push(E.idx(x, y, z));
    }
    return cells;
  };
  for (const [key, move] of Object.entries(E.FACE_TILT)) {
    let b = E.newBoard();
    faceCells(key).forEach((i) => { b[i] = 1; }); // 選んだ面だけ埋める
    const after = move.type === 'flip' ? E.gravity(E.flipBoard(b)) : E.gravity(E.rotateWhole(b, move.axis, move.dir));
    for (let i = 0; i < E.TOTAL; i++) {
      if (after[i] === E.EMPTY) continue;
      assert.equal(E.coordsOf(i).y, 0, `面 ${key} の手のあと、その面が下に来ていない`);
    }
    assert.equal(after.filter((v) => v !== E.EMPTY).length, 9, `面 ${key} の手で箱の数が変わった`);
  }
}
console.log('エクストラ 面 → 倒す手の対応: ok');

console.log('すべて合格（エクストラルール）');

// ==========================================================================
// ---- CPU（cpu/engine.mjs・cpu/cpu.mjs）。標準ルール・2 人のみ ----
// ==========================================================================
{
  const { readFileSync } = await import('node:fs');
  const E = await import('./cpu/engine.mjs');
  const { pickMove } = await import('./cpu/cpu.mjs');
  const wbuf = readFileSync(new URL('./cpu/pat.w', import.meta.url));
  E.loadPatWeights(new Float32Array(wbuf.buffer, wbuf.byteOffset, wbuf.byteLength / 4));

  // ---- 古い保存データ（seen がなく prev だけ）の引き継ぎ ----
  {
    const old = { v: 1, players: 2, turn: 0, board: newBoard(), prev: null, hand: [], moves: 0 };
    const migrated = migrateSeen(old);
    assert.deepEqual(migrated.seen, [old.board], 'prev がないときの引き継ぎが違う');
    const old2 = { ...old, prev: newBoard() };
    const migrated2 = migrateSeen(old2);
    assert.deepEqual(migrated2.seen, [old2.prev, old2.board], 'prev があるときの引き継ぎが違う');
    const already = { ...old, seen: [old.board] };
    assert.strictEqual(migrateSeen(already), already, 'すでに seen がある状態を余計に作り直している');
  }
  console.log('CPU: 古い保存データの引き継ぎ: ok');

  // ---- engine の合法手が game.js の legalMoves と一致するか（乱数対局 2000 局、標準ルール 2 人） ----
  {
    const moveKey = (m) => `${m.type}|${m.color ?? ''}|${m.col ?? ''}|${m.tier ?? ''}|${m.dir ?? ''}`;
    for (let gi = 0; gi < 2000; gi++) {
      let g = newGame(2, Math.random);
      for (let step = 0; step < 40 && !g.over; step++) {
        const expected = new Set(legalMoves(g).map(moveKey));
        const pos = E.fromAppState(g);
        const mv = new Array(E.NMOVES), ch = new Array(E.NMOVES);
        const n = E.genMoves(pos, mv, ch);
        const actual = new Set();
        for (let i = 0; i < n; i++) actual.add(moveKey(E.toAppMove(pos, mv[i])));
        assert.equal(actual.size, expected.size, `合法手の数が合わない（対局 ${gi}、${step} 手目）`);
        for (const k of expected) assert.ok(actual.has(k), `game.js にあって engine にない手（対局 ${gi}、${step} 手目）: ${k}`);
        const moves = legalMoves(g);
        g = applyMove(g, moves[Math.floor(Math.random() * moves.length)]);
      }
    }
  }
  console.log('CPU: engine の合法手が game.js と一致（乱数対局 2000 局）: ok');

  // ---- CPU が常に合法手を返すか ----
  for (const level of ['strong']) {
    let g = newGame(2, () => 0);
    for (let i = 0; i < 6 && !g.over; i++) {
      const pos = E.fromAppState(g);
      const mv = pickMove(pos, level);
      const move = E.toAppMove(pos, mv);
      assert.ok(isLegal(g, move), `CPU（${level}）の手が合法手でない（${i} 手目）: ${JSON.stringify(move)}`);
      g = applyMove(g, move);
    }
  }
  console.log('CPU: 合法手を返す: ok');

  // ---- 観戦（CPU どうし）が 200 手以内に終わるか。スーパーコウで「一度出た形」自体が禁止なので、
  // 引き延ばし対策がなくても終わらないループは原理上起きない。念のため上限つきで確かめる ----
  for (let gi = 0; gi < 3; gi++) {
    let g = newGame(2, Math.random);
    let moves = 0;
    while (!g.over && moves < 200) {
      const pos = E.fromAppState(g);
      const mv = pickMove(pos, 'normal');
      const move = E.toAppMove(pos, mv);
      assert.ok(isLegal(g, move), `観戦シミュレーションで CPU が反則手を選んだ（${moves} 手目）`);
      g = applyMove(g, move);
      moves++;
    }
    assert.ok(g.over, `観戦シミュレーションが 200 手で終わらない（対局 ${gi}）`);
  }
  console.log('CPU: 観戦シミュレーションが 200 手以内に終わる: ok');
}

// ---- エクストラの CPU（cpu/extra.mjs）: 合法手を返し、1 手で勝てるなら勝つ ----
{
  const { pickMove } = await import('./cpu/extra.mjs');
  let g = E.newGame(2, () => 0);
  for (let i = 0; i < 6 && !g.over; i++) {
    const move = pickMove(g, 200);
    assert.ok(E.isLegal(g, move), `エクストラの CPU の手が合法手でない（${i} 手目）: ${JSON.stringify(move)}`);
    g = E.applyMove(g, move);
  }
  // 先手（色 0）が (0,0,0)・(1,0,0) に置いてある。(2,0,0) に色 0 を落とせば勝ち
  let w = E.newGame(2, () => 0);
  w = { ...w, board: E.drop(E.drop(w.board, 0, 0, 0), 1, 0, 0), hand: [{ 0: 1, 1: 3, 2: 3, 6: 3 }, w.hand[1]] };
  const m = pickMove(w, 500);
  assert.ok(E.applyMove(w, m).winner === 0, `1 手で勝てるのに勝たない: ${JSON.stringify(m)}`);
}
console.log('エクストラの CPU: ok');
console.log('すべて合格（CPU）');
