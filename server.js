"use strict";
/*
 * Sinal Semanal — servidor
 * Preços: cripto (Binance), ações EUA e B3 (Yahoo → Twelve Data → brapi).
 * Análise estatística em worker, notícias reais, IA (Gemini/Groq).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const WebSocket = require("ws");

const yahoo = require("./lib/yahoo");
const news = require("./lib/news");
const bcb = require("./lib/bcb");
const mk = require("./lib/markets");
const { analyze, minHistory } = require("./analysis");
const memory = require("./lib/memory");
const history = require("./lib/history");
const binance = require("./lib/binance");
const logger = require("./lib/logger");

/* Aprovação por evidência: "Comprar" só aparece para ativo/horizonte que passou na checagem de robustez
   (pesquisa/robustez.js grava pesquisa/aprovados.json). Sem o arquivo, ninguém está aprovado. */
const APROVADOS_FILE = path.join(__dirname, "pesquisa", "aprovados.json");
function loadAprovados() {
  try {
    const j = JSON.parse(fs.readFileSync(APROVADOS_FILE, "utf8"));
    return new Set((j.aprovados || []).map(x => String(x.ativo).replace(/\.SA$/, "") + "|" + x.horizonte));
  } catch { return new Set(); }
}
const APROVADOS = loadAprovados();
function aprovado(sym, key) { return APROVADOS.has(sym + "|" + key); }

/* ---------- .env mínimo ---------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const ENV = process.env;
const PORT = +ENV.PORT || 3000;
const GEMINI_KEY = ENV.GEMINI_API_KEY || "";
const GROQ_KEY = ENV.GROQ_API_KEY || "";
const TWELVE = ENV.TWELVEDATA_KEY || "";
const BRAPI = ENV.BRAPI_TOKEN || "";
const AI_EVERY = (+ENV.AI_EVERY_MIN || 30) * 60000;
const AI_CONC = 1;
const MOCK = !!ENV.MOCK;

const HZN = { "1s": 5, "1m": 21, "5m": 105 }; // pregões (ações)
const HZ_NAME = { "1s": "1 semana", "1m": "1 mês", "5m": "5 meses" }; // nomes do painel; 1s/1m/5m são chaves internas
const HZN_C = { "1s": 7, "1m": 30, "5m": 150 }; // dias (cripto)

/* ---------- Universo ---------- */
let universe = {};
try { universe = require("./lib/universe"); } catch (e) { console.log("Aviso universe:", e.message); }
const BR = Array.isArray(universe) ? universe : (universe.BR || universe.acoesBR || universe.BRA || []);
const termsFor = typeof universe.termsFor === "function" ? universe.termsFor : ((n, s) => [n, s].filter(Boolean));

