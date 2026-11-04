"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const N = require("./lib/neural");

function rng(seed) { let x = (seed >>> 0) || 1; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296; }
const gauss = r => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
function noise(n, seed) { const r = rng(seed), c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(0.01 * gauss(r))); return c; }
function ar(n, seed, phi) {
  const r = rng(seed), c = [100]; let prev = 0;
  for (let i = 1; i < n; i++) { const ret = phi * prev + 0.01 * gauss(r); c.push(c[i - 1] * Math.exp(ret)); prev = ret; }
  return c;
}

test("sem vazamento: características em t não mudam se o preço depois de t mudar", () => {
  const a = noise(300, 4), t = 200;
  const b = a.slice(0, t + 1).concat(noise(100, 9).map(x => x * a[t] / 100));
  assert.deepEqual(N.features(a, t), N.features(b, t));
});

test("características nulas sem histórico suficiente", () => {
  assert.equal(N.features(noise(100, 1), N.MIN_HIST - 1), null);
});

test("determinístico: mesma entrada, mesmo resultado", () => {
  const c = ar(500, 2, 0.3);
  assert.deepEqual(N.walkForward(c, 1), N.walkForward(c, 1));
});

test("ruído puro: acerto perto de 50% e nunca confiança alta", () => {
  const r = N.walkForward(noise(1200, 7), 1);
  assert.ok(r.acc > 0.42 && r.acc < 0.58, "acerto = " + r.acc);
  assert.notEqual(r.label, "alta");
});

test("série com memória (AR 0,3): acerto acima de 53% e rótulo não é baixa", () => {
  const r = N.walkForward(ar(1200, 3, 0.3), 1);
  assert.ok(r.acc > 0.53, "acerto = " + r.acc);
  assert.notEqual(r.label, "baixa");
});
