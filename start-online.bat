@echo off
chcp 65001 > nul
title 小伟播客 + 公网隧道

echo ====================================
echo   🎙️ 小伟播客 - 公网启动
echo ====================================
echo.
echo   ⚠️  ngrok 隧道与你另一个项目冲突
echo   改用 localtunnel 方案
echo ====================================
echo.

cd /d %~dp0

echo [1/2] 检查并启动播客服务器...

taskkill /F /FI "WINDOWTITLE eq node*server*" 2>nul
taskkill /F /FI "WINDOWTITLE eq cmd*tunnel*" 2>nul

start /B node server.js > podcast.log 2>&1
ping -n 4 127.0.0.1 > nul

echo [2/2] 启动公网隧道...
echo.
echo 正在获取地址，请稍候...
echo.

npx localtunnel --port 3000

pause
