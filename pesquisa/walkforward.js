"use strict";
/*
 * Validação walk-forward (v10).
 *
 * Como funciona, para cada ativo e horizonte H:
 *  - A história é cortada em K blocos de teste consecutivos. O primeiro bloco de treino é a metade inicial.
 *  - Para cada bloco de teste [trainEnd, testEnd), o modelo é construído SÓ com dados até testEnd, e a
 *    padronização das características usa SÓ dados até trainEnd (não vaza o futuro do bloco de teste).
 *  - A calibração (pUp, trend, thr) escolhe a combinação com melhor retorno líquido de custos, usando
 *    SÓ sinais cujo resultado já era conhecido em trainEnd (t + H < trainEnd). Esse é o "purge":
 *    um sinal de treino nunca enxerga um preço do bloco de teste.
 *  - Os sinais do bloco de teste são então medidos, sem nenhuma mudança depois de ver o resultado.
 *  - Os blocos de teste são disjuntos. Juntando os blocos, temos um teste fora da amostra de toda a janela.
 *
 * Referências comparadas no mesmo período: acerto de "sempre subir" (mercado) e a regra simples
 * "comprar só quando o preço está acima da média de 200 dias". Se o modelo não superar as duas, não há vantagem.
 */
const A = require("../analysis");
const { wilsonLower } = require("../lib/confidence");
const { trendLabels, volLabels } = require("../lib/regime");

// Grade pequena de calibração (a mesma do tune.js). Inclui a configuração ao vivo (LIVE).
const GRID = [];
for (const pUp of [0.55, 0.58, 0.62]) for (const trend of [0, 100, 200]) for (const thr of [0.15, 0.25, 0.4]) GRID.push({ pUp, trend, thr });
const LIVE = { pUp: 0.58, trend: 200, thr: 0.25 };
const MIN_TRAIN_BUYS = 30; // abaixo disso a calibração não é confiável: usa a configuração ao vivo
const MIN_EFF = 10;        // compras independentes mínimas para o veredito

function setCfg(cfg) { A.setParams({ pUp: cfg.pUp, trend: cfg.trend, thr: cfg.thr }); }

// Registros de sinal para t em [from, testEnd - H), com o modelo treinado só até trainEnd para a padronização.
function buildRecords(closes, H, trainEnd, testEnd) {
  const m = A.buildModel(closes.slice(0, testEnd), H, trainEnd);
  const recs = [];
  const from = A.START + A.MIN_POOL + H;
  for (let t = from; t + H < testEnd; t += A.STEP) {
    const maxIdx = t - H; // só casos cujo resultado já era conhecido em t
    const st = A.stats(m, A.neighbors(m, t, maxIdx), 0);
    recs.push({ t, actual: m.fwd[t], pUp: st.pUp, med: st.med, n: st.n, sg: m.sigmaAt(maxIdx) });
  }
  return { m, recs };
}

// Aplica uma configuração: recalcula o sinal de cada registro com os parâmetros atuais.
function applyCfg(m, recs, cfg) {
  setCfg(cfg);
  A.resignal(m, recs); // recalcula r.sig com os parâmetros atuais (filtro de RSI e tendência incluso)
}

// Métricas de um conjunto de registros. cost = custo de ida e volta em fração (ex.: 0.002 = 0,2%).
function metrics(list, H, cost) {
  const buys = list.filter(r => r.sig === "buy");
  const gap = Math.max(3, Math.floor(H / 3));
  let last = -Infinity, nEff = 0;
  for (const r of buys) if (r.t - last >= gap) { nEff++; last = r.t; }
  const winsBuy = buys.filter(r => r.actual > 0).length;
  const up = list.filter(r => r.actual > 0).length;
  return {
    dias: list.length,
    base: list.length ? up / list.length : null,
    compras: buys.length,
    acerto: buys.length ? winsBuy / buys.length : null,
    retornoLiquidoMedio: buys.length ? buys.reduce((a, r) => a + r.actual - cost, 0) / buys.length : null,
    nEff,
  };
}

