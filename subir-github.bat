@echo off
cd /d "%~dp0"
where git >nul 2>nul || (echo Instale o Git em https://git-scm.com/download/win e rode de novo. & pause & exit /b 1)
if not exist .git git init
rem Remove arquivos antigos do Firebase
del /q .firebaserc firebase-config.js firebase.json firestore.indexes.json firestore.rules 2>nul
rem Tira node_modules do Git (fica so no computador)
git rm -r -q --cached node_modules 2>nul
git add -A
git commit -m "Atualiza para Supabase e remove node_modules e arquivos do Firebase" 2>nul
git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/marcos652/Contas-Ana-Paula.git
echo.
echo Se abrir uma janela do navegador, entre na sua conta do GitHub e autorize.
git push -u origin main
echo.
echo Pronto. Confira em https://github.com/marcos652/Contas-Ana-Paula
pause
