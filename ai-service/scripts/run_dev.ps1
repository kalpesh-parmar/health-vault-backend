# Dev startup helper for ai-service (Windows / PowerShell)
# Always uses the project venv so global Python (3.13/3.14) cannot shadow installed packages.
$ErrorActionPreference = "Stop"

$aiServiceRoot = Split-Path -Parent $PSScriptRoot
Set-Location $aiServiceRoot

$venvPython = Join-Path $aiServiceRoot "venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "venv not found at $venvPython. Creating with system Python 3.11..." -ForegroundColor Yellow
    py -3.11 -m venv (Join-Path $aiServiceRoot "venv")
}

& $venvPython -m pip install --disable-pip-version-check -q -r (Join-Path $aiServiceRoot "requirements.txt")
& $venvPython -m uvicorn app.main:app --host localhost --port 8000 @args
