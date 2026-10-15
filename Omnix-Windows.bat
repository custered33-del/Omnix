@echo off
setlocal EnableDelayedExpansion
title Omnix
echo.
echo   Omnix - setting up and starting. This window must stay open while you use Omnix.
echo.

set "HERE=%USERPROFILE%\Omnix"
set "SETTINGS=%USERPROFILE%\omnix-settings.txt"

rem 1. The programs Omnix needs (installed once).
where git >nul 2>nul || (echo   Installing Git... & winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements & set RESTART=1)
where node >nul 2>nul || (echo   Installing Node.js... & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements & set RESTART=1)
where ffmpeg >nul 2>nul || (echo   Installing FFmpeg... & winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements & set RESTART=1)
where ngrok >nul 2>nul || (echo   Installing ngrok... & winget install -e --id Ngrok.Ngrok --accept-source-agreements --accept-package-agreements & set RESTART=1)
if defined RESTART (
  echo.
  echo   Programs installed. Close this window and double-click Omnix-Windows.bat again.
  pause
  exit /b
)

rem 2. Your ngrok details (asked once, then remembered).
if not exist "%SETTINGS%" (
  echo.
  set /p "TOKEN=  Paste your ngrok Authtoken and press Enter: "
  set /p "DOMAIN=  Paste your ngrok domain (like something.ngrok-free.app) and press Enter: "
  set "DOMAIN=!DOMAIN:https://=!"
  set "DOMAIN=!DOMAIN:/=!"
  (echo !DOMAIN!) > "%SETTINGS%"
  ngrok config add-authtoken !TOKEN!
)
set /p DOMAIN=<"%SETTINGS%"

rem 3. Download or update Omnix, then build it.
if not exist "%HERE%" (
  echo   Downloading Omnix...
  git clone -b claude/upbeat-goldberg-xde96g https://github.com/custered33-del/Omnix "%HERE%"
) else (
  git -C "%HERE%" pull --ff-only
)
cd /d "%HERE%"
echo   Preparing Omnix (the first time takes a few minutes)...
call corepack pnpm install
call corepack pnpm build

rem 4. Start the public link and Omnix.
start "Omnix link (keep open)" ngrok http --url=%DOMAIN% 4317
set "OMNIX_PUBLIC_URL=https://%DOMAIN%"
echo.
echo   =====================================================================
echo     Omnix:           https://%DOMAIN%
echo     Link for Claude: https://%DOMAIN%/mcp
echo   =====================================================================
echo.
call corepack pnpm start
pause
