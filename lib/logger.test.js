"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

let logger, dir;
beforeEach(() => {
  delete require.cache[require.resolve("./logger")];
  logger = require("./logger");
  logger._reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bolsai-log-"));
  process.env.LOG_DIR = dir;
});
const hoje = () => new Date().toISOString().slice(0, 10);

test("grava no arquivo do dia com data e hora completas", () => {
  assert.equal(logger.init().ok, true);
  logger.write("cripto", ["BTC", "ok"]);
  logger.flushSync();
  const txt = fs.readFileSync(path.join(dir, "bolsai-" + hoje() + ".log"), "utf8");
  assert.match(txt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[cripto\] BTC ok\n$/);
});

test("sobrevive a reiniciar: o conteúdo anterior continua e o novo é acrescentado", () => {
  logger.init(); logger.write("a", ["antes do desligamento"]); logger.flushSync();
  logger._reset(); process.env.LOG_DIR = dir;       // simula o processo novo
  logger.init(); logger.write("b", ["depois de ligar"]); logger.flushSync();
  const txt = fs.readFileSync(path.join(dir, "bolsai-" + hoje() + ".log"), "utf8");
  assert.match(txt, /antes do desligamento/);
  assert.match(txt, /depois de ligar/);
});

test("tail devolve só as últimas linhas pedidas", () => {
  logger.init();
  for (let i = 1; i <= 50; i++) logger.write("t", ["linha " + i]);
  const linhas = logger.tail(5).trim().split("\n");
  assert.equal(linhas.length, 5);
  assert.match(linhas.at(-1), /linha 50$/);
});

test("apaga logs com mais de 30 dias e preserva os recentes e arquivos alheios", () => {
  const velho = path.join(dir, "bolsai-2020-01-01.log"), novo = path.join(dir, "bolsai-" + hoje() + ".log"), outro = path.join(dir, "notas.txt");
  for (const f of [velho, novo, outro]) fs.writeFileSync(f, "x\n");
  const antigo = new Date(Date.now() - 40 * 86400000); fs.utimesSync(velho, antigo, antigo); fs.utimesSync(outro, antigo, antigo);
  logger.init();
  assert.equal(fs.existsSync(velho), false);
  assert.equal(fs.existsSync(novo), true);
  assert.equal(fs.existsSync(outro), true, "não mexe em arquivo que não é log do bolsai");
});

test("limite diário: para de gravar e deixa um aviso", () => {
  logger.init();
  const grande = "x".repeat(1024 * 1024);
  for (let i = 0; i < 12; i++) { logger.write("g", [grande]); logger.flushSync(); }
  const f = path.join(dir, "bolsai-" + hoje() + ".log");
  assert.ok(fs.statSync(f).size <= 10 * 1024 * 1024 + 4096, "não passa de ~10 MB");
  assert.match(fs.readFileSync(f, "utf8"), /limite de 10 MB atingido/);
});

test("pasta sem permissão não derruba nada: init avisa e write vira no-op", () => {
  const arquivo = path.join(dir, "e-um-arquivo"); fs.writeFileSync(arquivo, "x");
  process.env.LOG_DIR = path.join(arquivo, "logs");   // ENOTDIR em qualquer sistema
  const r = logger.init();
  assert.equal(r.ok, false);
  assert.doesNotThrow(() => { logger.write("x", ["y"]); logger.flushSync(); logger.tail(); });
});

test("ler(dia) só aceita AAAA-MM-DD (sem path traversal)", () => {
  logger.init(); logger.write("a", ["b"]); logger.flushSync();
  assert.notEqual(logger.ler(hoje()), null);
  assert.equal(logger.ler("../../etc/passwd"), null);
  assert.equal(logger.ler("2020-13-99/../x"), null);
});

test("erros são gravados com a pilha", () => {
  logger.init(); logger.write("ERRO", [new Error("falhou aqui")]); logger.flushSync();
  assert.match(logger.tail(10), /Error: falhou aqui/);
});
