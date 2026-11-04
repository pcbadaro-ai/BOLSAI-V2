"use strict";
/*
 * Velas diárias de cripto pela Binance, com fallback entre hosts.
 * api.binance.com responde HTTP 451 para IPs dos EUA (ex.: Render), o que fazia o BTC cair no Yahoo
 * e, se o Yahoo também falhasse, aparecer sem preço. data-api.binance.vision é o host público de
 * dados de mercado e não tem esse bloqueio, por isso entra como segunda tentativa.
 */
const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function klinesFrom(fetchT, host, pair, pages) {
  const all = [];
  let endTime = Date.now();
  for (let page = 0; page < pages; page++) {
    const url = host + "/api/v3/klines?symbol=" + pair + "&interval=1d&limit=1000&endTime=" + endTime;
    const r = await fetchT(url, {}, 15000);
    if (!r.ok) throw new Error("HTTP " + r.status + " em " + host);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) all.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    endTime = rows[0][0] - 1;
    if (rows.length < 1000) break;
    await sleep(120);
  }
  return all;
}

async function tickerFrom(fetchT, host, pair) {
  try {
    const tr = await fetchT(host + "/api/v3/ticker/24hr?symbol=" + pair, {}, 10000);
    if (!tr.ok) return null;
    return await tr.json();
  } catch { return null; }
}

/**
 * Tenta cada host em ordem. Retorna { candles, price, open24, src, host } ou lança com o motivo de cada um.
 * fetchT(url, opts, timeout) é injetado para facilitar testes.
 */
async function fetchBinanceDaily(fetchT, pair, { pages = 5, hosts = HOSTS } = {}) {
  const errs = [];
  for (const host of hosts) {
    try {
      const raw = await klinesFrom(fetchT, host, pair, pages);
      if (raw.length < 50) throw new Error("sem dados suficientes (" + raw.length + " velas)");
      raw.sort((a, b) => a.t - b.t);
      const seen = new Set();
      const candles = raw.filter(c => {
        if (!(c.c > 0) || seen.has(c.t)) return false;
        seen.add(c.t);
        return true;
      });
      let price = candles.at(-1).c, open24 = candles.length >= 2 ? candles.at(-2).c : price;
      const j = await tickerFrom(fetchT, host, pair);
      if (j) {
        if (+j.lastPrice > 0) price = +j.lastPrice;
        if (+j.prevClosePrice > 0) open24 = +j.prevClosePrice;
      }
      return { candles, price, open24, src: "Binance", host };
    } catch (e) {
      errs.push(host + ": " + e.message);
    }
  }
  throw new Error("Binance indisponível (" + errs.join(" | ") + ")");
}

module.exports = { fetchBinanceDaily, HOSTS };
