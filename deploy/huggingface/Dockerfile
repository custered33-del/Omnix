# Omnix on a free Hugging Face Space (Docker). Data lives in Supabase (database and file storage),
# set as Space secrets; see docs/FREE_HOSTING.md.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN git clone --depth 1 -b claude/upbeat-goldberg-xde96g https://github.com/custered33-del/Omnix /app
WORKDIR /app
RUN pnpm install --frozen-lockfile && pnpm build && chmod -R a+rX /app
ENV OMNIX_PORT=7860 OMNIX_DATA_DIR=/tmp/omnix NODE_ENV=production
EXPOSE 7860
CMD ["/app/node_modules/.bin/tsx", "packages/server/src/main.ts"]
