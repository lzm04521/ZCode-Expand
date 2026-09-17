@echo off
rem ZCode-Expand portable entry: apply patches to the installed ZCode.
rem Prerequisite: ZCode fully exited (including tray icon).
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [error] node not found in PATH. Node.js 18+ is required.
  exit /b 1
)
node "%~dp0scripts\apply.mjs" %*
