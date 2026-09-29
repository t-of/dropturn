// 遊びの中身の確かめ。node test.mjs
import assert from 'node:assert/strict';
import {
  EMPTY, idx, LINES, PLAYER_COLORS, newBoard, drop, canDrop, rotateBoard, flipBoard, gravity,
  boardsEqual, newGame, legalMoves, isLegal, applyMove, judgeBoard, colorOwner,
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
  let g = { ...newGame(2, () => 0), board: a };
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
  let g = { ...newGame(2, () => 0), board: a };
  g = applyMove(g, { type: 'rotate', tier: 0, dir: 1 });
  assert.equal(isLegal(g, { type: 'rotate', tier: 2, dir: 1 }), false, 'かごごと回した形に戻る手が指せてしまう');
  assert.equal(isLegal(g, { type: 'rotate', tier: 2, dir: -1 }), true, '戻らない手が禁止されている');
}
console.log('戻す手の禁止: ok');

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
  let g = { ...E.newGame(2, () => 0), board: a };
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

console.log('すべて合格（エクストラルール）');
