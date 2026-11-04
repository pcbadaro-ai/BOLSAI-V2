# Atalho Windows (PowerShell): .\atalhos\bolsai.ps1 <setup|start|mock|test|health|ativos|tudo>
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$py = if (Get-Command py -ErrorAction SilentlyContinue) { "py" } else { "python" }
& $py atalhos\bolsai.py @args
exit $LASTEXITCODE
