"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../analysis");
const WF = require("./walkforward");
const { trendLabels, volLabels } = require("../lib/regime");

function walk(n, seed, vol = 0.02, drift = 0) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(drift + vol * g()));
  return c;
}

test("calibração do treino não enxerga preços depois do fim do treino (sem vazamento)", () => {
  const a = walk(1100, 31), H = 5, trainEnd = 600, testEnd = 800;
  // b é igual a a até o fim do treino e diferente depois: treino e calibração têm de ser idênticos
  const b = a.slice(0, trainEnd).concat(walk(1100 - trainEnd, 77, 0.05).map(x => x * a[trainEnd - 1] / 100));
  const ra = WF.runFold(a, H, trainEnd, testEnd), rb = WF.runFold(b, H, trainEnd, testEnd);
  assert.deepEqual(ra.cfg, rb.cfg, "a configuração escolhida mudou com dados do futuro");
  assert.deepEqual(ra.treino, rb.treino, "métricas de treino mudaram com dados do futuro");
  // e o teste, sim, muda (sanity: o fora da amostra usa o que aconteceu)
  assert.notDeepEqual(ra.oos.map(r => r.actual), rb.oos.map(r => r.actual));
});

test("blocos de teste são disjuntos, consecutivos e cobrem até o fim", () => {
  const f = WF.foldLayout(1000, 5);
  assert.equal(f.length, 5);
  assert.equal(f[4].testEnd, 1000);
  for (let i = 1; i < f.length; i++) assert.equal(f[i].trainEnd, f[i - 1].testEnd);
  assert.equal(f[0].trainEnd, 500); // primeiro treino = metade da história
});

test("a validação não deixa a configuração ao vivo alterada", () => {
  const before = A.getParams();
  WF.runFold(walk(900, 4), 5, 450, 650);
  const after = A.getParams();
  assert.equal(after.PUP, before.PUP); assert.equal(after.THR, before.THR); assert.equal(after.TREND, before.TREND);
});

test("ruído puro: a validação não declara vantagem fora da amostra", () => {
  const results = [1, 2, 3, 4, 5, 6].map(seed => WF.walkForward("R" + seed, walk(1400, seed), 5, { folds: 4, cost: 0.002 }));
  const agg = WF.aggregate(results, 5, 0.002);
  assert.notEqual(agg.veredito, "vantagem fora da amostra", JSON.stringify(agg.agregado));
});

test("regimes: tendência de alta termina em 'alta', de baixa termina em 'baixa'", () => {
  const up = walk(600, 9, 0.005, 0.004), down = walk(600, 9, 0.005, -0.004);
  assert.equal(trendLabels(up).at(-1), "alta");
  assert.equal(trendLabels(down).at(-1), "baixa");
  assert.equal(trendLabels(walk(100, 1))[99], null); // antes de 200 + 20 dias não há rótulo
});

test("volatilidade: choque recente vira vol_alta", () => {
  const calm = walk(400, 5, 0.008), shock = walk(21, 6, 0.06).slice(1);
  const c = calm.concat(shock.map(x => calm.at(-1) * x / 100));
  assert.equal(volLabels(c).at(-1), "vol_alta");
  assert.equal(volLabels(calm).at(-1), "vol_normal");
});

test("custo de transação reduz o retorno líquido das compras", () => {
  const r = WF.walkForward("X", walk(1200, 12), 5, { folds: 3 });
  const a0 = WF.aggregate([r], 5, 0).agregado.retornoLiquidoMedio;
  const a1 = WF.aggregate([r], 5, 0.01).agregado.retornoLiquidoMedio;
  if (a0 != null) assert.ok(Math.abs((a0 - a1) - 0.01) < 1e-9);
});
