@echo off
rem Install, update and start OpenIllusion: double-click it, or run it in a terminal.
rem Options: --update (git pull first), --no-open, --port 7871. See scripts\launch.py.
setlocal
cd /d "%~dp0"
set "PY="
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY (where py >nul 2>nul && set "PY=py -3")
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY (
  echo [OpenIllusion] Python 3.10 or newer is needed: https://www.python.org/downloads/
  echo [OpenIllusion] or run: winget install Python.Python.3.12
  echo [OpenIllusion] Then open a new window and run start.bat again.
  pause
  exit /b 1
)
%PY% scripts\launch.py %*
if errorlevel 1 pause
