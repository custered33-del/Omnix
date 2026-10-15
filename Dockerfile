FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
ENV OMNIX_DATA_DIR=/tmp/omnix OMNIX_HOST=0.0.0.0 NODE_ENV=production NODE_OPTIONS=--max-old-space-size=400
EXPOSE 4317
CMD ["pnpm", "start"]
