"use strict";
// v10: relevância de manchetes. Casos reais do problema: "Tron" (Audi e-tron e marcas esportivas) não podem passar.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const news = require("./lib/news");

test("Audi e-tron não é notícia sobre a Tron (TRX)", () => {
  assert.equal(news.relevant("Audi e-tron GT ganha novo visual", ["TRON", "TRX"]), false);
  assert.equal(news.relevant("Novo e-tron da Audi chega ao Brasil", ["TRON", "TRX"]), false);
});

test("notícias reais da Tron passam (processo de Justin Sun, proposta 108)", () => {
  assert.equal(news.relevant("Justin Sun processo contra a Tron avança", ["TRON", "TRX"]), true);
  assert.equal(news.relevant("TRON proposal 108 gets vote", ["TRON", "TRX"]), true);
  assert.equal(news.relevant("TRX sobe após anúncio de taxas", ["TRON", "TRX"]), true);
});

test("marcas esportivas não entram em nenhum ativo", () => {
  assert.equal(news.relevant("Nike shares jump on new line", ["Nike", "NKE"]), false);
  assert.equal(news.relevant("Adidas reduz preço de tênis", ["Visa", "V"]), false);
});

test("nomes ambíguos exigem contexto de mercado", () => {
  assert.equal(news.relevant("Apple pie recipe for autumn", ["Apple", "AAPL"]), false);
  assert.equal(news.relevant("Apple shares rise after earnings", ["Apple", "AAPL"]), true);
  assert.equal(news.relevant("Valentine day sales rise", ["Vale"]), false);
  assert.equal(news.relevant("Vale (VALE3) sobe", ["Vale"]), true);
});
