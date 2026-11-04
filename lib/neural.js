"use strict";
/*
 * Rede neural própria (MLP pequeno, em JavaScript puro, sem dependências).
 *
 * Entrada: 7 características calculadas só com preços até o dia t (retornos, volatilidade, RSI, distância das médias).
 * Saída: probabilidade de o preço estar mais alto em t+H.
 *
 * Validação: walk-forward com treino expandido. Para prever um bloco, o treino usa só rótulos
 * já conhecidos naquele momento (t+H < início do bloco). Nunca se embaralha o tempo.
 * Comparação obrigatória com duas referências: "sempre a classe majoritária do treino" e "sinal do retorno de 20 dias".
 */
const { classify, effectiveN } = require("./confidence");

const MIN_HIST = 50;
const N_FEATURES = 7;

// gerador determinístico (mesma semente = mesmo resultado em qualquer máquina)
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// características no instante t, usando apenas c[0..t]
function features(c, t) {
  if (t < MIN_HIST || t >= c.length) return null;
  const lr = i => Math.log(c[i] / c[i - 1]);
  const r1 = lr(t);
  const r5 = Math.log(c[t] / c[t - 5]);
  const r20 = Math.log(c[t] / c[t - 20]);
  let s = 0, s2 = 0;
  for (let i = t - 19; i <= t; i++) { const r = lr(i); s += r; s2 += r * r; }
  const m = s / 20;
  const vol = Math.sqrt(Math.max(0, s2 / 20 - m * m));
  let up = 0, dn = 0;
  for (let i = t - 13; i <= t; i++) { const d = c[i] - c[i - 1]; if (d > 0) up += d; else dn -= d; }
  const rsi = up + dn === 0 ? 0.5 : up / (up + dn);
  const sma = k => { let x = 0; for (let i = t - k + 1; i <= t; i++) x += c[i]; return x / k; };
  return [r1, r5, r20, vol, rsi - 0.5, c[t] / sma(20) - 1, c[t] / sma(50) - 1];
}

// MLP: F -> hidden (tanh) -> 1 (sigmoide), SGD com log-loss. Normalização só com dados de treino.
function fitMLP(X, y, { hidden = 8, epochs = 40, lr = 0.02, seed = 1 } = {}) {
  const F = N_FEATURES, rand = rng(seed);
  const mu = [], sd = [];
  for (let j = 0; j < F; j++) {
    let mean = 0; for (const x of X) mean += x[j]; mean /= X.length;
    let v = 0; for (const x of X) v += (x[j] - mean) ** 2;
    mu.push(mean); sd.push(Math.sqrt(v / X.length) || 1);
  }
  const Z = X.map(x => x.map((v, j) => (v - mu[j]) / sd[j]));
  const W1 = Array.from({ length: hidden }, () => Array.from({ length: F }, () => (rand() * 2 - 1) * 0.5));
  const b1 = new Array(hidden).fill(0);
  const W2 = Array.from({ length: hidden }, () => (rand() * 2 - 1) * 0.5);
  let b2 = 0;
  const order = Z.map((_, i) => i);

  for (let e = 0; e < epochs; e++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    for (const k of order) {
      const x = Z[k], h = new Array(hidden);
      for (let a = 0; a < hidden; a++) {
        let s = b1[a]; for (let j = 0; j < F; j++) s += W1[a][j] * x[j];
        h[a] = Math.tanh(s);
      }
      let o = b2; for (let a = 0; a < hidden; a++) o += W2[a] * h[a];
      const p = 1 / (1 + Math.exp(-o));
      const g = p - y[k];
      for (let a = 0; a < hidden; a++) {
        const gh = g * W2[a] * (1 - h[a] * h[a]);
        W2[a] -= lr * g * h[a];
        b1[a] -= lr * gh;
        for (let j = 0; j < F; j++) W1[a][j] -= lr * gh * x[j];
      }
      b2 -= lr * g;
    }
  }

  return {
    predict(x) {
      const z = x.map((v, j) => (v - mu[j]) / sd[j]);
      let o = b2;
      for (let a = 0; a < hidden; a++) {
        let s = b1[a]; for (let j = 0; j < F; j++) s += W1[a][j] * z[j];
        o += W2[a] * Math.tanh(s);
      }
      return 1 / (1 + Math.exp(-o));
    }
  };
}

// Walk-forward: retreina a cada `step` barras e prevê o bloco seguinte, sem olhar o futuro.
function walkForward(closes, H, opts = {}) {
  const { minTrain = 252, step = 21, hidden = 8, epochs = 40, lr = 0.02, seed = 1 } = opts;
  const n = closes.length;
  const feat = [];
  for (let t = 0; t < n; t++) feat[t] = features(closes, t);

  let total = 0, hits = 0, baseHits = 0, momHits = 0;
  for (let start = minTrain; start + H <= n; start += step) {
    const X = [], y = [];
    for (let t = MIN_HIST; t + H < start; t++) {
      const d = closes[t + H] - closes[t];
      if (!feat[t] || Math.abs(d / closes[t]) < 1e-3) continue;
      X.push(feat[t]); y.push(d > 0 ? 1 : 0);
    }
    if (X.length < 30) continue;
    const upShare = y.reduce((a, b) => a + b, 0) / y.length;
    const majority = upShare >= 0.5 ? 1 : 0;
    const model = fitMLP(X, y, { hidden, epochs, lr, seed: seed + start });

    const end = Math.min(start + step, n - H);
    for (let t = start; t < end; t++) {
      const d = closes[t + H] - closes[t];
      if (Math.abs(d / closes[t]) < 1e-3) continue;
      const actual = d > 0 ? 1 : 0;
      total++;
      if ((model.predict(feat[t]) >= 0.5 ? 1 : 0) === actual) hits++;
      if (majority === actual) baseHits++;
      if ((feat[t][2] > 0 ? 1 : 0) === actual) momHits++;
    }
  }

  const v = classify(hits, total, H);
  return {
    n: total,
    nEff: effectiveN(total, H),
    acc: total ? hits / total : null,
    baseAcc: total ? baseHits / total : null,
    momAcc: total ? momHits / total : null,
    label: v.label,
    lower: v.lower
  };
}

module.exports = { features, fitMLP, walkForward, MIN_HIST, N_FEATURES };
