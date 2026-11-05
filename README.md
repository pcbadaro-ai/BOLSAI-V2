# Sinal Semanal (versão servidor)

O servidor fica ligado, recebe preços de **cripto** (Binance, ao vivo), das **20 maiores ações dos EUA** e das **21 principais ações do Brasil (B3)**, refaz a análise em três horizontes (1 semana, 1 mês e 5 meses), lê notícias reais pede a leitura da IA (Google Gemini) e avisa quando um sinal muda.

## Atalhos (Python, Bash, PowerShell, Batch, Make)
Todos chamam o mesmo núcleo, `atalhos/bolsai.py` (só biblioteca padrão do Python 3.8+): `setup`, `start`, `mock`, `test`, `health`, `ativos`, `tudo`.
- Qualquer sistema: `python3 atalhos/bolsai.py mock`
- Linux/macOS: `./atalhos/bolsai.sh test` ou `make test`
- Windows: `atalhos\bolsai.bat start` ou `.\atalhos\bolsai.ps1 start`
- Node: `npm run setup | mock | test | health | ativos`

## Rodar no computador
1. Instale o Node 20 ou mais novo (nodejs.org).
2. Nesta pasta: `npm install`
3. Copie `.env.example` para `.env` e preencha só o que for usar.
4. `npm start` e abra http://localhost:3000
   - Para testar sem internet e sem chaves: `npm run mock` (usa dados e uma manchete FALSOS, marcados como teste)
   - Para rodar os testes automáticos: `npm test`

## Publicar para abrir no celular de qualquer lugar
O servidor precisa ficar ligado o tempo todo. Planos grátis que dormem por inatividade (como o grátis do Render) param o monitoramento e os alertas.

**Render (mais simples)**
1. Coloque esta pasta num repositório do GitHub (pode ser privado).
2. No Render: New > Blueprint, escolha o repositório. Ele lê o `render.yaml`.
3. Preencha as variáveis pedidas (deixe em branco o que não for usar).
4. Abra `https://SEU-APP.onrender.com` no celular. O site não tem senha; quem tiver o endereço vê o painel.

**Railway ou Fly.io**: aponte para o repositório. O `Dockerfile` já está pronto (comando `node server.js`, porta lida de `PORT`). Cadastre as mesmas variáveis no painel.

**Na sua rede**: abra `http://IP-DO-COMPUTADOR:3000` no celular, com o computador ligado.

Teste rápido depois de publicar: abra `/health` (ou rode `python3 atalhos/bolsai.py health`). Deve mostrar `ok:true`, `live:true`, `analisados` igual a `assets` (51) e `acoesBRAnalisadas` igual a 21. O campo `ai` mostra o modelo em uso e o último erro da IA, se houver. Logo após ligar, leva alguns minutos até todos os ativos serem analisados.

## O que cada chave liga
| Variável | Liga | Custo |
|---|---|---|
| (nenhuma) | Cripto ao vivo, ações EUA e B3 (Yahoo Finance, fonte não oficial), notícias, dados do Banco Central | grátis |
| GROQ_API_KEY | Leitura da IA pela Groq (usada só se não houver chave Gemini) | plano grátis/dev da Groq |
| GEMINI_API_KEY | Leitura da IA (Gemini) | conforme o plano da sua conta Google AI. Com 51 ativos e `AI_EVERY_MIN=20` são cerca de 153 chamadas por hora; aumente `AI_EVERY_MIN` para gastar menos |
| TWELVEDATA_KEY | Fonte principal das ações dos EUA e reserva da B3 | plano grátis serve |
| BRAPI_TOKEN | Segunda reserva para a B3 | opcional |

## Ativos
- **Cripto (10)**: BTC, ETH, BNB, XRP, SOL, TRX, DOGE, ADA, LINK, AVAX.
- **Ações EUA (20)**: AAPL, NVDA, MSFT, GOOGL, AMZN, TSM, TSLA, META, AVGO, LLY, BRK.B, MU, WMT, JPM, AMD, V, XOM, JNJ, ASML, MA (ranking de 30/10/2026).
- **Ações Brasil (20)**: PETR4, ITUB4, VALE3, BPAC11, ABEV3, WEGE3, BBDC4, ITSA4, AXIA3, VIVT3, BBAS3, SANB11, SBSP3, BBSE3, EMBJ3, RDOR3, B3SA3, CXSE3, SUZB3, PRIO3.
  - Base: ranking de valor de mercado do Investidor10 consultado em 02/11/2026 (depois da queda pós-eleição). O top 12 confere com a Elos Ayta de 13/10/2026. Cada empresa aparece uma vez, na classe mais negociada (Bradesco = BBDC4). Itaúsa (ITSA4) é holding e anda junto com o Itaú; se preferir, troque por ENEV3 (Eneva).
  - O ranking muda com o mercado. Para trocar a lista, edite `BR` em `lib/universe.js`. Os preços da B3 saem ajustados por dividendos e desdobramentos (retorno total).
  - AXIA3 (ex-Eletrobras) e EMBJ3 (Embraer) mudaram de código; se o histórico do código novo for curto, o servidor usa o antigo.

## Como a IA é impedida de inventar
1. **Só manchetes reais**: vêm do Google Notícias (RSS) e do CryptoCompare, têm link http(s), data válida de no máximo 10 dias e precisam citar o ativo. Sem isso, a manchete é descartada.
2. **Numeradas**: a IA recebe N1, N2... e só pode citar esses números. O painel mostra os links das fontes que ela citou.
3. **Conferência no servidor**: números de manchete inexistentes são ignorados; qualquer número no texto da IA que não esteja nos dados enviados gera um aviso amarelo no painel.
4. **Rebaixar exige fonte**: a IA só pode manter ou rebaixar o sinal, e só rebaixa se citar ao menos uma manchete verificável. Sem fonte, o rebaixamento é ignorado.
5. **Cenários**: a IA descreve o que pode acontecer (se subir, mais provável, se cair), sempre a partir dos dados recebidos.
6. **Contexto macro do Brasil**: nas ações da B3 a IA também recebe Selic, dólar e IPCA direto do Banco Central.
7. **Limite**: isto reduz invenção, não elimina. A IA pode interpretar mal uma manchete real. Clique nas fontes antes de decidir.

