# Alterações — versão 10 (validação fora da amostra e filtro de notícias)

Base: BOLSAI-v9 (arquivo enviado). Nada foi removido do comportamento do servidor ao vivo; as mudanças
de validação ficam na pasta nova `pesquisa/` e não alteram os sinais que o site mostra.

## 1. Filtro de notícias (o problema do Tron e do Audi e-tron) — afeta o site

Arquivo: `lib/news.js` (função `relevant`).

Causa: a checagem aceitava qualquer palavra isolada. "Audi e-tron" vira "audi e tron", e "tron" batia com
o ativo TRX (TRON). Marcas esportivas também passavam porque o nome podia aparecer em qualquer contexto.

O que mudou:
- **Ruído conhecido derruba a manchete sempre**: carros (Audi, Porsche, e-tron, BMW, Mercedes etc.) e marcas
  esportivas (Nike, Adidas, Puma, Reebok, Under Armour, Lululemon, New Balance, Asics, Mizuno).
- **Nomes ambíguos exigem contexto de mercado**: Tron, Apple, Meta, Visa, Amazon, Micron, Lilly, Vale, MA,
  Avalanche, Link. Só passam se a manchete tiver termo de mercado (cripto, token, ações, B3, lucro, CEO,
  Justin Sun etc.), um código da B3 (VALE3, PETR4...) ou o código em maiúsculas (TRON, MA).
- Nomes e códigos não ambíguos continuam funcionando como antes.

Testes novos: `relevance.test.js` (4 testes, 10 verificações, incluindo os dois problemas citados). Todos passam.

## 2. Validação walk-forward com dados fora da amostra — nova pasta `pesquisa/`

Arquivo: `pesquisa/walkforward.js`.

- Blocos de teste consecutivos e disjuntos. O primeiro treino é a metade inicial da história; cada bloco de
  teste só é medido depois de calibrado com o passado.
- **Sem vazamento na padronização**: o modelo de cada bloco usa média e desvio só de dados até o início do
  bloco de teste (antes, a padronização usava os primeiros 60% da história inteira).
- **Purge**: a calibração usa só sinais cujo resultado já era conhecido no início do teste (t + H < início).
- **Custo de transação** descontado do retorno das compras (padrão 0,2% cripto e 0,1% ações, ida e volta).
- Calibração em grade (pUp, filtro de tendência, limiar), escolhida só no treino pelo retorno líquido.
- **Referências no mesmo período**: acerto de "sempre subir" (mercado) e a regra simples "comprar quando o
  preço está acima da média de 200 dias". O modelo só é considerado com vantagem se superar as duas.
- Veredito com critério explícito: "vantagem fora da amostra" exige 30+ compras, 10+ compras independentes,
  acerto acima do mercado com limite inferior de Wilson acima do mercado, acima da regra simples e retorno
  líquido positivo. Caso contrário: "sem vantagem" ou "amostra insuficiente".
- Validação cruzada entre ativos: cada ativo conta o próprio número de compras independentes; o total é
  a soma. Também sai o resultado por ativo, para ver se o padrão é consistente.

## 3. Regimes de mercado — `lib/regime.js` e `pesquisa/rodar.js`

- Tendência por data: alta, baixa ou lateral (preço contra a média de 200 dias e inclinação da média em 20 dias).
- Volatilidade por data: normal ou alta (desvio dos últimos 20 retornos contra o último ano, limite 2x).
- Ambos usam só preços até a própria data. O relatório mostra acerto e número de compras por regime, para
  não confundir 100% com 1 compra.

## 4. Janela histórica e timeframe — `pesquisa/rodar.js`

- `--anos N`: janela de 1 a 10 anos (criptos com paginação da Binance; ações com Yahoo).
- `--intervalo 4h|1d`: cripto em 4 horas ou diário. Horizontes em dias são convertidos em barras.
- Ações B3 e EUA continuam diárias (4h de ações não tem histórico longo grátis).
- Aviso de custo: 4h tem mais sinais, mas o custo por trade pesa mais; o veredito já desconta o custo.

## 5. Relatório e comandos

- `npm run pesquisa` gera `relatorio/walkforward-AAAA-MM-DD.md` (legível) e `.json` (dados brutos).
- `npm run pesquisa:teste` roda com dados sintéticos só para testar o pipeline (o relatório avisa).
- Exemplo: `node pesquisa/rodar.js --anos 10 --folds 6 --cripto BTC,ETH,SOL --intervalo 1d`.

## 6. Arquivos

- Novos: `lib/regime.js`, `pesquisa/walkforward.js`, `pesquisa/rodar.js`, `pesquisa/walkforward.test.js`,
  `relevance.test.js`, `ALTERACOES-v10.md`.
- Alterados: `lib/news.js` (relevance), `analysis.js` (só exporta funções já existentes: confirm, summarize,
  START, MIN_POOL, STEP, D; o comportamento não mudou), `package.json` (versão 1.2.0 e scripts `pesquisa`).

## Testes

- 40 testes no total. 39 passam. O que falha é `server.test.js`, que precisa do pacote `ws`
  (`npm install`). O erro não é desta versão: nesta máquina não há acesso ao npm.
- Os 11 testes novos passam: vazamento de calibração, blocos disjuntos, configuração ao vivo preservada,
  ruído sem vantagem, regimes, volatilidade, custo, e notícias (Tron, Nike, Apple, Vale).

## O que NÃO foi feito, e por quê

- **Não rodei a validação com dados reais.** Este ambiente não tem acesso à internet. Os números do seu
  relatório precisam sair da sua máquina com `npm run pesquisa`. Testei o pipeline com dados sintéticos.
- **Não troquei automaticamente os parâmetros do site** pelo resultado. A regra do projeto continua: só
  mudar se a conferência fora da amostra sustentar. Os relatórios servem para decidir, não para ajustar sozinhos.
- **Custo computacional**: 10 anos de cripto diária é viável (~2 s por 2.500 barras). Cripto em 4h com 5+ anos
  é lento, porque o modelo compara cada dia com todo o histórico. Para 4h, comece com 1 a 2 anos.
- `tune.js` continua como estava. A validação walk-forward a substitui para pesquisa.
- O arquivo `news.js` na raiz é uma versão antiga que não é usada pelo servidor; não foi alterado.
- O servidor continua limitando o histórico ao vivo a 1.500 candles (`MAX_HIST` em `analysis.js`), por
  desempenho. Só a pesquisa usa histórico longo.
