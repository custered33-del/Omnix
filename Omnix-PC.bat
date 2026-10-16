@echo off
title Omnix
echo.
echo   Omnix - updating and starting. Keep this window open while you use Omnix.
echo.
set "HERE=%USERPROFILE%\Omnix"

rem Programs Omnix needs (installed once). cloudflared gives Omnix a free public address.
where git >nul 2>nul || (echo   Installing Git... & winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements & set RESTART=1)
where node >nul 2>nul || (echo   Installing Node.js... & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements & set RESTART=1)
where ffmpeg >nul 2>nul || (echo   Installing FFmpeg... & winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements & set RESTART=1)
rem Optional: if it cannot be installed, Omnix still runs on this PC.
where cloudflared >nul 2>nul || (echo   Installing cloudflared... & winget install -e --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements)
if defined RESTART (
  echo.
  echo   Programs installed. Close this window and double-click Omnix-PC.bat again.
  pause
  exit /b
)

rem Download or update Omnix, then run its own start script.
if not exist "%HERE%" (
  echo   Downloading Omnix...
  git clone -b claude/upbeat-goldberg-xde96g https://github.com/custered33-del/Omnix "%HERE%"
) else (
  git -C "%HERE%" pull --ff-only
)
call "%HERE%\scripts\windows-start.cmd"
pause
