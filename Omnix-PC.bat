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
rem Code Grounds keeps code away from your files with Node.js 22.13 or newer. On an older Node.js,
rem Omnix still runs: only you use it on this PC, so code runs without that extra wall.
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || set "OMNIX_SANDBOX_ISOLATION=best-effort"
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
node -e "const fs=require('fs'),p=require('path');const dirs=[p.join(process.env.APPDATA,'Claude')];const pk=p.join(process.env.LOCALAPPDATA||'','Packages');try{for(const d of fs.readdirSync(pk))if(/^(AnthropicPBC\.)?Claude/i.test(d))dirs.push(p.join(pk,d,'LocalCache','Roaming','Claude'))}catch{};const entry={command:process.execPath,args:[p.join(process.cwd(),'node_modules','tsx','dist','cli.mjs'),p.join(process.cwd(),'packages','server','src','mcp','stdio.ts')],env:{OMNIX_URL:'http://localhost:4317',OMNIX_DATA_DIR:p.join(process.cwd(),'.omnix-data')}};for(const d of dirs){fs.mkdirSync(d,{recursive:true});const f=p.join(d,'claude_desktop_config.json');let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{};c.mcpServers=c.mcpServers||{};c.mcpServers.omnix=entry;fs.writeFileSync(f,JSON.stringify(c,null,2))}console.log('  Claude Desktop is connected to Omnix. Quit Claude Desktop fully and open it again.')"

rem 4. Start Omnix and open it.
start "" http://localhost:4317
call npx --yes pnpm@10.28.0 start
pause
