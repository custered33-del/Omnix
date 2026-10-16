@echo off
rem Called by Omnix-PC.bat after it has updated Omnix. Lives in the repository, so changes here
rem reach the PC with the next update and the Desktop file never needs downloading again.
cd /d "%~dp0.."

rem Code Grounds keeps code away from your files with Node.js 22.13 or newer. On an older Node.js,
rem Omnix still runs: only you use it on this PC, so code runs without that extra wall.
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || set "OMNIX_SANDBOX_ISOLATION=best-effort"

echo   Preparing Omnix (the first time takes a few minutes)...
set "ONNXRUNTIME_NODE_INSTALL=skip"
call npx --yes pnpm@10.28.0 install
call npx --yes pnpm@10.28.0 build

rem Connect Claude Desktop to Omnix (adds Omnix to its settings, keeps everything else).
node -e "const fs=require('fs'),p=require('path');const dirs=[p.join(process.env.APPDATA,'Claude')];const pk=p.join(process.env.LOCALAPPDATA||'','Packages');try{for(const d of fs.readdirSync(pk))if(/^(AnthropicPBC\.)?Claude/i.test(d))dirs.push(p.join(pk,d,'LocalCache','Roaming','Claude'))}catch{};const entry={command:process.execPath,args:[p.join(process.cwd(),'node_modules','tsx','dist','cli.mjs'),p.join(process.cwd(),'packages','server','src','mcp','stdio.ts')],env:{OMNIX_URL:'http://localhost:4317',OMNIX_DATA_DIR:p.join(process.cwd(),'.omnix-data')}};for(const d of dirs){fs.mkdirSync(d,{recursive:true});const f=p.join(d,'claude_desktop_config.json');let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{};c.mcpServers=c.mcpServers||{};c.mcpServers.omnix=entry;fs.writeFileSync(f,JSON.stringify(c,null,2))}console.log('  Claude Desktop is connected to Omnix.')"

start "" http://localhost:4317
rem With cloudflared, Omnix also gets a public address for ChatGPT, Claude chat on the web and phones.
where cloudflared >nul 2>nul && (
  node scripts\share.mjs
) || (
  node node_modules\tsx\dist\cli.mjs packages\server\src\main.ts
)
