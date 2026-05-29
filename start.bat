@echo off
chcp 65001 > nul
echo ====================================
echo   🎙️ 小伟播客 - 一键启动
echo ====================================
echo.
echo 正在检查 Node.js 环境...

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ 未检测到 Node.js
    pause
    exit /b
)

echo ✓ Node.js 已检测到
echo 正在安装依赖...

call npm install --silent

echo ✓ 依赖安装完成
echo.
node server.js

pause
