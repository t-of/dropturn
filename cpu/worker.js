// CPU の手を考える Web Worker。DOM に触らず、ここで探索するので画面は止まらない。
// game.js の state（2 人・公式ルールのみ）を受け取り、cpu.mjs（engine.mjs）で手を選んで返す。
'use strict';

import * as engine from './engine.mjs';
import { pickMove } from './cpu.mjs';

const weightsReady = fetch(new URL('./pat.w', import.meta.url))
  .then((r) => r.arrayBuffer())
  .then((buf) => engine.loadPatWeights(new Float32Array(buf)));

self.onmessage = async (e) => {
  const { state, level, reqId } = e.data;
  await weightsReady;
  const pos = engine.fromAppState(state);
  const mv = pickMove(pos, level);
  self.postMessage({ reqId, move: engine.toAppMove(pos, mv) });
};