const CRYPTO = [
  ["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["BNB", "BNB"], ["XRP", "XRP"],
  ["SOL", "Solana"], ["TRX", "TRON"], ["DOGE", "Dogecoin"], ["ADA", "Cardano"],
  ["LINK", "Chainlink"], ["AVAX", "Avalanche"]
];
const STOCKS = [
  ["AAPL", "Apple"], ["NVDA", "NVIDIA"], ["MSFT", "Microsoft"], ["GOOGL", "Alphabet"],
  ["AMZN", "Amazon"], ["TSM", "TSMC"], ["TSLA", "Tesla"], ["META", "Meta Platforms"],
  ["AVGO", "Broadcom"], ["LLY", "Eli Lilly"], ["BRK-B", "Berkshire Hathaway"], ["MU", "Micron"],
  ["WMT", "Walmart"], ["JPM", "JPMorgan"], ["AMD", "AMD"], ["V", "Visa"],
  ["XOM", "ExxonMobil"], ["JNJ", "Johnson & Johnson"], ["ASML", "ASML"], ["MA", "Mastercard"]
];

const assets = new Map();
for (const [s, n] of CRYPTO) {
  assets.set(s, { kind: "crypto", mkt: "CRYPTO", ccy: "USD", sym: s, name: n, pair: s + "USDT", H: 7, ysyms: [s + "-USD"], terms: [s, n] });
}
for (const [s, n] of STOCKS) {
  assets.set(s, { kind: "stock", mkt: "US", ccy: "USD", sym: s, name: n, H: 5, ysyms: [s], terms: [s, n] });
}
for (const b of BR) {
  if (b && b.sym) {
    assets.set(b.sym, {
      kind: "stock", mkt: "BR", ccy: "BRL", sym: b.sym, name: b.name || b.sym,
      H: 5, ysyms: b.y || [b.sym + ".SA"], terms: b.terms || termsFor(b.name || "", b.sym)
    });
  }
}

const clients = new Set();
const diag = {
  started: Date.now(),
  crypto: { ok: false, err: null },
  stocks: { okN: 0, fails: 0, err: null, sym: null },
  macro: { selic: null, usdbrl: null, ipca12m: null }
};
let aiLastError = null;
let macroCache = null;
let shuttingDown = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- fetch com timeout ---------- */
async function fetchT(url, opts = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- Worker de análise ---------- */
const worker = new Worker(path.join(__dirname, "worker.js"));
const pending = new Map();
let wid = 0;
worker.on("message", ({ id, result, error }) => {
  const p = pending.get(id); pending.delete(id);
  if (p) error ? p.rej(new Error(error)) : p.res(result);
});
worker.on("error", e => log("worker", e.message));

function runAnalysis(closes, H, price) {
  return new Promise((res, rej) => {
    const id = ++wid;
    pending.set(id, { res, rej });
    worker.postMessage({ id, closes, H, price });
    setTimeout(() => { if (pending.delete(id)) rej(new Error("análise demorou demais")); }, 300000);
  });
}

/* ---------- Utilitários de mercado ---------- */
function completedSeries(a, now = Date.now()) {
  const candles = a.candles || [];
  if (candles.length < 50) return null;
  const mkt = a.mkt === "BR" ? "BR" : "US";
  const today = mk.exchangeDate(mkt, new Date(now));
  const last = candles[candles.length - 1];
  const lastDay = new Date(last.t).toISOString().slice(0, 10);
  let closes = candles.map(c => c.c);
  if (lastDay === today) {
    const closeAt = mk.closeInstant(today, mkt);
    if (now < closeAt || (a.fetchedAt && a.fetchedAt < closeAt)) {
      closes = closes.slice(0, -1);
    }
  }
  if (closes.length < 50) return null;
  return { closes, lastDay };
}

function stockDue(a, now = Date.now()) {
  if (a.lastTry && now - a.lastTry < 60000) return false; // falhou há pouco: espera, mesmo sem nenhum dado ainda
  if (!a.fetchedAt) return true;
  const mkt = a.mkt === "BR" ? "BR" : "US";
  const open = mk.marketOpenNow(mkt, new Date(now));
  const since = now - a.fetchedAt;
  if (a.lastTry && now - a.lastTry < 60000) return false;
  if (open) return since > 30 * 60000;
  const today = mk.exchangeDate(mkt, new Date(now));
  const closeAt = mk.closeInstant(today, mkt);
  if (now > closeAt && a.fetchedAt < closeAt) return true;
  return since > 6 * 3600000;
}

function validateFeed(a, data, now = Date.now()) {
  if (!data || !Array.isArray(data.candles) || data.candles.length < 2) throw new Error("sem candles");
  const last = data.candles[data.candles.length - 1];
  if (now - last.t > 12 * 86400000) throw new Error("dados desatualizados");
  if (a.price && data.price && Math.abs(data.price / a.price - 1) > 0.35) throw new Error("preço destoa do último");
  return true;
}

function debounce(a, rec, hz, need) {
  if (!a._deb) a._deb = {};
  if (!a._deb[hz]) a._deb[hz] = { last: null, n: 0, stable: null };
  const d = a._deb[hz];
  if (rec === d.last) {
    d.n++;
    if (d.n >= need) { d.stable = rec; return rec; }
    return d.stable; // ainda não deu N leituras iguais: mantém o rótulo estável (null se nunca houve)
  }
  d.last = rec; d.n = 1;
  return d.stable;
}

function finalRec(a) {
  if (!a.analyses) return null;
  const h = "1s";
  return (a.finals && a.finals[h]) || (a.analyses[h] && a.analyses[h].rec) || null;
}

/* ---------- Providers de preço ---------- */
async function fetchFromProviders(a) {
  const errs = [];
  for (const y of (a.ysyms || [])) {
    try {
      const r = await yahoo.fetchYahoo(fetchT, y, "max", "1d"); // histórico completo; o analysis.js limita a MAX_HIST
      if (r.candles.length >= 200 || (a.ysyms.length === 1 && r.candles.length >= 50)) {
        return { ...r, src: "Yahoo Finance", yUsed: y };
      }
      errs.push(y + ": histórico curto (" + r.candles.length + ")");
    } catch (e) {
      errs.push(y + ": " + e.message);
    }
  }
  if (TWELVE && a.kind === "stock") {
    try {
      const ticker = a.mkt === "BR" ? a.sym + ":BVMF" : a.sym;
      const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(ticker) + "&interval=1day&outputsize=5000&apikey=" + TWELVE;
      const r = await fetchT(url, {}, 25000);
      if (!r.ok) throw new Error("Twelve HTTP " + r.status);
      const j = await r.json();
      const parsed = yahoo.parseTwelve(j);
      return { ...parsed, src: "Twelve Data" };
    } catch (e) { errs.push("Twelve: " + e.message); }
  }
  if (BRAPI && a.mkt === "BR") {
    try {
      const r = await yahoo.fetchBrapi(fetchT, a.sym, BRAPI);
      return { ...r, src: "brapi" };
    } catch (e) { errs.push("brapi: " + e.message); }
  }
  throw new Error(errs.join(" | ") || "sem provedor");
}

async function loadStock(a) {
  a.lastTry = Date.now();
  const data = await fetchFromProviders(a);
  validateFeed(a, data);
  a.candles = data.candles;
  a.price = data.price;
  a.open24 = data.prevClose || (data.candles.length >= 2 ? data.candles[data.candles.length - 2].c : data.price);
  a.src = data.src;
  a.fetchedAt = Date.now();
  a.currency = data.currency || a.ccy;
  a.baseT = data.candles.at(-1).t;
  return a;
}

/* ---------- Cripto (Binance → Yahoo fallback) ---------- */
async function loadCryptoFromBinance(a) {
  const pair = a.pair || a.sym + "USDT";
  return binance.fetchBinanceDaily(fetchT, pair, { pages: 5 }); // ~5000 dias, com fallback de host
}

async function loadCryptoFromYahoo(a) {
  const errs = [];
  for (const y of (a.ysyms || [a.sym + "-USD"])) {
    try {
      const r = await yahoo.fetchYahoo(fetchT, y, "max", "1d");
      if (r.candles.length < 50) throw new Error("histórico curto");
      return {
        candles: r.candles,
        price: r.price,
        open24: r.prevClose || r.candles[r.candles.length - 2].c,
        src: "Yahoo Finance"
      };
    } catch (e) { errs.push(y + ": " + e.message); }
  }
  throw new Error(errs.join(" | ") || "Yahoo cripto falhou");
}

async function loadCrypto(a) {
  a.lastTry = Date.now();
  let data;
  try {
    data = await loadCryptoFromBinance(a);
  } catch (e) {
    // Binance bloqueada (451) ou fora: tenta o Yahoo. Se os dois falharem, o motivo fica visível no painel.
    log("cripto", a.sym, e.message, "→ tentando Yahoo");
    try {
      data = await loadCryptoFromYahoo(a);
    } catch (e2) {
      a.erro = a.sym + " sem preço: " + e.message + " | Yahoo: " + e2.message;
      throw new Error(a.erro);
    }
  }
  a.erro = null;
  a.candles = data.candles;
  a.price = data.price;
  a.open24 = data.open24;
  a.src = data.src;
  a.fetchedAt = Date.now();
  a.baseT = data.candles.at(-1).t;
  diag.crypto.ok = true;
  diag.crypto.err = data.src === "Binance" ? null : ("fallback " + data.src);
  return a;
}

/* ---------- Notícias ---------- */
async function fetchNews(a) {
  const terms = a.terms || [a.name, a.sym].filter(Boolean);
  const lang = a.mkt === "BR" ? "pt" : "en";
  let list = [];
  if (a.kind === "crypto") {
    try {
      const r = await fetchT("https://min-api.cryptocompare.com/data/v2/news/?categories=" + a.sym + "&lang=EN", {}, 12000);
      if (r.ok) list = news.parseCryptoCompare(await r.json());
    } catch {}
  }
  try {
    const g = await news.fetchGoogleNews(fetchT, terms, lang);
    list = list.concat(g);
  } catch (e) {
    if (!list.length) throw e;
  }
  const filtered = news.dedupe(list).filter(n => news.reliable(n) && news.relevant(n.title, terms)).slice(0, 12);
  a.news = filtered.map((n, i) => ({ ...n, id: "N" + (i + 1) }));
  a.newsAt = Date.now();
  return a.news;
}

/* ---------- Análise ---------- */
async function refreshAnalysis(a) {
  const series = completedSeries(a);
  if (!series) return null;
  const { closes } = series;
  const horizons = a.kind === "crypto" ? HZN_C : HZN;
  const analyses = {};
  const finals = {};
  for (const [key, H] of Object.entries(horizons)) {
    try {
      const res = await runAnalysis(closes, H, a.price);
      if (!res) continue;
      if (res.rec === "buy" && !aprovado(a.sym, key)) { res.rec = "obs"; res.semAprovacao = true; }
      analyses[key] = res;
      const need = a.kind === "crypto" ? 3 : 2;
      const stable = debounce(a, res.rec, key, need);
      finals[key] = stable || res.rec;
    } catch (e) {
      log("análise", a.sym, key, e.message);
    }
  }
  if (!Object.keys(analyses).length) return null;
  a.analyses = analyses;
  a.finals = finals;
  a.analysisAt = Date.now();
  a.analysis = true;
  // baseT = último fechamento da série usada (evita Invalid Date no "Sair em")
  if (a.candles && a.candles.length) {
    const nCloses = series.closes.length;
    const idx = Math.min(nCloses, a.candles.length) - 1;
    a.baseT = a.candles[Math.max(0, idx)].t;
  }
  if (a.mkt === "BR" && macroCache) a.macro = macroCache;
  return a;
}

/* ---------- IA ---------- */
function numbersNotFound(text, dados) {
  // Milhar em pt-BR ("76.627", "1.234.567") vira número inteiro antes da conferência.
  const norm = String(text).replace(/\d{1,3}(?:\.\d{3})+(?!\d)/g, m => m.replace(/\./g, ""));
  const nums = norm.match(/\d+[.,]?\d*%?/g) || [];
  const out = [];
  for (const raw of nums) {
    const pct = raw.endsWith("%"), n = pct ? raw.slice(0, -1) : raw;
    const clean = n.replace(",", ".");
    // inteiros pequenos (dias do mês, "em 5 dias") passam; porcentagem nunca é isenta
    if (!pct && /^\d{1,2}$/.test(clean) && +clean <= 31) continue;
    if (dados.includes(n) || dados.includes(clean) || dados.includes(n.replace(".", ","))) continue;
    const v = parseFloat(clean);
    if (Number.isFinite(v) && dados.match(new RegExp(String(Math.round(v)) + "(\\.\\d+)?"))) continue;
    out.push(n);
  }
  return out;
}

// Remove frases com números ausentes dos dados (preços/níveis inventados) em vez de mostrá-las.
function stripInvented(text, dados) {
  return String(text || "").split(/(?<=[.!?;])\s+/).filter(p => numbersNotFound(p, dados).length === 0).join(" ").trim();
}

function parseAI(raw) {
  const s = String(raw).replace(/^```json\s*|\s*```$/g, "").trim();
  let d;
  try { d = JSON.parse(s); } catch { throw new Error("sem JSON"); }
  const recOk = r => ["buy", "wait", "avoid", "obs"].includes(r) ? r : null;
  return {
    sentimento: typeof d.sentimento === "number" ? Math.max(-1, Math.min(1, d.sentimento)) : 0,
    veredito: ["confirma", "neutro", "contradiz"].includes(d.veredito) ? d.veredito : "neutro",
    recomendacao: recOk(d.recomendacao),
    recomendacao_1m: recOk(d.recomendacao_1m),
    recomendacao_5m: recOk(d.recomendacao_5m),
    resumo: String(d.resumo || "").slice(0, 600),
    riscos: Array.isArray(d.riscos) ? d.riscos.map(String).slice(0, 3) : [],
    cenarios: {
      alta: String((d.cenarios && d.cenarios.alta) || ""),
      base: String((d.cenarios && d.cenarios.base) || ""),
      baixa: String((d.cenarios && d.cenarios.baixa) || "")
    },
    x: String(d.x || ""),
    fontes: Array.isArray(d.fontes)
      ? d.fontes.map(f => {
          if (typeof f === "string") return { id: f.toUpperCase().replace(/\s/g, ""), src: "", url: "" };
          return { id: String(f.id || f).toUpperCase(), src: String(f.src || ""), url: String(f.url || "") };
        }).filter(f => /^N\d+$/.test(f.id)).slice(0, 6)
      : [],
    notas: []
  };
}

function validateAI(ai, ctx, analyses) {
  const newsIds = new Set((ctx.news || []).map(n => n.id));
  const fantasmas = (ai.fontes || []).filter(f => !newsIds.has(f.id)).map(f => f.id);
  ai.fontes = (ai.fontes || []).filter(f => newsIds.has(f.id));
  if (fantasmas.length) ai.notas.push("fontes citadas que não existem foram ignoradas: " + fantasmas.join(", "));
  for (const f of ai.fontes) {
    const n = (ctx.news || []).find(x => x.id === f.id);
    if (n) { f.src = n.src; f.url = n.url; }
  }
  const hasSource = ai.fontes.length > 0;
  const order = { buy: 0, wait: 1, obs: 2, avoid: 3 };
  const apply = (statRec, aiRec) => {
    if (!aiRec) return statRec;
    if (!hasSource && order[aiRec] > order[statRec || "obs"]) return null;
    if (order[aiRec] < order[statRec || "obs"]) return statRec;
    return aiRec;
  };
  if (analyses) {
    ai.recomendacao = apply(analyses["1s"] && analyses["1s"].rec, ai.recomendacao);
    ai.recomendacao_1m = apply(analyses["1m"] && analyses["1m"].rec, ai.recomendacao_1m);
    ai.recomendacao_5m = apply(analyses["5m"] && analyses["5m"].rec, ai.recomendacao_5m);
  }
  const inventados = numbersNotFound([ai.resumo, JSON.stringify(ai.cenarios), ai.riscos.join(" "), ai.x].join(" "), ctx.text || "");
  ai.verificado = hasSource && inventados.length === 0 && fantasmas.length === 0;
  if (inventados.length) {
    ai.notas.push("frases com preços ou números que não estão nos dados foram removidas");
    const t = ctx.text || "";
    ai.resumo = stripInvented(ai.resumo, t);
    for (const k of ["alta", "base", "baixa"]) ai.cenarios[k] = stripInvented(ai.cenarios[k], t);
    ai.riscos = ai.riscos.map(r => stripInvented(r, t)).filter(Boolean);
    ai.x = stripInvented(ai.x, t);
    if (!ai.resumo) ai.resumo = "O resumo da IA foi descartado porque citava números que não estão nos dados. Veja as manchetes abaixo.";
  }
  if (!hasSource && (ai.recomendacao || ai.recomendacao_1m)) ai.notas.push("rebaixamento sem fonte verificável foi ignorado");
  return ai;
}

function aiPrompt(a) {
  const now = Date.now();
  const fresh = (a.news || []).filter(n => now - n.when <= 10 * 86400000);
  const newsBlock = fresh.map(n => {
    const d = new Date(n.when).toISOString().slice(0, 10);
    return n.id + " [" + d + " | " + n.src + "] " + n.title;
  }).join("\n") || "Nenhuma manchete recente.";
  const an = a.analyses || {};
  const lines = [];
  for (const [k, H] of Object.entries(a.kind === "crypto" ? HZN_C : HZN)) {
    const r = an[k];
    if (!r) continue;
    lines.push(HZ_NAME[k] + " (" + H + (a.kind === "crypto" ? " dias" : " pregões") + "): rec=" + r.rec + " conf=" + r.conf + " med=" + (r.st.med * 100).toFixed(1) + "% n=" + r.st.n + " testes_indep=" + (r.bt ? r.bt.nEff : 0));
  }
  const macro = a.mkt === "BR" && a.macro
    ? "Selic " + (a.macro.selic ?? "n/d") + "%, USD/BRL " + (a.macro.usdbrl ?? "n/d") + ", IPCA12m " + (a.macro.ipca12m != null ? (a.macro.ipca12m * 100).toFixed(1) + "%" : "n/d")
    : "";
  const priceStr = a.ccy === "BRL" ? "R$ " + (a.price || 0).toFixed(2) : "US$ " + (a.price || 0).toFixed(2);
  const text = "Ativo: " + a.sym + " (" + a.name + ") | Preço: " + priceStr + "\nModelo estatístico por horizonte:\n" +
    (lines.join("\n") || "sem análise") + "\n" +
    (macro ? "Macro BR: " + macro + "\n" : "") +
    "\nManchetes numeradas (cite só esses IDs):\n" + newsBlock +
    "\n\nResponda APENAS um JSON válido:\n" +
    '{"sentimento":-1 a 1,"veredito":"confirma"|"neutro"|"contradiz","recomendacao":"buy"|"wait"|"obs"|"avoid"|null,"recomendacao_1m":idem,"recomendacao_5m":idem,"resumo":"...","riscos":["..."],"cenarios":{"alta":"...","base":"...","baixa":"..."},"x":"...","fontes":["N1",...]}\n' +
    "Horizontes: use SEMPRE os nomes 1 semana, 1 mês e 5 meses (nunca 1s, 1m, 5m, segundos ou minutos); recomendacao, recomendacao_1m e recomendacao_5m correspondem a eles. Se testes_indep for menor que 10, não cite taxa de acerto nem apresente a mediana como expectativa de retorno. Não cite preços, níveis de suporte/resistência, alvos nem porcentagens que não estejam neste texto. Regras: só rebaixe o sinal estatístico se citar ao menos uma manchete real (N1, N2...). Nunca invente números. Nunca melhore o sinal.";
  return { text, ctx: { news: fresh, text } };
}

async function callGemini(promptText) {
  const models = [ENV.AI_MODEL || "gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"].filter(Boolean);
  let lastErr;
  for (const model of models) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
    const r = await fetchT(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    }, 45000);
    if (!r.ok) {
      const err = await r.text();
      lastErr = new Error("Gemini " + model + " HTTP " + r.status + ": " + err.slice(0, 200));
      if (r.status === 404) continue;
      throw lastErr;
    }
    const j = await r.json();
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const text = parts.filter(p => !p.thought && p.text).map(p => p.text).join("") || parts.map(p => p.text || "").join("");
    return { out: text, model };
  }
  throw lastErr || new Error("nenhum modelo Gemini respondeu");
}

