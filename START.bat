@echo off
title AudioExtractor — Setup & Launch
color 0A
cls

echo.
echo  ============================================
echo    AudioExtractor - AI Stem Separator
echo  ============================================
echo.

:: ── Check for Python ──────────────────────────────────────────────────────────
echo  [1/4] Checking for Python...
set PYTHON_CMD=

:: Try common locations (Python 3.13 first)
for %%P in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "C:\Python310\python.exe"
    "C:\Python39\python.exe"
    "C:\Program Files\Python313\python.exe"
    "C:\Program Files\Python312\python.exe"
    "C:\Program Files\Python311\python.exe"
    "C:\Program Files\Python310\python.exe"
) do (
    if exist %%~P (
        set PYTHON_CMD=%%~P
        goto :found_python
    )
)

:: Try PATH (skip MS Store stubs)
for /f "delims=" %%i in ('where python 2^>nul') do (
    "%%i" -c "import sys; exit(0 if sys.version_info>=(3,9) else 1)" 2>nul
    if not errorlevel 1 (
        set PYTHON_CMD=%%i
        goto :found_python
    )
)

:: ── Python not found — install via winget ────────────────────────────────────
echo  Python not found. Installing Python 3.13 via winget...
echo  (This may take a few minutes)
echo.
winget install --id Python.Python.3.13 --silent --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo.
    echo  ERROR: winget install failed.
    echo  Please install Python 3.13+ manually from https://python.org
    echo  Then re-run this script.
    pause
    exit /b 1
)

set PATH=%LOCALAPPDATA%\Programs\Python\Python313;%LOCALAPPDATA%\Programs\Python\Python313\Scripts;%PATH%

if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" (
    set PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python313\python.exe
    goto :found_python
)

echo  Python installed but could not locate executable.
echo  Please close this window, then re-run START.bat
pause
exit /b 1

:found_python
echo  Found Python: %PYTHON_CMD%

:: ── Upgrade pip ───────────────────────────────────────────────────────────────
echo.
echo  [2/4] Upgrading pip...
"%PYTHON_CMD%" -m pip install --upgrade pip --quiet

:: ── Install dependencies ──────────────────────────────────────────────────────
echo.
echo  [3/4] Installing dependencies...
echo  Please wait — PyTorch download may take a few minutes on first run...
echo.
"%PYTHON_CMD%" -m pip install flask demucs torch torchaudio pydub werkzeug

if errorlevel 1 (
    echo.
    echo  ERROR: Failed to install dependencies.
    echo  Try running this script as Administrator.
    pause
    exit /b 1
)

:: ── Launch Flask app ──────────────────────────────────────────────────────────
echo.
echo  [4/4] Starting AudioExtractor...
echo.
echo  ============================================
echo    Open your browser at: http://localhost:5000
echo  ============================================
echo.

start "" "http://localhost:5000"
"%PYTHON_CMD%" app.py

pause
