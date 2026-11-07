@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  Affinity Mapping Studio Server  起動スクリプト  (簡素 goto/label 版 2026-06-03)
rem
rem  この 1 つのウィンドウで以下を実行:
rem   - 管理画面をブラウザで開く
rem   - preset が cloudflare-quick なら，サーバーの起動後に管理 API で Quick Tunnel を張る
rem     (scripts\auto-tunnel.mjs．2026-11-07 から．以前は cloudflared を直接起動していたが，
rem      そのトンネルは管理画面が知らず，招待 URL のボタンや「停止」と食い違った)
rem   - Affinity Mapping Studio Server を foreground で実行
rem
rem  停止: このウィンドウを閉じる
rem ============================================================

set "PORT=1234"
set "KJ_ADMIN_PORT=1235"
set "KJ_ADMIN_BIND_HOST=127.0.0.1"

cd /d "%~dp0"

if not exist "config" mkdir "config"
if not exist "config\admin-token.txt" goto :gen_token
goto :read_token

:gen_token
echo [setup] 管理トークン生成中...
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\gen-admin-token.ps1"
if errorlevel 1 goto :err_token_gen

:read_token
set /p KJ_ADMIN_TOKEN=<"config\admin-token.txt"
if "!KJ_ADMIN_TOKEN!"=="" goto :err_token_empty

where node >nul 2>nul
if errorlevel 1 goto :err_no_node

if not exist "node_modules" goto :do_install
goto :check_port

:do_install
echo [setup] 初回起動: npm install を実行中...
call npm install
if errorlevel 1 goto :err_install

:check_port
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -EA SilentlyContinue) { exit 7 } else { exit 0 }" >nul 2>nul
if !errorlevel! equ 7 goto :err_port_in_use


:open_admin
rem R6 (2026-06-09): fragment #_t= で token 自動注入．server に送信されない．
start "" "http://%KJ_ADMIN_BIND_HOST%:%KJ_ADMIN_PORT%/admin#_t=!KJ_ADMIN_TOKEN!"

echo.
echo ============================================================
echo   管理トークン (config\admin-token.txt):
echo     !KJ_ADMIN_TOKEN!
echo.
echo   管理画面 (localhost) : http://%KJ_ADMIN_BIND_HOST%:%KJ_ADMIN_PORT%/admin#_t=^<token^>
echo   LAN 接続 URL         : ws://(このPCのIP):%PORT%
echo   Cloudflare           : preset が cloudflare-quick なら，起動後にこのウィンドウに URL が出ます

echo ============================================================
echo.
echo  サーバーをこのウィンドウで実行します．
echo  停止するにはこのウィンドウを閉じてください．
echo.

rem 背後でサーバーの起動を待ち，管理 API で Quick Tunnel を張る (preset が cloudflare-quick のときだけ)
start "" /B node scripts\auto-tunnel.mjs

node src\index.js

echo.
echo [info] サーバーが終了しました．
pause
goto :eof

rem ============================================================
rem  エラーラベル
rem ============================================================
:err_token_gen
echo [ERROR] 管理トークン生成に失敗しました
pause
exit /b 1

:err_token_empty
echo [ERROR] 管理トークンが空です．config\admin-token.txt を削除して再実行してください
pause
exit /b 1

:err_no_node
echo [ERROR] Node.js が見つかりません． https://nodejs.org からインストールしてください
pause
exit /b 1

:err_install
echo [ERROR] npm install 失敗
pause
exit /b 1

:err_port_in_use
echo [ERROR] port %PORT% は既に使用中です．
echo         既存 node プロセスを止めるには PowerShell で次を実行:
echo           Get-Process node -EA SilentlyContinue ^| Stop-Process -Force
pause
exit /b 1

endlocal
