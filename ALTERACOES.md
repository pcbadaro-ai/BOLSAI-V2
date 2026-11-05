# Alterações aplicadas sobre o projeto do site (BOLSAI-main)

## Minhas alterações (conversa)
- server.js: senha padrão do /aprendizado removida. Sem LEARN_PASS no ambiente, o endpoint fica fechado.
- server.js: a checagem de pasta estática usa separador (public-xyz não passa como public).
- lib/memory.js: confiança do estudo usa lib/confidence.js (tamanho efetivo n/H + Wilson).
- lib/memory.js: completedCloses descarta a vela de hoje ainda aberta (o comentário dizia que fazia, o código não fazia).
- lib/confidence.js, lib/neural.js (novos), confidence.test.js, neural.test.js (novos).
- analysis.js: o limite de Wilson de "alta" passou de 80% para 95% unilateral (z=1,645).
  Medido em 60 passeios aleatórios: "alta" caiu de 11,7% (7/60) para 1,7% (1/60); em tendência real, de 8/40 para 3/40.

## Correções de teste (o original não rodava)
- analysis.test.js, server.test.js, libs.test.js: caminhos "../" trocados por "./" (os testes estão na raiz).
- analysis.test.js: o teste de ruído passou a medir a vantagem média ponderada por nEff em 40 passeios
  (com 8 passeios o erro padrão era ~0,1, igual ao limite do teste).
- libs.test.js: universo BR com 21 ações (COGN3 incluída).
- server.test.js: MEMORY_FILE temporário, para o teste não gravar no model-memory.json real.
- lib/memory.js: lê MEMORY_FILE.

## Rodada 2: testes do servidor e universo
Todos os 33 testes passam (inclusive os 11 de server.test.js), com um stub local de `ws`
(o ambiente não tinha acesso ao npm). Rode `npm install && npm test` para confirmar com o `ws` real.

Bugs reais corrigidos em server.js:
- debounce: antes de N leituras iguais devolvia null e o rótulo novo aparecia na hora (filtro não filtrava). Agora mantém o rótulo estável.
- numbersNotFound: milhar em pt-BR ("76.627") gerava falso alerta; e porcentagens pequenas ("Selic a 17%") eram isentas por parecerem dia do mês. Agora porcentagem sempre é conferida.
- validateAI: citar manchete inexistente agora gera nota e tira o selo "verificado".
- stockDue: ativo que nunca carregou e falhou ignorava o intervalo de 60 s e era rebuscado a cada ciclo.

Testes atualizados ao contrato atual: fontes como objetos {id, src, url}; finalRec lê a.finals (o rebaixamento da IA é aplicado em drainAI);
pouco histórico = menos de 50 candles; validateFeed precisa de a.price; mock do Gemini com text().

Decisões:
- Universo BR com 21 ações: COGN3 (Cogna Educação) readicionada em lib/universe.js. Total = 51 ativos (10 cripto + 20 EUA + 21 B3). Atualizados libs.test.js, ESPERADO e a checagem do /health em atalhos/bolsai.py, e o README.
- README/render.yaml falavam de X (Twitter) e Telegram, que o servidor não implementa; removidos. Se quiser esses recursos, precisam ser construídos.
- Novos: .env.example (o README citava e não existia), pasta atalhos/ (Python + Bash + PowerShell + Batch), Makefile, scripts npm setup/health/ativos.

## Rodada 4: histórico persistente
- lib/history.js (novo): arquiva candles por ativo (data/mercado, gravação atômica), registra sinais quando mudam ou a cada 6 h, e confere cada compra/evitar com o preço real H períodos depois (resultados.jsonl). Sem dependências.
- server.js: a análise chama archiveCandles e recordSignals; o estudo chama grade(); /health mostra o resumo; nova rota /historico?s=SENHA&tipo=sinais|resultados|mercado (baixa JSONL). A checagem de senha de /aprendizado e /historico virou a função senhaOk.
- render.yaml: disco bolsai-dados em /var/data (2 GB), HISTORY_DIR=/var/data/historico e MEMORY_FILE=/var/data/model-memory.json. O disco exige plano pago (starter ou superior) e impede deploy sem parada.
- history.test.js (novo, 6 testes) e teste HTTP de /historico em server.test.js (senha, tipo inválido, cabeçalho de download). Suíte: 40 testes passam (com stub do ws).
- server.js exporta `server` para o teste subir uma porta temporária.
- .gitignore: node_modules/, data/, .env.
- O que NÃO foi feito: reconstruir sinais de dias em que o site estava desligado (daria para usar backtestSignals para isso, mas seria simulação, não o que o site disse na época). Também não usei os resultados reais para mudar pesos automaticamente; hoje eles só aparecem em /health e no arquivo.


## Rodada 5 (v10): validação fora da amostra e filtro de notícias
Detalhes em `ALTERACOES-v10.md`. Resumo:
- lib/news.js: relevância com contexto para nomes ambíguos (Tron, Apple, Vale...) e exclusão de ruído (carros, marcas esportivas). Corrige "Audi e-tron" virando "Tron".
- pesquisa/: walk-forward com blocos disjuntos, padronização sem vazamento, purge, custo de transação, regra de tendência como referência, validação entre ativos e relatório por regime.
- lib/regime.js: regimes de tendência e volatilidade calculados só com passado.
- analysis.js: só exporta funções existentes (sem mudar o comportamento).
- Testes novos: pesquisa/walkforward.test.js (7) e relevance.test.js (4). Suíte: 39/40 (server.test.js precisa do ws).
