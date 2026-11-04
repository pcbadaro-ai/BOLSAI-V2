"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchBinanceDaily } = require("./binance");

// Gera velas diárias falsas (ms, abertura/fechamento) terminando "hoje".
function klines(n, endMs = Date.now()) {
  const out = []; const step = 864e5; let p = 100;
  for (let i = n - 1; i >= 0; i--) {
    const t = endMs - i * step; p *= 1.001;
    out.push([t, String(p), String(p * 1.01), String(p * 0.99), String(p), "0", t + step - 1]);
  }
  return out;
}
const resp = (ok, status, body) => ({ ok, status, json: async () => body });

test("Binance: usa o segundo host quando o primeiro responde 451 (BTC não cai no Yahoo)", async () => {
  const chamadas = [];
  const fetchT = async (url) => {
    chamadas.push(url);
    if (url.startsWith("https://api.binance.com")) return resp(false, 451, {});
    if (url.includes("/klines")) return resp(true, 200, klines(300));
    return resp(true, 200, { lastPrice: "123.5", prevClosePrice: "120" });
  };
  const r = await fetchBinanceDaily(fetchT, "BTCUSDT", { pages: 1 });
  assert.equal(r.host, "https://data-api.binance.vision");
  assert.equal(r.price, 123.5);
  assert.equal(r.open24, 120);
  assert.ok(r.candles.length >= 50);
  assert.ok(chamadas.some(u => u.startsWith("https://data-api.binance.vision")));
});

test("Binance: se todos os hosts falham, o erro lista o motivo de cada um", async () => {
  const fetchT = async () => resp(false, 451, {});
  await assert.rejects(
    fetchBinanceDaily(fetchT, "BTCUSDT", { pages: 1 }),
    e => /451/.test(e.message) && /api\.binance\.com/.test(e.message) && /data-api/.test(e.message)
  );
});

test("Binance: velas duplicadas e com preço zero são descartadas", async () => {
  const rows = klines(120);
  rows.push(rows[5].slice()); // duplicada
  rows.push([rows.at(-1)[0] + 864e5, "0", "0", "0", "0", "0", 0]); // preço zero
  const fetchT = async (url) => url.includes("/klines") ? resp(true, 200, rows) : resp(false, 404, {});
  const r = await fetchBinanceDaily(fetchT, "BTCUSDT", { pages: 1, hosts: ["https://x"] });
  const ts = r.candles.map(c => c.t);
  assert.equal(new Set(ts).size, ts.length, "sem datas repetidas");
  assert.ok(r.candles.every(c => c.c > 0), "sem preço zero");
});
