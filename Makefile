# Atalhos: make setup | start | mock | test | health | ativos | tudo
.PHONY: setup start mock test health ativos tudo
setup start mock test health ativos tudo:
	python3 atalhos/bolsai.py $@