async function callGroq(promptText) {
  // llama-3.3-70b-versatile virou Enterprise; free/dev usa estes (ordem de preferência)
  // 429 (rate limit) agora também tenta o próximo modelo da lista
  const models = [
    ENV.GROQ_MODEL,
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "llama-3.1-8b-instant"
  ].filter(Boolean);
  let lastErr;
  for (const model of models) {
    try {
      const r = await fetchT("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + GROQ_KEY },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: promptText }],
          temperature: 0.2,
          response_format: { type: "json_object" }
        })
      }, 45000);
      if (!r.ok) {
        const errText = await r.text();
        lastErr = new Error("Groq " + model + " HTTP " + r.status + ": " + errText.slice(0, 180));
        // 404/403 = modelo indisponível; 429 = rate limit → tenta o próximo
        if (r.status === 404 || r.status === 403 || r.status === 429) continue;
        throw lastErr;
      }
      const j = await r.json();
      return { out: j.choices[0].message.content, model };
    } catch (e) {
      lastErr = e;
      if (/HTTP (404|403|429)/.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr || new Error("nenhum modelo Groq respondeu");
}

const aiQueue = [];
let aiActive = 0;
function queueAI(a, urgent) {
  if ((!GEMINI_KEY && !GROQ_KEY) || !a.analysis || a.aiRunning || aiQueue.includes(a)) return;
  urgent ? aiQueue.unshift(a) : aiQueue.push(a);
  while (aiActive < AI_CONC && aiQueue.length > aiActive) {
    aiActive++;
    drainAI().finally(() => { aiActive--; });
  }
}
async function drainAI() {
  while (aiQueue.length) {
    const a = aiQueue.shift();
    a.aiRunning = true;
    try {
      const { text, ctx } = aiPrompt(a);
      const { out, model } = GEMINI_KEY ? await callGemini(text) : await callGroq(text);
      ctx.model = model;
      a.ai = validateAI(parseAI(out), ctx, a.analyses);
      a.aiAt = Date.now();
      aiLastError = null;
      if (a.ai.recomendacao && a.finals) a.finals["1s"] = a.ai.recomendacao;
      if (a.ai.recomendacao_1m && a.finals) a.finals["1m"] = a.ai.recomendacao_1m;
      if (a.ai.recomendacao_5m && a.finals) a.finals["5m"] = a.ai.recomendacao_5m;
      broadcast({ type: "ai", asset: view(a) });
    } catch (e) {
      a.aiAt = Date.now() - AI_EVERY + 120000;
      aiLastError = e.message;
      log("IA", a.sym, e.message);
    }
    a.aiRunning = false;
    await sleep(1500);
  }
}

/* ---------- View / broadcast ---------- */
function view(a) {
  // Front espera candles como [t, o, h, l, c], não objetos {t,o,h,l,c}
  const candles = (a.candles || []).slice(-120).map(c => [c.t, c.o, c.h, c.l, c.c]);
  let baseT = a.baseT;
  if (baseT == null && a.candles && a.candles.length) baseT = a.candles[a.candles.length - 1].t;
  return {
    sym: a.sym, name: a.name, kind: a.kind, mkt: a.mkt, ccy: a.ccy,
    price: a.price, open24: a.open24,
    candles, baseT,
    analyses: a.analyses, finals: a.finals, analysisAt: a.analysisAt,
    src: a.src, dataAt: a.fetchedAt, erro: a.erro || null,
    news: (a.news || []).slice(0, 8),
    tweets: (a.tweets || []).slice(0, 5),
    ai: a.ai, aiAt: a.aiAt,
    macro: a.macro || null
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}
function log(tag, ...args) { console.log("[" + new Date().toISOString().slice(11, 19) + "] [" + tag + "]", ...args); logger.write(tag, args); }

/* ---------- Mock para testes ---------- */
function mockData() {
  const day = 86400000;
  const base = Date.parse("2026-10-01");
  for (const a of assets.values()) {
    const n = 500;
    a.candles = Array.from({ length: n }, (_, i) => {
      const c = 10 + i * 0.01 + Math.sin(i / 20) * 0.5;
      return { t: base + i * day, o: c * 0.99, h: c * 1.02, l: c * 0.98, c };
    });
    a.price = a.candles.at(-1).c * 1.005;
    a.open24 = a.candles.at(-2).c;
    a.src = "MOCK";
    a.fetchedAt = Date.now();
    a.news = [{ id: "N1", title: "Manchete de teste " + a.sym, url: "https://example.com/1", src: "MOCK", when: Date.now() - 3600000 }];
    a.newsAt = Date.now();
  }
  macroCache = { selic: 13.75, usdbrl: 5.5, ipca12m: 0.04, at: Date.now() };
  diag.macro = macroCache;
}

/* ---------- Loops ---------- */
async function priceLoop() {
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (shuttingDown) return;
      try {
        if (a.kind === "crypto") {
          const retryOk = !a.lastTry || Date.now() - a.lastTry > 60000;
          if ((!a.fetchedAt || Date.now() - a.fetchedAt > 60000) && retryOk) {
            await loadCrypto(a);
            diag.crypto.ok = true;
            diag.crypto.err = null;
          }
        } else if (stockDue(a)) {
          await loadStock(a);
          diag.stocks.okN++;
          diag.stocks.err = null;
        }
        if (a.price) broadcast({ type: "tick", sym: a.sym, price: a.price, open24: a.open24 });
      } catch (e) {
        if (a.kind === "crypto") {
          diag.crypto.ok = false;
          diag.crypto.err = e.message;
        } else {
          diag.stocks.fails++;
          diag.stocks.err = e.message;
          diag.stocks.sym = a.sym;
        }
        log("preço", a.sym, e.message);
      }
      await sleep(a.kind === "crypto" ? 200 : 400);
    }
    await sleep(5000);
  }
}

