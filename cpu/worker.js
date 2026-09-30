// CPU の手を考える Web Worker。DOM に触らず、ここで探索するので画面は止まらない。
// 2 人の state を受け取り、公式は cpu.mjs（engine.mjs）、エクストラは extra.mjs で手を選んで返す。
'use strict';

import * as engine from './engine.mjs';
import { pickMove } from './cpu.mjs';
import { pickMove as pickExtra } from './extra.mjs';

const weightsReady = fetch(new URL('./pat.w', import.meta.url))
  .then((r) => r.arrayBuffer())
  .then((buf) => engine.loadPatWeights(new Float32Array(buf)));

self.onmessage = async (e) => {
  const { state, reqId } = e.data;
  if (state.rules === 'extra') { self.postMessage({ reqId, move: pickExtra(state) }); return; }
  await weightsReady;
  const pos = engine.fromAppState(state);
  const mv = pickMove(pos, 'strong');
  self.postMessage({ reqId, move: engine.toAppMove(pos, mv) });
};
