"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("./lib/confidence");

test("6 de 8 acertos NÃO é confiança alta (amostra pequena)", () => {
  assert.notEqual(C.classify(6, 8, 1).label, "alta");
});

test("amostra sobreposta: 40 sinais com H=21 viram ~1 bloco independente, nunca alta", () => {
  assert.equal(C.effectiveN(40, 21), 1);
  assert.notEqual(C.classify(40, 40, 21).label, "alta");
});

test("alta exige tamanho efetivo >= 10 e limite de Wilson >= 55%", () => {
  assert.equal(C.classify(100, 100, 1).label, "alta");
  assert.notEqual(C.classify(50, 100, 1).label, "alta");
  assert.notEqual(C.classify(100, 100, 20).label, "alta"); // nEff = 5
});

test("ruído: falso 'alta' abaixo de 1% (determinístico)", () => {
  let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const trials = 20000; let alta = 0;
  for (let t = 0; t < trials; t++) {
    let c = 0; for (let i = 0; i < 40; i++) if (rnd() < 0.5) c++;
    if (C.classify(c, 40, 1).label === "alta") alta++;
  }
  assert.ok(alta / trials < 0.01, "falsos alta = " + (100 * alta / trials).toFixed(2) + "%");
});

test("Wilson: monotônico e 0 sem amostra", () => {
  assert.equal(C.wilsonLower(0.5, 0), 0);
  assert.ok(C.wilsonLower(0.6, 100) > C.wilsonLower(0.6, 10));
});