// Um bloco de teste: calibra no treino, mede no teste. Devolve os registros do teste com a configuração escolhida.
function runFold(closes, H, trainEnd, testEnd, opts = {}) {
  const cost = opts.cost || 0;
  const trend = opts.trend || trendLabels(closes), vol = opts.vol || volLabels(closes);
  const { m, recs } = buildRecords(closes, H, trainEnd, testEnd);
  const trainRecs = () => recs.filter(r => r.t + H < trainEnd);

  let best = LIVE, bestScore = -Infinity;
  for (const cfg of GRID) {
    applyCfg(m, recs, cfg);
    const tr = metrics(trainRecs(), H, cost);
    if (tr.compras >= MIN_TRAIN_BUYS && tr.retornoLiquidoMedio > bestScore) {
      best = cfg; bestScore = tr.retornoLiquidoMedio;
    }
  }
  applyCfg(m, recs, best);
  const train = metrics(trainRecs(), H, cost);
  const oos = recs.filter(r => r.t >= trainEnd).map(r => ({ t: r.t, actual: r.actual, sig: r.sig, tr: trend[r.t], vol: vol[r.t] }));
  setCfg(LIVE); // restaura os parâmetros ao vivo
  return { trainEnd, testEnd, cfg: best, calibracaoUsada: best !== LIVE, treino: train, oos };
}

// Blocos disjuntos: a primeira metade é treino inicial; o resto é dividido em K blocos de teste.
function foldLayout(n, k) {
  const start = Math.floor(n / 2), len = Math.floor((n - start) / k), out = [];
  for (let i = 0; i < k; i++) {
    const trainEnd = start + i * len;
    out.push({ trainEnd, testEnd: i === k - 1 ? n : trainEnd + len });
  }
  return out;
}

// Walk-forward de um ativo em um horizonte.
function walkForward(name, closes, H, opts = {}) {
  const k = opts.folds || 5;
  const minimo = A.START + A.MIN_POOL + 2 * H + 30 * k;
  if (closes.length < minimo) {
    return { name, H, insuficiente: true, motivo: `dados insuficientes: ${closes.length} barras, mínimo ${minimo}`, folds: [], oos: [] };
  }
  const trend = trendLabels(closes), vol = volLabels(closes);
  const folds = foldLayout(closes.length, k).map(f => runFold(closes, H, f.trainEnd, f.testEnd, { ...opts, trend, vol }));
  const oos = [].concat(...folds.map(f => f.oos));
  return { name, H, insuficiente: false, folds, oos };
}

/*
 * Agrega vários ativos (validação cruzada entre ativos). Cada ativo conta o seu próprio nEff,
 * porque ativos diferentes não são independentes entre si só por terem sido testados juntos.
 */
function aggregate(results, H, cost) {
  const used = results.filter(r => !r.insuficiente);
  const all = [].concat(...used.map(r => r.oos));
  const pooled = metrics(all, H, cost);
  pooled.nEff = used.reduce((a, r) => a + metrics(r.oos, H, cost).nEff, 0);
  pooled.wilsonInferior = pooled.compras && pooled.nEff ? wilsonLower(pooled.acerto, pooled.nEff, 1.645) : 0;
  const byTrend = {}, byVol = {};
  for (const k of ["alta", "baixa", "lateral"]) byTrend[k] = metrics(all.filter(r => r.tr === k), H, cost);
  for (const k of ["vol_normal", "vol_alta"]) byVol[k] = metrics(all.filter(r => r.vol === k), H, cost);
  // Regra simples de referência: "comprar sempre que a tendência for de alta" (mesmos dias, sem o modelo).
  const regra = metrics(all.filter(r => r.tr === "alta").map(r => ({ ...r, sig: "buy" })), H, cost);
  const porAtivo = used.map(r => ({ ativo: r.name, ...metrics(r.oos, H, cost) }));
  const veredito = verdict(pooled, regra);
  return { H, cost, agregado: pooled, regimeTendencia: byTrend, regimeVolatilidade: byVol, regraTendencia: regra, porAtivo, veredito };
}

// Critério do relatório: só afirma vantagem se o acerto superar o mercado E a regra simples, com amostra mínima.
function verdict(p, regra) {
  if (!p.compras || p.compras < 30 || p.nEff < MIN_EFF) return "amostra insuficiente";
  const beatsMarket = p.acerto > p.base && p.wilsonInferior > p.base;
  const beatsRule = regra.acerto != null && p.acerto > regra.acerto;
  const netPositive = p.retornoLiquidoMedio > 0;
  return beatsMarket && beatsRule && netPositive ? "vantagem fora da amostra" : "sem vantagem fora da amostra";
}

module.exports = { walkForward, aggregate, runFold, foldLayout, metrics, verdict, GRID, LIVE };
