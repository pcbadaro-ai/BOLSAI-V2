"use strict";
/*
 * Log em arquivo que sobrevive a desligar/reiniciar o site.
 * Grava em LOG_DIR (no Render: /var/data/logs, o disco persistente). Sem LOG_DIR, usa a pasta
 * "logs" ao lado do HISTORY_DIR e, em último caso, ./data/logs.
 *
 *  - um arquivo por dia (UTC): bolsai-AAAA-MM-DD.log, linhas com data e hora completas;
 *  - escrita em lote a cada 2 s (não trava o servidor) e descarga síncrona ao desligar;
 *  - limite de 10 MB por dia e retenção de 30 dias, para não encher o disco de 2 GB;
 *  - nunca lança erro: se o disco falhar, o servidor segue só com o console.
 */
const fs = require("fs");
const path = require("path");

const MAX_FILE = 10 * 1024 * 1024;
const KEEP_DAYS = 30;
const FLUSH_MS = 2000;

let dir = null, buf = [], timer = null, dayCache = { day: null, size: 0, cheio: false }, lastErr = null;

function resolveDir() {
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  if (process.env.HISTORY_DIR) return path.join(path.dirname(process.env.HISTORY_DIR), "logs");
  return path.join(__dirname, "..", "data", "logs");
}
const dayOf = d => d.toISOString().slice(0, 10);
const fileOf = day => path.join(dir, "bolsai-" + day + ".log");

function init() {
  dir = resolveDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    limpar();
    if (!timer) { timer = setInterval(flush, FLUSH_MS); timer.unref(); }
    return { ok: true, dir };
  } catch (e) {
    lastErr = e.message; dir = null;
    return { ok: false, err: e.message };
  }
}

function limpar() {
  if (!dir) return;
  try {
    const corte = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(dir)) {
      if (!/^bolsai-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < corte) fs.unlinkSync(fp);
    }
  } catch (e) { lastErr = e.message; }
}

function fmt(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function write(tag, args) {
  if (!dir) return;
  const now = new Date();
  buf.push({ day: dayOf(now), line: now.toISOString() + " [" + tag + "] " + args.map(fmt).join(" ").replace(/\r?\n/g, "\n    ") + "\n" });
}

function pending(sync) {
  if (!dir || !buf.length) return;
  const lote = buf; buf = [];
  const porDia = new Map();
  for (const x of lote) porDia.set(x.day, (porDia.get(x.day) || "") + x.line);
  for (const [day, bruto] of porDia) {
    let texto = bruto;
    if (dayCache.day !== day) {
      let size = 0; try { size = fs.statSync(fileOf(day)).size; } catch {}
      dayCache = { day, size, cheio: false };
      if (!sync) limpar();
    }
    if (dayCache.cheio) continue;
    if (dayCache.size + Buffer.byteLength(texto) > MAX_FILE) {
      texto = "[logger] limite de " + (MAX_FILE / 1048576) + " MB atingido neste dia; o restante não será gravado.\n";
      dayCache.cheio = true;
    }
    dayCache.size += Buffer.byteLength(texto);
    try {
      if (sync) fs.appendFileSync(fileOf(day), texto);
      else fs.appendFile(fileOf(day), texto, e => { if (e) lastErr = e.message; });
    } catch (e) { lastErr = e.message; }
  }
}
const flush = () => pending(false);
const flushSync = () => pending(true);

// últimas n linhas (do arquivo de hoje; se faltar, completa com o de ontem)
function tail(n = 200) {
  if (!dir) return "";
  flushSync();
  n = Math.max(1, Math.min(5000, Number(n) || 200));
  const dias = [dayOf(new Date()), dayOf(new Date(Date.now() - 86400000))];
  let linhas = [];
  for (const d of dias) {
    try { linhas = fs.readFileSync(fileOf(d), "utf8").split("\n").filter(Boolean).concat(linhas); } catch {}
    if (linhas.length >= n) break;
  }
  return linhas.slice(-n).join("\n") + "\n";
}

function listar() {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter(f => /^bolsai-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse()
      .map(f => ({ arquivo: f, bytes: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}

function ler(dia) {
  if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  flushSync();
  try { return fs.readFileSync(fileOf(dia), "utf8"); } catch { return null; }
}

const info = () => ({ dir, ativo: !!dir, erro: lastErr });

module.exports = { init, write, flush, flushSync, tail, listar, ler, info, _reset: () => { dir = null; buf = []; dayCache = { day: null, size: 0, cheio: false }; if (timer) { clearInterval(timer); timer = null; } } };
