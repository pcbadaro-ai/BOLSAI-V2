"use strict";
/*
 * Rótulo de confiança ("alta" / "média" / "baixa") para um estudo histórico.
 *
 * Por que mudou:
 * - A regra antiga era só `acertos/total >= 0.58`. Com 8 sinais, 6 acertos (75%) já davam "alta",
 *   mesmo sendo ruído. O tamanho da amostra não entrava na conta.
 * - Sinais de horizonte H se sobrepõem (um sinal em t cobre t..t+H). Por isso o tamanho efetivo
 *   é n/H (blocos não sobrepostos), não n.
 * - "alta" exige o limite inferior de Wilson (uma cauda) acima de 55%, com tamanho efetivo >= 10.
 */

const Z_ONE_SIDED = 1.645; // 95% unilateral

// Limite inferior do intervalo de Wilson para proporção p com n observações.
function wilsonLower(p, n, z = Z_ONE_SIDED) {
  if (!n || n <= 0) return 0;
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (center - margin) / (1 + z2 / n);
}

// Tamanho efetivo: sinais com horizonte H se sobrepõem, então só ~n/H são independentes.
function effectiveN(n, H) {
  return Math.floor(n / Math.max(1, H));
}

const ALTA_MIN_N = 10;
const ALTA_LOWER = 0.55;
const MEDIA_LOWER = 0.5;

// correct/total: acertos e total de sinais direcionais; H: horizonte em pregões/dias.
function classify(correct, total, H) {
  const nEff = effectiveN(total, H);
  const p = total > 0 ? correct / total : 0;
  const lower = wilsonLower(p, nEff);
  let label = "baixa";
  if (nEff >= ALTA_MIN_N && lower >= ALTA_LOWER) label = "alta";
  else if (nEff >= ALTA_MIN_N && lower > MEDIA_LOWER) label = "média"; // média também exige ALTA_MIN_N testes independentes
  return { label, p, nEff, lower };
}

module.exports = { wilsonLower, effectiveN, classify, ALTA_MIN_N, ALTA_LOWER };
