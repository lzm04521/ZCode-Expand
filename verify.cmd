@echo off
rem ZCode-Expand portable entry: verify anchors and patch state (read-only).
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [error] node not found in PATH. Node.js 18+ is required.
  exit /b 1
)
node "%~dp0scripts\verify.mjs" %*