async function analysisLoop() {
  await sleep(3000);
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (!a.candles || a.candles.length < 80) continue;
      try {
        const before = a.finals && a.finals["1s"];
        await refreshAnalysis(a);
        if (a.analyses) {
          try { history.archiveCandles(a.sym, a.candles); history.recordSignals(a); }
          catch (e) { log("histórico", a.sym, e.message); }
          broadcast({ type: "analysis", asset: view(a) });
          const after = a.finals && a.finals["1s"];
          if (before && after && before !== after) {
            broadcast({ type: "alert", text: a.sym + ": sinal " + before + " → " + after });
          }
        }
      } catch (e) { log("análise-loop", a.sym, e.message); }
      await sleep(300);
    }
    await sleep(20000);
  }
}

async function newsLoop() {
  await sleep(8000);
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (a.newsAt && Date.now() - a.newsAt < 45 * 60000) continue;
      try {
        await fetchNews(a);
      } catch (e) { log("news", a.sym, e.message); }
      await sleep(1500);
    }
    await sleep(60000);
  }
}

async function macroLoop() {
  for (;;) {
    if (shuttingDown) return;
    try {
      macroCache = await bcb.fetchMacro(fetchT);
      diag.macro = macroCache;
      for (const a of assets.values()) if (a.mkt === "BR") a.macro = macroCache;
    } catch (e) { log("macro", e.message); }
    await sleep(30 * 60000);
  }
}

