@echo off
rem wenmai agent launcher (ASCII only, CRLF required)
cd /d "%~dp0"
setlocal
set "NODE_EXE=%~dp0runtime\node\node.exe"
if exist "%NODE_EXE%" goto run
where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_EXE=node"
  goto run
)
echo [ERROR] Node.js not found.
echo Please install Node.js LTS from https://nodejs.org then run this again.
pause
exit /b 1
:run
"%NODE_EXE%" launch.mjs
pause
