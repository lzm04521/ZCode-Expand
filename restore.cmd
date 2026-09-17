@echo off
rem ZCode-Expand portable entry: restore pristine app.asar (auto-capture on first run).
rem Prerequisite: ZCode fully exited (including tray icon).
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [error] node not found in PATH. Node.js 18+ is required.
  exit /b 1
)
node "%~dp0scripts\restore.mjs" %*
