"use strict";
/*
 * Notícias reais, sem chave: Google Notícias (RSS) e CryptoCompare.
 * Cada manchete guarda título, fonte, data e link de origem, e só entra se tiver data válida e recente.
 * A IA recebe as manchetes numeradas (N1, N2...) e só pode citar esses números; o servidor confere.
 */
const MAX_AGE_MS = 10 * 86400000;

const decodeEntities = s => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } })
  .replace(/&amp;/g, "&");
const stripTags = s => s.replace(/<[^>]*>/g, " ");
// Remove caracteres de controle e quebras: manchetes são dados, nunca instruções.
const clean = (s, max = 220) => stripTags(decodeEntities(stripTags(String(s)))).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; };

// Só aceita links http(s): bloqueia javascript:, data: e afins.
function safeUrl(u) {
  try { const x = new URL(String(u).trim()); return x.protocol === "http:" || x.protocol === "https:" ? x.href : null; }
  catch { return null; }
}
const norm = t => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function parseRSS(xml, now = Date.now()) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    let title = clean(tag(b, "title"));
    const srcRaw = tag(b, "source");
    let src = clean(srcRaw, 80);
    // Google Notícias termina o título com " - Fonte".
    if (src && title.toLowerCase().endsWith(" - " + src.toLowerCase())) title = title.slice(0, -(src.length + 3)).trim();
    else if (!src) { const k = title.lastIndexOf(" - "); if (k > 20) { src = title.slice(k + 3, k + 83); title = title.slice(0, k); } }
    const url = safeUrl(clean(tag(b, "link"), 1000));
    const when = Date.parse(clean(tag(b, "pubDate"), 60));
    if (!title || !url || !Number.isFinite(when)) continue;      // sem data ou link verificável: descarta
    if (when > now + 3600000 || now - when > MAX_AGE_MS) continue; // do futuro ou velha demais
    out.push({ title, url, src: src || "Google Notícias", when });
  }
  return out;
}

// Remove repetidas (mesmo título normalizado) e ordena da mais nova para a mais antiga.
function dedupe(list) {
  const seen = new Set(), out = [];
  for (const n of list.slice().sort((a, b) => b.when - a.when)) {
    const k = norm(n.title).slice(0, 90);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(n);
  }
  return out;
}

/*
 * Relevância (v10). Antes, bastava a palavra aparecer isolada: "Audi e-tron" virava "TRON" (rede TRX)
 * e manchetes de marcas esportivas passavam. Agora:
 *  1. Ruído conhecido (carros, marcas esportivas, "vale a pena") derruba a manchete, sempre.
 *  2. Nomes ambíguos (palavras comuns em inglês ou português: Tron, Apple, Meta, Visa, Vale...)
 *     só valem com contexto de mercado na mesma manchete, ou com o código em maiúsculas (TRON, VALE3...).
 *  3. Nomes e códigos sem ambiguidade continuam valendo como antes.
 */
const NOISE = new RegExp([
  "\\b(nike|adidas|puma|reebok|under armour|lululemon|new balance|asics|mizuno)\\b", // marcas esportivas
  "\\b(audi|porsche|volkswagen|bmw|mercedes|toyota|honda|hyundai|taycan|e-?tron)\\b", // carros
].join("|"), "i");
const CTX = /\b(cripto\w*|crypto\w*|token|coin|moeda digital|blockchain|stablecoin|defi|justin sun|usdt|binance|bitcoin|ethereum|altcoin|a[çc][õo]es?|shares?|stocks?|b3|ibovespa|nasdaq|nyse|wall street|lucro|receita|balan[çc]o|dividend\w*|ceo|ticker|earnings|investidores?|cota[çc][ãa]o|valor de mercado|analistas?)\b/i;
const AMBIG = new Set(["tron", "apple", "meta", "visa", "amazon", "micron", "lilly", "vale", "ma", "avalanche", "link"]);
const B3_TICKER = /\b[A-Z]{4}\d{1,2}\b/; // código da B3 (ex.: VALE3, PETR4): contexto de mercado
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Código em maiúsculas como palavra isolada (ex.: TRON, VALE3), sensível a caixa.
const upperCodeIn = (title, term) => /^[A-Z0-9]{2,6}$/.test(term) && new RegExp("(^|[^A-Za-z0-9])" + escRe(term) + "($|[^A-Za-z0-9])").test(title);

// A manchete só entra se citar o ativo (nome ou código) de forma relevante. Evita resultados soltos da busca.
function relevant(title, terms) {
  const raw = String(title);
  if (NOISE.test(raw)) return false;
  const t = " " + norm(raw) + " ";
  return terms.some(x => {
    const k = norm(x);
    if (k.length < 2 || !t.includes(" " + k + " ")) return false;
    if (!AMBIG.has(k)) return true;
    return CTX.test(raw) || B3_TICKER.test(raw) || upperCodeIn(raw, String(x).trim());
  });
}

function googleNewsURL(terms, lang = "pt") {
  const q = "(" + terms.map(t => /\s/.test(t) ? `"${t}"` : t).join(" OR ") + ") when:7d";
  const loc = lang === "pt" ? "hl=pt-BR&gl=BR&ceid=BR:pt-419" : "hl=en-US&gl=US&ceid=US:en";
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${loc}`;
}

async function fetchGoogleNews(fetchT, terms, lang) {
  const r = await fetchT(googleNewsURL(terms, lang), { headers: { "user-agent": "Mozilla/5.0 (compatible; SinalSemanal/1.1)" } }, 15000);
  if (!r.ok) throw new Error("Google Notícias HTTP " + r.status);
  return parseRSS(await r.text());
}

function parseCryptoCompare(j, now = Date.now()) {
  return (j && Array.isArray(j.Data) ? j.Data : []).map(n => ({
    title: clean(n.title), url: safeUrl(n.url), src: clean(n.source || "CryptoCompare", 80), when: Number(n.published_on) * 1000
  })).filter(n => n.title && n.url && Number.isFinite(n.when) && n.when <= now + 3600000 && now - n.when <= MAX_AGE_MS);
}

module.exports = { parseRSS, dedupe, relevant, googleNewsURL, fetchGoogleNews, parseCryptoCompare, safeUrl, clean, norm, MAX_AGE_MS };
