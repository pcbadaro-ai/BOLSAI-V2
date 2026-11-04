"use strict";
/*
 * Pesquisa fora da amostra (v10). Precisa de internet e Node 20+.
 *
 *   node pesquisa/rodar.js                       # padrão: cripto 1d, 5 anos; ações 5 anos
 *   node pesquisa/rodar.js --anos 10 --folds 6
 *   node pesquisa/rodar.js --intervalo 4h --anos 2 --cripto BTC,ETH,SOL
 *   node pesquisa/rodar.js --cripto BTC,ETH,SOL,BNB,XRP,ADA --acoes PETR4,VALE3,ITUB4,BBDC4,WEGE3
 *
 * Opções:
 *   --anos N           janela histórica (padrão 5)
 *   --folds K          blocos de teste walk-forward (padrão 5)
 *   --intervalo 1d|4h  intervalo das criptos (ações são sempre diárias)
 *   --h-cripto 7,30    horizontes em DIAS para cripto (convertidos em barras pelo intervalo)
 *   --h-acoes 5,21     horizontes em PREGÕES para ações
 *   --custo-cripto x   custo ida e volta (padrão 0.002 = 0,2%)
 *   --custo-acoes x    custo ida e volta (padrão 0.001 = 0,1%)
 *   --saida pasta      onde gravar o relatório (padrão ./relatorio)
 *   --sintetico        NÃO baixa nada: usa passeios aleatórios (só para testar o pipeline; o relatório avisa)
 *
 * Aviso: a grade de calibração e os blocos são os mesmos do servidor; o resultado é uma estimativa,
 * não garantia. Os números são gravados em JSON e Markdown para você conferir sem depender de memória.
 */
const fs = require("fs");
const path = require("path");
const WF = require("./walkforward");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const list = (v) => String(v).split(",").map(s => s.trim()).filter(Boolean);

const ANOS = Number(opt("anos", 5)), FOLDS = Number(opt("folds", 5));
const INTERVALO = opt("intervalo", "1d");
const CRIPTO = list(opt("cripto", "BTC,ETH,SOL,BNB,XRP,ADA,TRX,DOGE,LINK,AVAX"));
const ACOES = list(opt("acoes", "PETR4,VALE3,ITUB4,BBDC4,WEGE3,ABEV3,BBAS3,SUZB3,PRIO3,B3SA3"));
const H_CRIPTO_DIAS = list(opt("h-cripto", "7,30")).map(Number);
const H_ACOES = list(opt("h-acoes", "5,21")).map(Number);
const CUSTO_CRIPTO = Number(opt("custo-cripto", 0.002)), CUSTO_ACOES = Number(opt("custo-acoes", 0.001));
const SAIDA = opt("saida", "relatorio");
const SINTETICO = args.includes("--sintetico");
const MS = { "1d": 864e5, "4h": 144e5, "1h": 36e5 };
if (!MS[INTERVALO]) { console.error("intervalo inválido (use 1d, 4h ou 1h)"); process.exit(1); }

// Binance: paginação para a frente a partir de (agora - anos). Descarta a vela ainda aberta.
async function binance(sym) {
  const now = Date.now(); let st = now - ANOS * 365.25 * 864e5; const out = [];
  for (;;) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=${INTERVALO}&limit=1000&startTime=${Math.floor(st)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("Binance HTTP " + r.status);
    const k = await r.json();
    if (!Array.isArray(k) || !k.length) break;
    for (const c of k) if (c[6] < now) out.push(+c[4]); // closeTime < agora: vela fechada
    if (k.length < 1000) break;
    st = k[k.length - 1][0] + 1;
  }
  return out;
}

