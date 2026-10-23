@echo off
rem Try the screen without a PM5 (double-click).
cd /d "%~dp0"
python -m pip install --quiet hidapi
python pm5_usb.py --demo
pause
