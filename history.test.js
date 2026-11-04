"use strict";
const os = require("os"), fs = require("fs"), path = require("path");
process.env.HISTORY_DIR = path.join(os.tmpdir(), "bolsai-hist-test-" + process.pid);
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./lib/history");
after(() => fs.rmSync(process.env.HISTORY_DIR, { recursive: true, force: true }));

const DAY = 86400000, T0 = Date.parse("2026-01-01T00:00:00Z");
const serie = (n, f = i => 10 + i * 0.1) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, o: f(i), h: f(i), l: f(i), c: f(i) }));

test("arquivo de mercado: mescla, dedupe, descarta a última vela e grava atomicamente", () => {
  assert.equal(H.archiveCandles("TST1", serie(10)), true);
  // segunda carga com 12 velas: as 9 primeiras (sem a última) se repetem e são sobrescritas
  H.archiveCandles("TST1", serie(12), true);
  const rows = H.readMarket("TST1");
  assert.equal(rows.length, 11);                       // 12 - 1 aberta = 11 (dedupe por t)
  assert.deepEqual(rows.map(r => r[0]), [...rows.map(r => r[0])].sort((a, b) => a - b));
  assert.ok(!fs.existsSync(path.join(process.env.HISTORY_DIR, "mercado", "TST1.json.tmp")));
});

test("sinais: grava na mudança e não repete sem mudança", () => {
  const a = { sym: "TST1", mkt: "BR", price: 12, baseT: T0, finals: { "1s": "buy", "1m": "wait", "5m": "wait" },
    analyses: { "1s": { rec: "buy", sig: "buy", conf: "média", H: 5, st: { pUp: 0.7, med: 0.02, n: 30 } } } };
  assert.equal(H.recordSignals(a), true);
  assert.equal(H.recordSignals(a), false);               // mesmo sinal, logo depois: não grava
  a.finals = { "1s": "avoid", "1m": "wait", "5m": "wait" };
  assert.equal(H.recordSignals(a), true);                // mudou: grava
});

test("conferência: acerto e erro com o preço real depois de H períodos", () => {
  const base = T0 + 2 * DAY;                              // candle base: i=2, preço 10.2
  const f = i => (i >= 2 ? 10 + i * 0.1 : 10 + i * 0.1);
  // mercado com alta: buy deve acertar, avoid deve errar (horizonte 3)
  H.archiveCandles("TST2", serie(30, f), true);
  H.recordSignals({ sym: "TST2", mkt: "US", price: 1, baseT: base, finals: { "1s": "buy" },
    analyses: { "1s": { rec: "buy", sig: "buy", conf: "baixa", H: 3, st: { pUp: 0.6, med: 0.01, n: 20 } } } });
  H.recordSignals({ sym: "TST2", mkt: "US", price: 1, baseT: base + DAY, finals: { "1s": "avoid" },
    analyses: { "1s": { rec: "avoid", sig: "avoid", conf: "baixa", H: 3, st: { pUp: 0.4, med: -0.01, n: 20 } } } });
  const novos = H.grade();
  assert.ok(novos >= 2);
  const res = fs.readFileSync(path.join(process.env.HISTORY_DIR, "resultados.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const buy = res.find(x => x.sym === "TST2" && x.rec === "buy");
  const avoid = res.find(x => x.sym === "TST2" && x.rec === "avoid");
  assert.equal(buy.hit, true);
  assert.equal(avoid.hit, false);
  // entrada no candle base (i=2, fechamento 10.2) e saída 3 candles depois (i=5, fechamento 10.5)
  assert.equal(buy.entry, 10.2);
  assert.equal(buy.exit, 10.5);
  assert.ok(Math.abs(buy.ret - (10.5 / 10.2 - 1)) < 1e-4);
  // reconferir não duplica
  assert.equal(H.grade(), 0);
});

test("pendente: sem o candle final ainda, não confere", () => {
  H.recordSignals({ sym: "TST3", mkt: "US", price: 1, baseT: T0, finals: { "1s": "buy" },
    analyses: { "1s": { rec: "buy", sig: "buy", conf: "baixa", H: 50, st: { pUp: 0.6, med: 0.01, n: 20 } } } });
  H.archiveCandles("TST3", serie(20), true);             // só 19 velas: H=50 não existe ainda
  H.grade();
  const res = fs.readFileSync(path.join(process.env.HISTORY_DIR, "resultados.jsonl"), "utf8");
  assert.ok(!res.includes('"sym":"TST3"'));
});

test("exportação e resumo", () => {
  const sin = H.exportar("sinais").trim().split("\n");
  assert.ok(sin.length >= 3 && JSON.parse(sin[0]).sym === "TST1");
  const mer = H.exportar("mercado").trim().split("\n").map(JSON.parse);
  assert.ok(mer.length > 0 && mer[0].sym && mer[0].t && mer[0].c);
  assert.equal(H.exportar("lixo"), null);
  const s = H.summary();
  assert.ok(s.resultados >= 2 && s.previsoesReais["1s"].n >= 2);
});

test("arquivo corrompido não derruba a leitura", () => {
  fs.appendFileSync(path.join(process.env.HISTORY_DIR, "resultados.jsonl"), "{linha quebrada\n");
  const s = H.summary();
  assert.ok(s.resultados >= 2);
});
