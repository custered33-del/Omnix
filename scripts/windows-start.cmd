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

rem Connect the AI apps on this PC (Claude Desktop, Codex) to Omnix; their other settings are kept.
node scripts\connect-local-apps.mjs

start "" http://localhost:4317
rem With cloudflared, Omnix also gets a public address for ChatGPT, Claude chat on the web and phones.
where cloudflared >nul 2>nul && (
  node scripts\share.mjs
) || (
  node node_modules\tsx\dist\cli.mjs packages\server\src\main.ts
)
