@echo off
chcp 65001 > nul
title 小伟播客 + 运营系统 - 带守护启动
cd /d "D:\xiaowei-podcast"

echo ====================================
echo   🎙️ 小伟播客 + 运营系统 - 带守护启动
echo ====================================
echo.

REM 检查端口3000是否已被占用
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %ERRORLEVEL% EQU 0 (
    echo ⚠️  端口3000已被占用（前端可能已在运行）
) else (
    echo 正在后台启动前端服务器 + 守护进程(3000)...
    start /MIN /B "" "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" "D:\xiaowei-podcast\watchdog.js"
)

REM 检查端口4000是否已被占用
netstat -ano | findstr ":4000" | findstr "LISTENING" >nul
if %ERRORLEVEL% EQU 0 (
    echo ⚠️  端口4000已被占用（运营系统可能已在运行）
) else (
    echo 正在后台启动运营系统 + 守护进程(4000)...
    start /MIN /B "" "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe" "D:\xiaowei-podcast\ops-watchdog.js"
)

echo.
echo ✓ 已启动（两个守护进程各每30秒自动检测一次）
echo.
echo 📎 前台地址:    http://localhost:3000
echo 🛠️  运营系统:    http://localhost:4000/ops/login
echo.
echo 💡 任一进程挂掉都会自动重启
echo.
start "" "http://localhost:3000"
pause
