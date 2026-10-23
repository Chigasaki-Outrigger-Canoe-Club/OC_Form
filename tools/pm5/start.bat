@echo off
rem Start PM5 recording (double-click). Installs hidapi the first time.
cd /d "%~dp0"
python -m pip install --quiet hidapi
python pm5_usb.py
pause
