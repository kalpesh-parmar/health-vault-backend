@echo off
REM Dev startup helper for ai-service (Windows / cmd)
REM Always uses the project venv so global Python cannot shadow installed packages.
setlocal
set "AI_SERVICE_ROOT=%~dp0\.."
pushd "%AI_SERVICE_ROOT%\.."

if not exist "%AI_SERVICE_ROOT%\venv\Scripts\python.exe" (
    echo venv not found. Creating with system Python 3.11...
    py -3.11 -m venv "%AI_SERVICE_ROOT%\venv"
)

"%AI_SERVICE_ROOT%\venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r "%AI_SERVICE_ROOT%\requirements.txt"
"%AI_SERVICE_ROOT%\venv\Scripts\python.exe" -m uvicorn --app-dir "%CD%\ai-service" app.main:app --host localhost --port 8000 %*

popd
endlocal
