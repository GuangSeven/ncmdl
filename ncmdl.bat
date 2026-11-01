@echo off
setlocal
title ncmdl
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18 or newer: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node src/cli.js %*
set "EXIT_CODE=%errorlevel%"

echo.
if not "%EXIT_CODE%"=="0" echo Exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
