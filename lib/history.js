"use strict";
/*
 * Histórico persistente (sobrevive a desligar e ligar o servidor no Render).
 *
 * Três arquivos dentro de HISTORY_DIR (no Render: /var/data, disco persistente):
 *  - mercado/<SYM>.json   candles diários arquivados [t, o, h, l, c]. Mescla os dados novos dos
 *                         provedores com os antigos; a vela de hoje (ainda aberta) fica de fora.
 *  - sinais.jsonl         um registro cada vez que o sinal de um horizonte muda, ou a cada 6 h.
 *  - resultados.jsonl     cada sinal de compra ou de evitar conferido com o preço real depois de H períodos.
 *
 * Tudo que é gravado aqui é o que o modelo *disse na época* e o que o mercado *fez depois*.
 * Isso é teste para a frente (forward), que o backtest não consegue dar.
 * Nenhuma escrita derruba o servidor: erros ficam em lastError.
 */
const fs = require("fs");
const path = require("path");

const DIR = process.env.HISTORY_DIR || path.join(__dirname, "..", "data");
const MERCADO = path.join(DIR, "mercado");
const SIG = path.join(DIR, "sinais.jsonl");
const RES = path.join(DIR, "resultados.jsonl");
const SNAP_EVERY = 6 * 3600 * 1000;   // registro periódico mesmo sem mudança de sinal
const ARCH_EVERY = 6 * 3600 * 1000;   // reescreve o arquivo de mercado no máximo a cada 6 h por ativo

let lastError = null;
const lastSnap = new Map();   // sym -> { key, ts }
const lastArch = new Map();   // sym -> ts
let summaryCache = null, summaryAt = 0;

function safe(fn, fallback) {
  try { return fn(); } catch (e) { lastError = e.message; return fallback; }
}

function ensureDirs() {
  fs.mkdirSync(MERCADO, { recursive: true });
}

function fileSafe(sym) {
  return String(sym).replace(/[^A-Za-z0-9_-]/g, "_");
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* linha corrompida: ignora */ }
  }
  return out;
}