// Yahoo (ações B3 e EUA): preço ajustado por dividendos; descarta o pregão de hoje ainda em andamento.
async function yahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${ANOS}y&interval=1d&includeAdjustedClose=true`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; SinalSemanal/1.1)" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("Yahoo HTTP " + r.status);
  const res = (await r.json()).chart.result[0];
  const q = res.indicators.quote[0].close, adj = (res.indicators.adjclose && res.indicators.adjclose[0].adjclose) || q;
  const today = new Date().toISOString().slice(0, 10), out = [];
  res.timestamp.forEach((ts, i) => {
    if (!Number.isFinite(adj[i]) || !Number.isFinite(q[i])) return;
    if (new Date(ts * 1000).toISOString().slice(0, 10) === today) return; // pregão de hoje pode estar aberto
    out.push(adj[i]);
  });
  return out;
}

const pct = x => x == null || Number.isNaN(x) ? "  -  " : (100 * x).toFixed(1).padStart(5) + "%";
const num = x => x == null || Number.isNaN(x) ? "-" : String(x);

// Modo de teste: passeio aleatório com semente fixa (nenhuma informação real).
function simular(nome, n) {
  let seed = [...nome].reduce((a, c) => a + c.charCodeAt(0), 7) || 1;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const g = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * Math.exp(0.01 * g()));
  return c;
}

async function coletar(lista, fn, rotulo) {
  const out = [];
  for (const s of lista) {
    try { const c = SINTETICO ? simular(s, Math.round(ANOS * 365)) : await fn(s); out.push({ name: s, closes: c }); console.log(`  ${rotulo} ${s}: ${c.length} candles`); }
    catch (e) { console.log(`  ${rotulo} ${s}: falhou (${e.message})`); }
  }
  return out;
}

function linha(r) {
  const a = r.agregado;
  return `| ${r.H} | ${num(a.compras)} | ${pct(a.acerto)} | ${pct(a.base)} | ${pct(r.regraTendencia.acerto)} | ${num(a.nEff)} | ${pct(a.retornoLiquidoMedio)} | ${r.veredito} |`;
}

async function main() {
  console.log(SINTETICO ? "MODO SINTÉTICO: dados aleatórios, só para testar o pipeline." : `Coletando dados (${ANOS} anos, ${INTERVALO} para cripto)...`);
  const cripto = await coletar(CRIPTO, binance, "cripto");
  const acoes = await coletar(ACOES, s => yahoo(s + ".SA"), "B3");
  const grupos = [
    { nome: "cripto", ativos: cripto, horizontes: H_CRIPTO_DIAS.map(d => Math.max(2, Math.round(d * MS["1d"] / MS[INTERVALO]))), rotulos: H_CRIPTO_DIAS, custo: CUSTO_CRIPTO },
    { nome: "ações B3", ativos: acoes, horizontes: H_ACOES, rotulos: H_ACOES, custo: CUSTO_ACOES },
  ];
  const resultado = { geradoEm: new Date().toISOString(), sintetico: SINTETICO, anos: ANOS, folds: FOLDS, intervalo: INTERVALO, grupos: [] };
  for (const g of grupos) {
    if (!g.ativos.length) { console.log(`\nAVISO: nenhum ativo de ${g.nome} foi coletado; veja as falhas acima.`); continue; }
    const blocos = [];
    g.horizontes.forEach((H, i) => {
      const rots = g.rotulos[i];
      const res = g.ativos.map(a => WF.walkForward(a.name, a.closes, H, { folds: FOLDS, cost: g.custo }));
      const excluidos = res.filter(r => r.insuficiente).map(r => ({ ativo: r.name, motivo: r.motivo }));
      for (const x of excluidos) console.log(`  AVISO ${x.ativo} fora do relatório: ${x.motivo}`);
      const ag = WF.aggregate(res, H, g.custo);
      blocos.push({ horizonte: rots, horizonteBarras: H, excluidos, ...ag });
      console.log(`\n${g.nome} — horizonte ${rots} (${H} barras): ${ag.veredito}`);
      console.log(`  fora da amostra: ${ag.agregado.compras} compras, acerto ${pct(ag.agregado.acerto)} vs mercado ${pct(ag.agregado.base)} vs regra de tendência ${pct(ag.regraTendencia.acerto)}`);
    });
    resultado.grupos.push({ nome: g.nome, custo: g.custo, horizontes: blocos });
  }

  fs.mkdirSync(SAIDA, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(SAIDA, `walkforward-${stamp}.json`), mdPath = path.join(SAIDA, `walkforward-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2));
  fs.writeFileSync(mdPath, markdown(resultado));
  console.log(`\nRelatório: ${mdPath}\nDados brutos: ${jsonPath}`);
}

function markdown(r) {
  const L = [`# Validação walk-forward — ${r.geradoEm.slice(0, 10)}`, "",
    ...(r.sintetico ? ["> ATENÇÃO: relatório SINTÉTICO (dados aleatórios). Não é resultado de mercado.", ""] : []),
    `Janela: ${r.anos} anos, ${r.folds} blocos de teste disjuntos, intervalo das criptos: ${r.intervalo}.`, "",
    "Tudo aqui é fora da amostra: cada bloco é calibrado só com o passado e medido em seguida. A coluna 'regra' compara com comprar sempre que a tendência de 200 dias for de alta.", ""];
  for (const g of r.grupos) {
    L.push(`## ${g.nome} (custo ida e volta ${(100 * g.custo).toFixed(2)}%)`, "",
      "| Horizonte | Compras | Acerto | Mercado (sempre subir) | Regra tendência | Compras independentes | Retorno líquido médio | Veredito |",
      "|---|---|---|---|---|---|---|---|");
    for (const h of g.horizontes) L.push(linha({ ...h, H: h.horizonte }));
    L.push("");
    for (const h of g.horizontes) {
      L.push(`### Por regime — horizonte ${h.horizonte}`, "", "| Regime | Dias | Compras | Acerto de compra | Mercado |", "|---|---|---|---|---|");
      for (const [k, v] of Object.entries(h.regimeTendencia)) L.push(`| tendência ${k} | ${v.dias} | ${v.compras} | ${pct(v.acerto)} | ${pct(v.base)} |`);
      for (const [k, v] of Object.entries(h.regimeVolatilidade)) L.push(`| ${k} | ${v.dias} | ${v.compras} | ${pct(v.acerto)} | ${pct(v.base)} |`);
      if (h.excluidos && h.excluidos.length) {
        L.push("", "Ativos fora do cálculo (dados insuficientes):", "");
        for (const x of h.excluidos) L.push(`- ${x.ativo}: ${x.motivo}`);
      }
      L.push("", "| Ativo | Compras | Acerto | Retorno líquido médio |", "|---|---|---|---|");
      for (const a of h.porAtivo) L.push(`| ${a.ativo} | ${a.compras} | ${pct(a.acerto)} | ${pct(a.retornoLiquidoMedio)} |`);
      L.push("");
    }
  }
  L.push("Veredito 'vantagem fora da amostra' exige: acerto acima do mercado com limite inferior de Wilson acima do mercado, acima da regra de tendência, retorno líquido positivo e pelo menos 10 compras independentes. Se não aparecer, não ajuste os parâmetros ao vivo por causa deste relatório.", "");
  return L.join("\n");
}

main().catch(e => { console.error("Falha:", e.message); process.exit(1); });
