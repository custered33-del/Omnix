import path from 'node:path';

/** Runtime configuration, from environment variables with local-first defaults. */
export interface OmnixConfig {
  port: number;
  host: string;
  /** Public base URL (used for OAuth metadata, connector URL and share links). */
  publicUrl: string;
  dataDir: string;
  /** postgres://... to use Postgres instead of the file store. */
  databaseUrl: string | null;
  /** S3-compatible blob storage (optional; local content-addressed storage otherwise). */
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean } | null;
  anthropicApiKey: string | null;
  /** Anthropic API base URL (ANTHROPIC_BASE_URL), for proxies and gateways. */
  anthropicBaseUrl: string;
  /**
   * Model for the built-in agent runner and natural-language commands. When unset, the newest
   * model the API key can use is looked up from the Models API at runtime.
   */
  agentModel: string | null;
  /**
   * Optional image generation provider for generative fill and extend: any server speaking the
   * OpenAI images edit API (OMNIX_IMAGE_GEN_URL, OMNIX_IMAGE_GEN_API_KEY, OMNIX_IMAGE_GEN_MODEL).
   * Without one, Omnix synthesizes fills from the surrounding image.
   */
  imageGen: { url: string; apiKey: string | null; model: string | null } | null;
  /** Directory with the built web app to serve (packages/web/dist). */
  webDist: string | null;
  /** Dev mode: relaxed cookies, verbose logs. */
  dev: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  /** Poppler's pdftoppm, used to import PDF pages as slides. */
  pdftoppmPath: string;
  /** LibreOffice, used to convert .ppt, .odp and .key files before importing them. */
  sofficePath: string;
  /** Maximum upload size in bytes. */
  maxUploadBytes: number;
  /** Allow anyone to sign up (otherwise only the first account, plus invites). */
  openSignup: boolean;
  /**
   * Folder of plugins installed on this machine (each a subfolder with omnix-plugin.json).
   * Plugins that run code (stdio MCP servers, local modules) can only be added here, by someone
   * with access to the server; HTTP MCP plugins can also be added in Settings by the owner.
   * Default: <dataDir>/plugins.
   */
  pluginsDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OmnixConfig {
  const port = Number(env.OMNIX_PORT ?? env.PORT ?? 4317);
  const host = env.OMNIX_HOST ?? '0.0.0.0';
  const publicUrl = (env.OMNIX_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
  const s3 =
    env.OMNIX_S3_BUCKET && env.OMNIX_S3_ACCESS_KEY_ID && env.OMNIX_S3_SECRET_ACCESS_KEY
      ? {
          endpoint: env.OMNIX_S3_ENDPOINT ?? `https://s3.${env.OMNIX_S3_REGION ?? 'us-east-1'}.amazonaws.com`,
          region: env.OMNIX_S3_REGION ?? 'us-east-1',
          bucket: env.OMNIX_S3_BUCKET,
          accessKeyId: env.OMNIX_S3_ACCESS_KEY_ID,
          secretAccessKey: env.OMNIX_S3_SECRET_ACCESS_KEY,
          forcePathStyle: env.OMNIX_S3_FORCE_PATH_STYLE !== 'false',
        }
      : null;
  const defaultDist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/dist');
  return {
    port,
    host,
    publicUrl,
    dataDir: path.resolve(env.OMNIX_DATA_DIR ?? '.omnix-data'),
    databaseUrl: env.OMNIX_DATABASE_URL ?? env.DATABASE_URL ?? null,
    s3,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, ''),
    imageGen: env.OMNIX_IMAGE_GEN_URL ? { url: env.OMNIX_IMAGE_GEN_URL.replace(/\/$/, ''), apiKey: env.OMNIX_IMAGE_GEN_API_KEY ?? null, model: env.OMNIX_IMAGE_GEN_MODEL ?? null } : null,
    agentModel: env.OMNIX_AGENT_MODEL ?? null,
    webDist: env.OMNIX_WEB_DIST ?? defaultDist,
    dev: env.NODE_ENV !== 'production',
    ffmpegPath: env.OMNIX_FFMPEG ?? 'ffmpeg',
    ffprobePath: env.OMNIX_FFPROBE ?? 'ffprobe',
    pdftoppmPath: env.OMNIX_PDFTOPPM ?? 'pdftoppm',
    sofficePath: env.OMNIX_SOFFICE ?? 'soffice',
    maxUploadBytes: Number(env.OMNIX_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
    openSignup: env.OMNIX_OPEN_SIGNUP === 'true',
    pluginsDir: env.OMNIX_PLUGINS_DIR ? path.resolve(env.OMNIX_PLUGINS_DIR) : null,
  };
}
