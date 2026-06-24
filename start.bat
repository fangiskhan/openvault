@echo off
setlocal
title OpenVault

REM ===========================================================
REM  OpenVault launcher - just double-click this file.
REM  It starts the dev server and opens http://localhost:6900
REM  Leave the window open while you use it. Close it to stop.
REM ===========================================================

cd /d "%~dp0"

REM --- Make sure Node.js is available ---
where node >nul 2>nul
if errorlevel 1 (
  echo [OpenVault] Node.js was not found.
  echo Install it from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

REM --- First run only: install dependencies if they're missing ---
if not exist "node_modules" (
  echo [OpenVault] First run - installing dependencies. This can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo [OpenVault] Dependency install failed - see the error above.
    pause
    exit /b 1
  )
)

REM --- Register the OpenVault MCP server with Claude Code (skips if already added) ---
where claude >nul 2>nul
if not errorlevel 1 (
  claude mcp list 2>nul | findstr /i "openvault" >nul
  if errorlevel 1 (
    echo [OpenVault] Registering OpenVault MCP server with Claude Code...
    call claude mcp add openvault http://localhost:6900/api/mcp --transport http --scope user
  )
)

REM --- Open the browser a few seconds after the server starts ---
start "" /min cmd /c "timeout /t 6 >nul & start http://localhost:6900"

echo.
echo [OpenVault] Starting at http://localhost:6900
echo [OpenVault] Keep this window open. Press Ctrl+C or close it to stop.
echo.

call npm run dev

REM --- If the server exits, keep the window open so errors stay readable ---
echo.
echo [OpenVault] Server stopped.
pause