async function aiLoop() {
  if (!GEMINI_KEY && !GROQ_KEY) { log("IA desligada (defina GEMINI_API_KEY ou GROQ_API_KEY)"); return; }
  for (;;) {
    if (shuttingDown) return;
    for (const a of assets.values()) {
      if (a.analysis && (a.newsAt || Date.now() - diag.started > 6 * 60000) && Date.now() - (a.aiAt || 0) > AI_EVERY) {
        queueAI(a, false);
      }
    }
    await sleep(15000);
  }
}

/* ---------- HTTP + WS ---------- */


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (url.pathname === "/health") {
    const brN = [...assets.values()].filter(a => a.mkt === "BR" && a.analysis).length;
    res.setHeader("content-type", "application/json");
    const learn = memory.snapshot();
    res.end(JSON.stringify({
      ok: true, live: true,
      assets: assets.size,
      analisados: [...assets.values()].filter(a => a.analysis).length,
      acoesBRAnalisadas: brN,
      historico: history.summary(),
      ai: { ligada: !!(GEMINI_KEY || GROQ_KEY), ultimoErro: aiLastError },
      aprendizado: {
        count: learn.learningCount,
        acertos: learn.correct,
        erros: learn.wrong,
        winRate: learn.winRate,
        K: learn.K,
        minN: learn.minN,
        pending: 0,
        lastReason: learn.lastReason,
        lastUpdate: learn.lastUpdate,
        byHorizon: learn.byHorizon || null
      },
      diagnostico: diag
    }));
    return;
  }
  if (url.pathname === "/aprendizado") {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const learn = memory.snapshot(true); // full = todos os testes recentes
    res.end(JSON.stringify({
      ok: true,
      version: learn.version,
      count: learn.learningCount,
      acertos: learn.correct,
      erros: learn.wrong,
      winRate: learn.winRate,
      K: learn.K,
      minN: learn.minN,
      lastReason: learn.lastReason,
      lastUpdate: learn.lastUpdate,
      byHorizon: learn.byHorizon || null,
      weights: learn.weights,
      testes: learn.recent || []
    }));
    return;
  }
  if (url.pathname === "/logs") {
    res.setHeader("cache-control", "no-store");
    const dia = url.searchParams.get("dia");
    if (url.searchParams.get("lista") === "1") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...logger.info(), arquivos: logger.listar() }));
      return;
    }
    const corpo = dia ? logger.ler(dia) : logger.tail(url.searchParams.get("n"));
    if (corpo === null) { res.statusCode = 404; res.setHeader("content-type", "text/plain; charset=utf-8"); res.end("sem log para esse dia (use dia=AAAA-MM-DD)"); return; }
    res.setHeader("content-type", "text/plain; charset=utf-8");
    if (url.searchParams.get("baixar") === "1") res.setHeader("content-disposition", 'attachment; filename="bolsai-' + (dia || new Date().toISOString().slice(0, 10)) + '.log"');
    res.end(corpo);
    return;
  }
  if (url.pathname === "/historico") {
    res.setHeader("cache-control", "no-store");
    const tipo = url.searchParams.get("tipo") || "sinais";
    const corpo = history.exportar(tipo);
    if (corpo === null) {
      res.statusCode = 400;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("tipo inválido: use sinais, resultados ou mercado");
      return;
    }
    res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="bolsai-' + tipo + "-" + new Date().toISOString().slice(0, 10) + '.jsonl"');
    res.end(corpo);
    return;
  }
  let fp = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!fp.startsWith(path.join(__dirname, "public") + path.sep)) { res.statusCode = 403; res.end("Forbidden"); return; }
  try {
    const st = fs.statSync(fp);
    if (st.isDirectory()) fp = path.join(fp, "index.html");
    const ext = path.extname(fp);
    const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" }[ext] || "text/plain";
    res.setHeader("content-type", mime);
    res.setHeader("Referrer-Policy", "no-referrer");
    fs.createReadStream(fp).pipe(res);
  } catch {
    res.statusCode = 404; res.end("Not Found");
  }
});