## Horizontes: 1 semana, 1 mês e 5 meses
Os botões do topo mudam o prazo da previsão. Cripto usa 7, 30 e 150 dias; ações usam 5, 21 e 105 pregões. Quanto maior o prazo, menos janelas independentes existem no histórico e mais difícil é comprovar o acerto. No horizonte de 5 meses a confiança quase sempre será "baixa". Leia como cenário, não como sinal.

## Como ler os números (importante)
- **Nenhum modelo de mercado acerta 99,9%.** Em teste com dados puramente aleatórios o acerto fica perto de 50% (isso é verificado em `npm test`). O painel só dá confiança alta quando o histórico comprova vantagem estatística.
- **Acerto do sinal** vem de teste no passado, usando em cada data só o que existia antes dela (também verificado em `npm test`). Não garante o futuro.
- **Confiança** só sobe quando o acerto supera o do mercado com folga estatística (limite inferior de Wilson de 90%). Com 51 ativos e 3 horizontes, espere alguns sinais falsos por sorte. Dê mais peso a confiança "alta" ou "média".
- **Regime de volatilidade**: se a volatilidade dos últimos 20 dias for 2x ou mais a do último ano (como na semana pós-eleição na B3, quando o Ibovespa caiu 18%), os casos parecidos do passado deixam de valer. Nesse caso "Comprar" é rebaixado para "Observar" e o painel avisa.
- **Horário**: o painel só destaca uma hora do dia se ela se distinguir do ruído (t >= 3).
- O rótulo do sinal só muda depois de várias análises seguidas: 3 para cripto (cerca de 3 minutos) e 2 para ações (que reanalisam a cada 30 minutos com o pregão aberto). O Telegram avisa no máximo uma vez a cada 30 minutos por ativo.
- **Ações**: o servidor nunca usa a vela do pregão em andamento como se fosse fechamento. Depois do fechamento ele busca o dado de novo para gravar o fechamento final. Preços do Yahoo podem ter atraso de alguns minutos; dados com mais de 12 dias de atraso ou preço com mais de 35% de distância do último fechamento são recusados. Datas de saída ignoram feriados.
- Yahoo Finance é fonte **não oficial**: pode bloquear servidores em nuvem. Se isso acontecer, preencha `TWELVEDATA_KEY` e/ou `BRAPI_TOKEN`.

## Regras de segurança do código
- A IA só pode manter ou rebaixar o sinal estatístico, nunca melhorá-lo.
- Se o X ou uma API falhar, o servidor pausa aquela fonte e segue com o resto.
- A senha do painel é comparada em tempo constante, e a página manda `Referrer-Policy: no-referrer` para a senha (que vai na URL) não vazar ao abrir links de notícias.
- Nada aqui executa ordens de compra ou venda.

## Testes (`npm test`)
33 testes automáticos (incluindo os do servidor, que precisam do pacote `ws` instalado com `npm install`): o modelo não usa dados do futuro; ruído puro não gera confiança alta; regime de volatilidade; leitura de RSS, Yahoo, brapi, Twelve Data e Banco Central; horários da B3 e dos EUA; vela parcial nunca vira fechamento; troca de código AXIA3 para ELET3; validação das respostas da IA (manchete inventada, rebaixamento sem fonte, número fora dos dados); troca automática de modelo do Gemini e chave nunca na URL; conferência de números em formato brasileiro (76.627) e de porcentagens; filtro de oscilação do sinal; recusa de nova tentativa logo após falha.

## Histórico (disco persistente)

No Render, o servidor grava em `/var/data` (disco definido no `render.yaml`):

- **mercado**: candles diários de cada ativo, arquivados a cada 6 h. Quando o site fica fora do ar, os dias perdidos voltam pelos provedores na próxima ligada.
- **sinais**: cada vez que o sinal de um horizonte muda (ou a cada 6 h) o que o modelo disse, com preço, probabilidade e confiança.
- **resultados**: cada sinal de compra ou de evitar conferido com o preço real depois de H pregões/dias. É o teste para a frente, que o backtest não dá.

Para baixar (sem senha; quem tiver o endereço pode baixar):

    https://SEU-SITE/historico?tipo=sinais
    https://SEU-SITE/historico?tipo=resultados
    https://SEU-SITE/historico?s=SENHA&tipo=mercado

Os arquivos são JSONL (uma linha por registro). `/health` mostra a contagem e o acerto real por horizonte. O aprendizado também fica no disco (`MEMORY_FILE`). Sem disco, o Render apaga tudo a cada deploy ou reinício.

## Validação fora da amostra (pesquisa, v10)
`npm run pesquisa` roda o walk-forward em várias criptos e ações da B3, com 5 anos de histórico por padrão
(`--anos 10` para mais), intervalo diário ou 4h nas criptos (`--intervalo 4h`), custo de transação e
comparação com "sempre subir" e com a regra "comprar acima da média de 200 dias". Gera
`relatorio/walkforward-DATA.md`. Precisa de internet. Só mude os parâmetros do site se o veredito
"vantagem fora da amostra" aparecer no relatório. Detalhes e limites: `ALTERACOES-v10.md`.
