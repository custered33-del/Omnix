@echo off
title Omnix
echo.
echo   Omnix - setting up and starting. Keep this window open while you use Omnix.
echo.
set "HERE=%USERPROFILE%\Omnix"

rem 1. Programs Omnix needs (installed once).
where git >nul 2>nul || (echo   Installing Git... & winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements & set RESTART=1)
where node >nul 2>nul || (echo   Installing Node.js... & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements & set RESTART=1)
where ffmpeg >nul 2>nul || (echo   Installing FFmpeg... & winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements & set RESTART=1)
rem Node.js 22.13 or newer is needed (older versions have a broken package tool).
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || (echo   Updating Node.js... & winget upgrade -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements & set RESTART=1)
if defined RESTART (
  echo.
  echo   Programs installed. Close this window and double-click Omnix-PC.bat again.
  pause
  exit /b
)

rem 2. Download or update Omnix, then build it.
if not exist "%HERE%" (
  echo   Downloading Omnix...
  git clone -b claude/upbeat-goldberg-xde96g https://github.com/custered33-del/Omnix "%HERE%"
) else (
  git -C "%HERE%" pull --ff-only
)
cd /d "%HERE%"
echo   Preparing Omnix (the first time takes a few minutes)...
call npx --yes pnpm@10.28.0 install
call npx --yes pnpm@10.28.0 build

rem 3. Connect Claude Desktop to Omnix (adds Omnix to its settings, keeps everything else).
node -e "const fs=require('fs'),p=require('path');const d=p.join(process.env.APPDATA,'Claude');fs.mkdirSync(d,{recursive:true});const f=p.join(d,'claude_desktop_config.json');let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{};c.mcpServers=c.mcpServers||{};c.mcpServers.omnix={command:'cmd',args:['/c','npx','--yes','pnpm@10.28.0','--dir',process.cwd(),'mcp:stdio'],env:{OMNIX_URL:'http://localhost:4317'}};fs.writeFileSync(f,JSON.stringify(c,null,2));console.log('  Claude Desktop is connected to Omnix (restart Claude Desktop once).')"

rem 4. Start Omnix and open it.
start "" http://localhost:4317
call npx --yes pnpm@10.28.0 start
pause
