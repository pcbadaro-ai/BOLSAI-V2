# Alterações — versão 11 (BTC ausente, falha silenciosa)

Base: BOLSAI-v10.

## 1. BTC (e outras criptos) sem preço — `lib/binance.js` (novo), `server.js`

Causa provável: o servidor buscava cripto só em api.binance.com. Hospedagem nos EUA (como o Render)
costuma receber HTTP 451 dessa API. A cripto então caía no Yahoo; se o Yahoo também falhasse, o ativo
ficava na lista com "…" e sem explicação. O relatório de pesquisa já usava data-api.binance.vision,
que não tem esse bloqueio.

O que mudou:
- O loader da Binance tenta os dois hosts em ordem (`lib/binance.js`). Se ambos falham, o erro lista o
  motivo de cada um.
- Quando nenhuma fonte de cripto funciona, o ativo guarda o motivo (`erro`), que vai para o painel.
- Tentativas de cripto com falha respeitam o intervalo de 60 s (antes eram refeitas a cada volta do loop).

## 2. Painel mostra o motivo — `public/index.html`

Uma cripto sem preço aparece com "sem preço" na linha; o motivo completo fica no tooltip.

## 3. Relatório de pesquisa não esconde ativos — `pesquisa/walkforward.js`, `pesquisa/rodar.js`

Antes, um ativo com dados insuficientes sumia do relatório sem aviso. Agora:
- o console mostra `AVISO <ativo> fora do relatório: <motivo>`;
- o Markdown tem a lista "Ativos fora do cálculo" em cada horizonte, com o motivo;
- se nenhum ativo de um grupo for coletado, o console avisa.

## Testes
- `lib/binance.test.js` (3 testes novos): fallback de host com 451, erro com o motivo de cada host,
  velas duplicadas e preço zero.
- Passam: binance (3), walkforward (7), relevance (4), libs (7), analysis (5), history (6),
  confidence + neural (10).
- `server.test.js` precisa do pacote `ws` (`npm install`) e não foi executado aqui.
- Pipeline de pesquisa testado em modo sintético com janela curta (exibe as exclusões).

## Como confirmar o BTC na sua máquina/Render
1. Veja `/health` → `crypto.err`. Se aparecer "Binance indisponível (... 451 ...)", era o bloqueio.
2. No log, procure `[cripto] BTC`. Com esta versão, uma falha total aparece com o motivo nos dois hosts.
3. `npm run pesquisa` agora diz no console se o BTC ficou de fora e por quê.

## Não feito
- Não rodei com rede: este ambiente não tem acesso à internet nem ao pacote `ws`.
- O motivo exato do BTC na sua execução depende da resposta real da Binance/Yahoo no seu ambiente;
  o `/health` e o painel agora mostram isso.
