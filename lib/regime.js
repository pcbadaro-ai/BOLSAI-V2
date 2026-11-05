"use strict";
/*
 * Regimes de mercado (v10). Cada data recebe um rótulo usando SOMENTE preços até essa data,
 * para que o relatório por regime não use informação do futuro.
 *
 * Tendência: "alta" se o preço está acima da média de 200 dias (com folga de 2%) e a média subindo
 *            nos últimos 20 dias; "baixa" é o simétrico; o resto é "lateral".
 * Volatilidade: "vol_alta" se o desvio dos últimos 20 retornos for pelo menos 2x o do último ano.
 */

function smaAt(closes, i, L) {
  let s = 0;
  for (let k = i - L + 1; k <= i; k++) s += closes[k];
  return s / L;
}

function stdevLog(closes, from, to) { // retornos logarítmicos de from..to (inclusive)
  const r = [];
  for (let i = from; i <= to; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
}

/* Rótulo de tendência por índice (null antes de haver 200 + 20 dias). */
function trendLabels(closes, { L = 200, slope = 20, band = 0.02 } = {}) {
  const out = new Array(closes.length).fill(null);
  for (let i = L + slope; i < closes.length; i++) {
    const s = smaAt(closes, i, L), s0 = smaAt(closes, i - slope, L), c = closes[i];
    if (c > s * (1 + band) && s > s0) out[i] = "alta";
    else if (c < s * (1 - band) && s < s0) out[i] = "baixa";
    else out[i] = "lateral";
  }
  return out;
}

/* Rótulo de volatilidade por índice (null antes de haver 250 retornos). */
function volLabels(closes, { cap = 2.0 } = {}) {
  const out = new Array(closes.length).fill(null);
  for (let i = 250; i < closes.length; i++) {
    const recent = stdevLog(closes, i - 19, i), long = stdevLog(closes, i - 249, i);
    out[i] = long > 0 && recent / long >= cap ? "vol_alta" : "vol_normal";
  }
  return out;
}

module.exports = { trendLabels, volLabels, smaAt };
