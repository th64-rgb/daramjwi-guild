@echo off
title 다람쥐구조대 오목 서버
cd /d "%~dp0"
echo 다람쥐구조대 오목 서버를 시작합니다...
echo 브라우저에서 http://localhost:3000 접속
if exist ".node\node.exe" (
  ".node\node.exe" server.js
) else (
  node server.js
)
pause