function append(file, obj) {
  ensureDirs();
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

const r = (v, d) => (Number.isFinite(v) ? +v.toFixed(d) : null);

function init() {
  return safe(() => {
    ensureDirs();
    const sinais = readLines(SIG).length;
    const resultados = readLines(RES).length;
    return { ok: true, dir: DIR, sinais, resultados };
  }, { ok: false, dir: DIR, err: lastError });
}

/* ---------- Mercado arquivado ---------- */
function readMarket(sym) {
  const f = path.join(MERCADO, fileSafe(sym) + ".json");
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// candles: [{t, o, h, l, c}] vindos dos provedores. Grava no máximo a cada ARCH_EVERY por ativo.
function archiveCandles(sym, candles, force = false) {
  if (!Array.isArray(candles) || candles.length < 2) return false;
  const now = Date.now();
  if (!force && lastArch.has(sym) && now - lastArch.get(sym) < ARCH_EVERY) return false;
  return safe(() => {
    ensureDirs();
    const map = new Map();
    for (const row of readMarket(sym)) map.set(row[0], row);
    // a última vela pode estar aberta (dia de hoje): não arquiva
    for (const c of candles.slice(0, -1)) {
      if (!(c.c > 0)) continue;
      map.set(c.t, [c.t, c.o, c.h, c.l, c.c]);
    }
    const rows = [...map.values()].sort((a, b) => a[0] - b[0]);
    const f = path.join(MERCADO, fileSafe(sym) + ".json");
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, f);   // troca atômica: queda no meio não corrompe o arquivo
    lastArch.set(sym, now);
    return true;
  }, false);
}

/* ---------- Sinais ao vivo ---------- */
// a: ativo com analyses/finals/baseT. Grava quando algum sinal muda ou a cada SNAP_EVERY.
function recordSignals(a) {
  if (!a || !a.analyses || !a.finals) return false;
  return safe(() => {
    const now = Date.now();
    const key = JSON.stringify(a.finals);
    const prev = lastSnap.get(a.sym);
    if (prev && prev.key === key && now - prev.ts < SNAP_EVERY) return false;
    const horizons = {};
    for (const [k, res] of Object.entries(a.analyses)) {
      horizons[k] = {
        rec: res.rec, sig: res.sig, conf: res.conf, H: res.H,
        pUp: r(res.st && res.st.pUp, 3), med: r(res.st && res.st.med, 4), n: res.st ? res.st.n : null
      };
    }
    append(SIG, {
      ts: now, sym: a.sym, mkt: a.mkt || null, price: a.price,
      base: a.baseT || null, finals: a.finals, horizons
    });
    lastSnap.set(a.sym, { key, ts: now });
    return true;
  }, false);
}

/* ---------- Conferência com o preço real ---------- */
// Para cada sinal de compra/evitar (último registro de cada ativo, horizonte e dia-base),
// espera o candle base+H no mercado arquivado e grava acerto ou erro.
function grade() {
  return safe(() => {
    const sinais = readLines(SIG);
    if (!sinais.length) return 0;
    const feitos = new Set(readLines(RES).map(x => `${x.sym}|${x.hzn}|${x.base}`));
    const pendentes = new Map();
    for (const s of sinais) {               // ordem cronológica: o último vence
      if (!s.base || !s.horizons) continue;
      for (const [hzn, h] of Object.entries(s.horizons)) {
        if (h.rec !== "buy" && h.rec !== "avoid") continue;
        const k = `${s.sym}|${hzn}|${s.base}`;
        if (feitos.has(k)) continue;
        pendentes.set(k, { sym: s.sym, hzn, base: s.base, rec: h.rec, H: h.H });
      }
    }
    const cache = new Map();
    let novos = 0;
    for (const p of pendentes.values()) {
      if (!cache.has(p.sym)) cache.set(p.sym, readMarket(p.sym));
      const candles = cache.get(p.sym);
      const i = candles.findIndex(c => c[0] === p.base);
      if (i < 0 || !p.H || i + p.H >= candles.length) continue;   // o preço final ainda não chegou
      const entry = candles[i][4], exit = candles[i + p.H][4];
      const ret = exit / entry - 1;
      const hit = p.rec === "buy" ? ret > 0 : ret < 0;
      append(RES, {
        ts: Date.now(), sym: p.sym, hzn: p.hzn, rec: p.rec, H: p.H,
        base: p.base, entry, exit, ret: r(ret, 5), hit
      });
      novos++;
    }
    summaryCache = null;
    return novos;
  }, 0);
}

function summary() {
  if (summaryCache && Date.now() - summaryAt < 60000) return summaryCache;
  return safe(() => {
    const res = readLines(RES);
    const porHorizonte = {};
    for (const x of res) {
      const o = porHorizonte[x.hzn] || (porHorizonte[x.hzn] = { n: 0, acertos: 0 });
      o.n++; if (x.hit) o.acertos++;
    }
    for (const o of Object.values(porHorizonte)) o.acerto = o.n ? r(o.acertos / o.n, 3) : null;
    summaryCache = { sinais: readLines(SIG).length, resultados: res.length, previsoesReais: porHorizonte };
    summaryAt = Date.now();
    return summaryCache;
  }, { sinais: 0, resultados: 0, previsoesReais: {}, erro: lastError });
}

/* ---------- Exportação (o que você baixa e me envia) ---------- */
// tipo: "sinais" | "resultados" | "mercado". Devolve texto JSONL.
function exportar(tipo) {
  return safe(() => {
    if (tipo === "sinais") return fs.existsSync(SIG) ? fs.readFileSync(SIG, "utf8") : "";
    if (tipo === "resultados") return fs.existsSync(RES) ? fs.readFileSync(RES, "utf8") : "";
    if (tipo === "mercado") {
      if (!fs.existsSync(MERCADO)) return "";
      const linhas = [];
      for (const f of fs.readdirSync(MERCADO).filter(x => x.endsWith(".json")).sort()) {
        const sym = f.slice(0, -5);
        for (const [t, o, h, l, c] of JSON.parse(fs.readFileSync(path.join(MERCADO, f), "utf8")))
          linhas.push(JSON.stringify({ sym, t, o, h, l, c }));
      }
      return linhas.join("\n") + (linhas.length ? "\n" : "");
    }
    return null;
  }, null);
}

module.exports = {
  DIR, init, archiveCandles, recordSignals, grade, summary, exportar, readMarket,
  get lastError() { return lastError; }
};