const wss = new WebSocket.Server({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  clients.add(ws);
  ws.send(JSON.stringify({
    type: "snapshot",
    live: true,
    ai: !!(GEMINI_KEY || GROQ_KEY),
    x: false,
    assets: [...assets.values()].map(view)
  }));
  ws.on("message", (msg) => {
    try {
      const d = JSON.parse(msg);
      if (d.type === "ping") ws.send(JSON.stringify({ type: "pong", t: d.t }));
    } catch {}
  });
  ws.on("close", () => clients.delete(ws));
});

function shutdown() {
  shuttingDown = true;
  try { memory.save(true); } catch {}
  try { worker.terminate(); } catch {}
  try { server.close(); } catch {}
  for (const c of clients) try { c.close(); } catch {}
}

async function learningLoop() {
  const mem = memory.load();
  log("memória", mem.ok ? ("carregada · aprendizados=" + mem.learningCount + " winRate=" + (mem.winRate != null ? (mem.winRate * 100).toFixed(1) + "%" : "n/d")) : ("nova (" + (mem.err || "") + ")"));
  for (;;) {
    if (shuttingDown) return;
    try {
      // Estudo histórico nos horizontes 1s / 1m / 5m (não usa mais check de 35s).
      // Usa só candles já fechados, conta acerto de buy/avoid no backtest walk-forward,
      // ajusta pesos e libera a memória temporária de cada ativo.
      const results = memory.studyCycle(sym => assets.get(sym), assets);
      for (const r of results) {
        if (r.ok === false) log("aprender", r.sym, r.reason);
        else if (r.ok === true) log("aprender", r.sym, "OK", r.reason);
        else if (r.reason) log("aprender", r.sym, r.reason);
      }
      const conferidos = history.grade();
      if (conferidos) log("histórico", "resultados novos conferidos:", conferidos);
      if (results.length) {
        const snap = memory.snapshot();
        broadcast({ type: "status", live: true, learning: {
          count: snap.learningCount,
          winRate: snap.winRate,
          lastReason: snap.lastReason,
          pending: 0,
          byHorizon: snap.byHorizon
        }});
      }
    } catch (e) {
      log("aprender", e.message);
    }
    // ciclo mais espaçado: o estudo é pesado (backtest histórico), não precisa de 30s
    await sleep(120000);
  }
}

