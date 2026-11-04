#!/usr/bin/env bash
# Atalho Linux/macOS: ./atalhos/bolsai.sh <setup|start|mock|test|health|ativos|tudo>
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 atalhos/bolsai.py "$@"
