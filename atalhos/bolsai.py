#!/usr/bin/env python3
"""Atalhos do Sinal Semanal (BOLSAI). Só biblioteca padrão do Python 3.8+.

Uso:  python atalhos/bolsai.py <comando>
  setup   instala dependências (npm install) e cria .env a partir de .env.example
  start   inicia o servidor de verdade (porta PORT, padrão 3000)
  mock    inicia com dados FALSOS, sem internet e sem chaves
  test    roda os testes automáticos (node --test)
  health  consulta /health e confere se os 51 ativos foram analisados
  ativos  lista os ativos configurados (cripto, EUA, B3) e confere as contagens
  tudo    setup + test
"""
import json, os, re, shutil, subprocess, sys, urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ESPERADO = {"cripto": 10, "eua": 20, "b3": 21}


def node_ok():
    if not shutil.which("node"):
        sys.exit("Node não encontrado. Instale o Node 20+ em nodejs.org.")
    v = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
    if int(v.lstrip("v").split(".")[0]) < 20:
        sys.exit(f"Node {v} é antigo; precisa do 20 ou mais novo.")


def rodar(cmd, env=None):
    e = dict(os.environ, **(env or {}))
    return subprocess.call(cmd, cwd=RAIZ, env=e, shell=(os.name == "nt"))


def setup():
    node_ok()
    ex, env = os.path.join(RAIZ, ".env.example"), os.path.join(RAIZ, ".env")
    if os.path.exists(ex) and not os.path.exists(env):
        shutil.copy(ex, env)
        print("Criado .env (preencha só o que for usar).")
    return rodar(["npm", "install"])


def ler_ativos():
    srv = open(os.path.join(RAIZ, "server.js"), encoding="utf8").read()
    uni = open(os.path.join(RAIZ, "lib", "universe.js"), encoding="utf8").read()
    def bloco(nome):
        m = re.search(r"const %s = \[(.*?)\n\];" % nome, srv, re.S)
        return re.findall(r'\["([A-Z0-9.\-]+)",\s*"([^"]+)"\]', m.group(1)) if m else []
    br = re.findall(r'\{\s*sym:\s*"([A-Z0-9]+)",\s*name:\s*"([^"]+)"', uni)
    return {"cripto": bloco("CRYPTO"), "eua": bloco("STOCKS"), "b3": br}


def ativos():
    dados, ok = ler_ativos(), True
    for k, lista in dados.items():
        marca = "ok" if len(lista) == ESPERADO[k] else f"ESPERADO {ESPERADO[k]}"
        ok &= len(lista) == ESPERADO[k]
        print(f"\n{k.upper()} ({len(lista)}) [{marca}]")
        print("  " + ", ".join(s for s, _ in lista))
    print("\nTotal:", sum(len(v) for v in dados.values()))
    return 0 if ok else 1


def health():
    porta = os.environ.get("PORT", "3000")
    token = os.environ.get("ACCESS_TOKEN", "")
    url = f"http://localhost:{porta}/health" + (f"?t={token}" if token else "")
    try:
        j = json.load(urllib.request.urlopen(url, timeout=8))
    except Exception as e:
        print("Servidor não respondeu:", e); return 1
    print(json.dumps(j, indent=2, ensure_ascii=False))
    ok = j.get("ok") and j.get("analisados") == j.get("assets") and j.get("acoesBRAnalisadas") == 21
    print("\nTUDO ANALISADO" if ok else "\nainda analisando (leva alguns minutos após ligar) ou há falha")
    return 0 if ok else 2


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    acoes = {
        "setup": setup,
        "start": lambda: (node_ok(), rodar(["node", "server.js"]))[1],
        "mock": lambda: (node_ok(), rodar(["node", "server.js"], {"MOCK": "1"}))[1],
        "test": lambda: (node_ok(), rodar(["node", "--test"]))[1],
        "health": health,
        "ativos": ativos,
        "tudo": lambda: setup() or rodar(["node", "--test"]),
    }
    if cmd not in acoes:
        print(__doc__); return 2 if cmd else 0
    return acoes[cmd]() or 0


if __name__ == "__main__":
    sys.exit(main())
