@echo off
rem Atalho Windows (duplo clique ou cmd): atalhos\bolsai.bat <setup|start|mock|test|health|ativos|tudo>
cd /d "%~dp0.."
where py >nul 2>nul && (py atalhos\bolsai.py %*) || (python atalhos\bolsai.py %*)
