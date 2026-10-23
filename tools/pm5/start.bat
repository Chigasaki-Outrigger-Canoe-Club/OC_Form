@echo off
rem Start PM5 recording (double-click). Installs hidapi the first time.
rem Find Python: the "py" launcher, or the usual install folder (works even when Python is not on PATH)
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py
if not defined PY for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do set PY="%%d\python.exe"
if not defined PY (
  echo Python not found. Install it from https://www.python.org/downloads/
  pause
  exit /b
)
%PY% -m pip install --quiet hidapi
%PY% pm5_usb.py
pause
