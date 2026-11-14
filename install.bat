@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Javelin setup failed. Read the error above, fix it, and run install.bat again.
  pause
  exit /b 1
)
echo.
pause
