@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando, aguarde...
  call npm install
)
call npm run dev -- --port 3000 --open
pause
