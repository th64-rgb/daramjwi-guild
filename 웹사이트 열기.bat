@echo off
chcp 65001 >nul
title 다람쥐구조대 오목
cd /d "%~dp0"

echo.
echo  ========================================
echo    다람쥐구조대 오목 웹사이트 시작
echo  ========================================
echo.

:: 서버가 이미 켜져 있는지 확인
powershell -Command "try { (Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 2).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
    echo  서버가 이미 실행 중입니다.
    goto OPEN
)

echo  서버를 시작합니다... (이 창을 닫지 마세요!)
if exist ".node\node.exe" (
    start "" /B ".node\node.exe" server.js
) else (
    start "" /B node server.js
)

:: 서버 준비될 때까지 대기
echo  준비 중...
timeout /t 2 /nobreak >nul
:WAIT
powershell -Command "try { (Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 2).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 1 /nobreak >nul
    goto WAIT
)

:OPEN
echo  브라우저를 엽니다...
start "" "http://localhost:3000"
echo.
echo  접속 주소: http://localhost:3000
echo  종료하려면 이 창을 닫으세요.
echo.
pause