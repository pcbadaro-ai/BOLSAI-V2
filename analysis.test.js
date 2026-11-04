"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("./analysis");

function walk(n, seed, vol = 0.015, drift = 0) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(drift + vol * g())); return c;
}

test("SEM OLHAR O FUTURO: sinais até o dia T não mudam se os preços depois de T mudarem", () => {
  const H = 5, T = 650, split = 300;
  const a = walk(900, 11), b = a.slice(0, T + 1).concat(walk(900 - T - 1, 99, 0.05).map(x => x * a[T] / 100));
  const sa = A.backtestSignals(A.buildModel(a, H, split)).filter(r => r.t + H <= T);
  const sb = A.backtestSignals(A.buildModel(b, H, split)).filter(r => r.t + H <= T);
  assert.ok(sa.length > 100);
  assert.deepEqual(sa.map(r => [r.t, r.sig]), sb.map(r => [r.t, r.sig]));
});

test("ruído puro: acerto perto de 50% e quase nunca confiança alta", () => {
  // confiança alta: 8 passeios (taxa esperada ~2%; mais de 1 em 8 seria sinal de falso positivo)
  let alta = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = A.analyze(walk(1500, seed), 5, null);
    assert.ok(r && r.st.n >= 12);
    if (r.conf === "alta") alta++;
  }
  assert.ok(alta <= 1, "confiança alta em " + alta + " de 8 passeios aleatórios");
  // vantagem das compras: 40 passeios, média ponderada pelo nº de compras independentes (nEff).
  // Com 8 passeios o erro padrão é ~0,1 e o teste ficava no acaso; com 40 o erro cai para ~0,03.
  let num = 0, den = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const r = A.analyze(walk(1500, seed), 5, null);
    if (r && r.bt.buyWin != null && r.bt.nEff > 0) { num += (r.bt.buyWin - r.bt.base) * r.bt.nEff; den += r.bt.nEff; }
  }
  const avg = den ? num / den : 0;
  assert.ok(Math.abs(avg) < 0.1, "vantagem média ponderada em ruído = " + avg);
});

test("histórico curto: sem análise em vez de chute", () => {
  assert.equal(A.analyze(walk(200, 3), 5, null), null);
  assert.equal(A.analyze(walk(400, 3), 105, null), null);
});

test("regime de volatilidade: choque recente rebaixa 'Comprar' e é informado", () => {
  const calm = walk(420, 5, 0.008), shock = walk(21, 6, 0.04).slice(1);
  const c = calm.concat(shock.map((x, i) => calm.at(-1) * x / 100));
  const v = A.volRegime(c);
  assert.ok(v.ratio >= A.VOL_CAP, "ratio=" + v.ratio);
  const r = A.analyze(c, 5, null);
  assert.ok(r.volRatio >= A.VOL_CAP); assert.notEqual(r.rec, "buy");
  assert.equal(A.volRegime(walk(100, 1)).ratio, null);
});

test("reancoragem no preço atual e Wilson", () => {
  const c = walk(900, 21), base = A.analyze(c, 5, null), up = A.analyze(c, 5, c.at(-1) * 1.05);
  assert.ok(Math.abs(up.shift - 0.05) < 1e-9);
  assert.ok(up.st.med < base.st.med, "com preço 5% acima, o retorno esperado cai");
  assert.ok(A.wilsonLower(0.6, 100) < 0.6 && A.wilsonLower(0.6, 10) < A.wilsonLower(0.6, 100));
  assert.equal(A.wilsonLower(0.5, 0), 0);
});
