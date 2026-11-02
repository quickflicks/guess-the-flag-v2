@echo off
cd /d "%~dp0"
echo Starting FlagQuest...
start "FlagQuest server" cmd /c "node server.js"
timeout /t 1 /nobreak >nul
start "" http://localhost:3000