async function main() {
  log("Iniciando Sinal Semanal…");
  log("Ativos: " + assets.size + " (BR: " + [...assets.values()].filter(a => a.mkt === "BR").length + ")");
  if (MOCK) {
    log("MODO MOCK ativo");
    mockData();
  }
  const h = history.init();
  log("histórico", h.ok ? ("pasta " + h.dir + " · sinais=" + h.sinais + " resultados=" + h.resultados) : ("falhou: " + h.err));
  instalarEncerramento();
  const lg = logger.init();
  log("logs", lg.ok ? ("gravando em " + lg.dir) : ("sem arquivo de log: " + lg.err));
  log("partida", "servidor iniciando · node " + process.version + " · pid " + process.pid);
  server.listen(PORT, () => log("Servidor na porta " + PORT));
  if (!MOCK) {
    priceLoop();
    analysisLoop();
    newsLoop();
    macroLoop();
  } else {
    for (const a of assets.values()) {
      try { await refreshAnalysis(a); broadcast({ type: "analysis", asset: view(a) }); } catch {}
    }
  }
  aiLoop();
  learningLoop();
}

/* ---------- Encerramento: não perder as últimas linhas do log ---------- */
function instalarEncerramento() {
  const encerrar = (motivo, code) => { try { log("desligando", motivo); logger.flushSync(); } catch {} process.exit(code); };
  process.on("SIGTERM", () => encerrar("SIGTERM (o Render parou ou reiniciou o serviço)", 0));
  process.on("SIGINT", () => encerrar("SIGINT", 0));
  process.on("uncaughtException", e => { try { log("ERRO FATAL", e); logger.flushSync(); } catch {} process.exit(1); });
  process.on("unhandledRejection", e => log("rejeição não tratada", e));
}

if (require.main === module) main();

module.exports = {
  server,
  assets, view, parseAI, validateAI, numbersNotFound, finalRec, debounce,
  completedSeries, stockDue, validateFeed, fetchFromProviders, loadStock,
  fetchNews, refreshAnalysis, aiPrompt, queueAI, mockData, shutdown,
  runAnalysis
};
