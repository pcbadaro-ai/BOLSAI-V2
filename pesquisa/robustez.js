"use strict";
/*
 * Checagem de robustez sobre uma pasta de JSONs do Yahoo (chart, range=10y, interval=1d).
 *   node pesquisa/robustez.js <pasta> [--saida relatorio]
 *
 * Faz três coisas que o relatório principal não faz:
 *  1. p-valor binomial de cada "compras" contra a taxa de acerto do mercado.
 *  2. Correção de Holm sobre TODOS os testes (ativo x horizonte). Sem isso, testar
 *     80 combinações garante alguns "acertos" por acaso.
 *  3. Teste nas duas metades do período, para ver se o efeito se repete.
 * Os p-valores são otimistas: compras sobrepostas não são independentes. Use como filtro, não como prova.
 */
const fs = require("fs"), path = require("path");
const WF = require("./walkforward.js");

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith("--"));
const saidaIdx = args.indexOf("--saida");
const saida = saidaIdx >= 0 ? args[saidaIdx + 1] : "relatorio";
if (!dir) { console.error("uso: node pesquisa/robustez.js <pasta-com-jsons> [--saida pasta]"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const H_LIST = [5, 21], COST = 0.001, FOLDS = 6;

function load(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const r = d?.chart?.result?.[0];
  if (!r) throw new Error("sem dados: " + (d?.chart?.error?.description || "resposta vazia"));
  const q = r.indicators.quote[0].close, adj = r.indicators.adjclose?.[0]?.adjclose || q;
  const c = [], t = [];
  (r.timestamp || []).forEach((ts, i) => {
    if (!Number.isFinite(adj[i]) || !Number.isFinite(q[i])) return;
    if (new Date(ts * 1000).toISOString().slice(0, 10) === today) return;
    c.push(adj[i]); t.push(ts);
  });
  return { sym: r.meta.symbol || path.basename(file, ".json"), c, t };
}

// P(X >= k) para X ~ Binomial(n, p). Soma em log para não estourar com n grande.
function lnChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }
function binomTail(k, n, p) {
  if (n === 0 || p <= 0 || p >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}

function testar(sym, closes, H) {
  const res = [WF.walkForward(sym, closes, H, { folds: FOLDS, cost: COST })];
  const ag = WF.aggregate(res, H, COST), p = ag.agregado;
  const vitorias = Math.round(p.acerto * p.compras);
  return { ativo: sym, H, compras: p.compras, nEff: p.nEff, acerto: p.acerto, mercado: p.base,
           regra: ag.regraTendencia.acerto, retLiq: p.retornoLiquidoMedio, veredito: ag.veredito,
           p: p.compras ? binomTail(vitorias, p.compras, p.base) : 1 };
}

// 1) todos os testes
const arquivos = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
const ativos = [], falhas = [];
for (const f of arquivos) {
  try {
    const x = load(path.join(dir, f));
    if (x.c.length < 300) { falhas.push({ f, motivo: "histórico curto (" + x.c.length + " pregões)" }); continue; }
    ativos.push({ f, ...x });
  } catch (e) { falhas.push({ f, motivo: e.message }); }
}
// Mesmo código em mais de um arquivo (ex.: PETR4 de 5 e de 10 anos): fica só o histórico mais longo.
const porSym = new Map();
for (const a of ativos) {
  const atual = porSym.get(a.sym);
  if (!atual) porSym.set(a.sym, a);
  else if (a.c.length > atual.c.length) { falhas.push({ f: atual.f, motivo: "duplicado de " + a.f + " (histórico menor)" }); porSym.set(a.sym, a); }
  else falhas.push({ f: a.f, motivo: "duplicado de " + atual.f + " (histórico menor)" });
}
ativos.length = 0; ativos.push(...porSym.values());
const testes = [];
for (const a of ativos) for (const H of H_LIST) testes.push(testar(a.sym, a.c, H));

// 2) Holm: ordena os p-valores e compara com 0,05/(m-i)
const m = testes.length, ord = [...testes].sort((a, b) => a.p - b.p);
let parar = false;
ord.forEach((t, i) => { t.limiar = 0.05 / (m - i); t.holm = !parar && t.p <= t.limiar; if (!t.holm) parar = true; });
const sobrevive = testes.filter(t => t.holm);

// 3) metades do período (só para o horizonte de 5 pregões, o único com vantagem nominal)
const metades = [];
for (const a of ativos) {
  const mid = Math.floor(a.c.length / 2);
  const partes = [["1ª metade", 0, mid], ["2ª metade", mid, a.c.length]];
  for (const [nome, i0, i1] of partes) {
    const seg = a.c.slice(i0, i1);
    if (seg.length < 300) continue;
    const r = testar(a.sym, seg, 5);
    metades.push({ ...r, periodo: nome, de: new Date(a.t[i0] * 1000).toISOString().slice(0, 7), ate: new Date(a.t[i1 - 1] * 1000).toISOString().slice(0, 7) });
  }
}

// Relatório
const pc = v => v == null || Number.isNaN(v) ? "—" : (100 * v).toFixed(0) + "%";
const L = [];
L.push("# Checagem de robustez", "", `Gerado em ${new Date().toISOString().slice(0, 10)} · ${ativos.length} ativos · ${m} testes (ativo × horizonte) · custo ${(COST * 100).toFixed(1)}% por operação · ${FOLDS} janelas`, "");
L.push("## Resumo", "");
L.push(sobrevive.length
  ? `${sobrevive.length} teste(s) sobrevivem à correção de Holm: ${sobrevive.map(t => t.ativo + " (" + t.H + " pregões)").join(", ")}.`
  : "Nenhum teste sobrevive à correção de Holm. Com tantas combinações, nenhuma vantagem pode ser afirmada com segurança.", "");
L.push("## Todos os testes, ordenados pelo p-valor", "");
L.push("| Ativo | Horizonte | Compras | Acerto | Mercado | Regra de tendência | p | Limiar Holm | Passa | Veredito do relatório |", "|---|---|---|---|---|---|---|---|---|---|");
for (const t of ord) L.push(`| ${t.ativo} | ${t.H} | ${t.compras} | ${pc(t.acerto)} | ${pc(t.mercado)} | ${pc(t.regra)} | ${t.p.toFixed(4)} | ${t.limiar.toFixed(4)} | ${t.holm ? "sim" : "não"} | ${t.veredito} |`);
L.push("", "## Metades do período (horizonte de 5 pregões)", "");
L.push("| Ativo | Metade | Período | Compras | Acerto | Mercado | Veredito |", "|---|---|---|---|---|---|---|");
for (const r of metades) L.push(`| ${r.ativo} | ${r.periodo} | ${r.de} a ${r.ate} | ${r.compras} | ${pc(r.acerto)} | ${pc(r.mercado)} | ${r.veredito} |`);
L.push("", "Uma vantagem só é consistente se aparecer nas duas metades com amostra suficiente. Metades com menos de 30 compras não sustentam conclusão.", "");
if (falhas.length) { L.push("## Arquivos não usados", ""); for (const f of falhas) L.push(`- ${f.f}: ${f.motivo}`); L.push(""); }
L.push("## Limites", "", "- p-valores assumem operações independentes. Operações de dias seguidos se sobrepõem, então os p-valores reais são maiores que os mostrados.", "- A correção de Holm controla o erro de encontrar algum falso positivo entre todos os testes, mas é conservadora.", "- Um resultado que não passa aqui não prova que o modelo não tem valor. Só diz que não há evidência suficiente.", "");

fs.mkdirSync(saida, { recursive: true });
const nome = path.join(saida, "robustez-" + today + ".md");
fs.writeFileSync(nome, L.join("\n"));
// Lista lida pelo servidor: só estes ativo/horizonte podem mostrar "Comprar". Vazia se nada passou.
const HKEY = { 5: "1s", 21: "1m" };
fs.writeFileSync(path.join(saida, "aprovados.json"), JSON.stringify({
  geradoEm: new Date().toISOString(), criterio: "Holm 5% sobre " + m + " testes",
  aprovados: sobrevive.filter(t => HKEY[t.H]).map(t => ({ ativo: t.ativo, horizonte: HKEY[t.H] }))
}, null, 1));
console.log("Relatório:", nome);
console.log("Aprovados:", path.join(saida, "aprovados.json"), "(copie para pesquisa/aprovados.json para liberar \"Comprar\")");
console.log("testes:", m, "| sobrevivem à correção de Holm:", sobrevive.length);
