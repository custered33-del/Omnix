import type { OmnixConfig } from '../config.js';

/**
 * A small client for the Anthropic Messages API, used by the built-in agent runner and by
 * natural-language commands when ANTHROPIC_API_KEY is set. Plain fetch keeps it easy to point at a
 * gateway (ANTHROPIC_BASE_URL) or a fake server in tests.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[]; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessagesRequest {
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];
  max_tokens?: number;
  /** Overrides the resolved model for one request. */
  model?: string;
}

export interface MessagesResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal' | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AnthropicError';
  }
}

export class AnthropicClient {
  private resolved: Promise<string> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly preferredModel: string | null = null,
  ) {}

  static fromConfig(config: OmnixConfig): AnthropicClient | null {
    return config.anthropicApiKey ? new AnthropicClient(config.anthropicApiKey, config.anthropicBaseUrl, config.agentModel) : null;
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  }

  /**
   * The model to use: OMNIX_AGENT_MODEL when set, otherwise the newest model this key can use
   * (the Models API lists newest first), looked up once.
   */
  model(): Promise<string> {
    if (this.preferredModel) return Promise.resolve(this.preferredModel);
    if (!this.resolved) {
      this.resolved = (async () => {
        const res = await fetch(`${this.baseUrl}/v1/models?limit=20`, { headers: this.headers() });
        if (!res.ok) throw new AnthropicError(`Could not list models (${res.status}). Set OMNIX_AGENT_MODEL to choose one.`, res.status);
        const body = (await res.json()) as { data?: { id: string }[] };
        const id = body.data?.[0]?.id;
        if (!id) throw new AnthropicError('No models are available for this API key. Set OMNIX_AGENT_MODEL to choose one.', 404);
        return id;
      })();
      this.resolved.catch(() => {
        this.resolved = null;
      });
    }
    return this.resolved;
  }

  async messages(req: MessagesRequest, signal?: AbortSignal): Promise<MessagesResponse> {
    const model = req.model ?? (await this.model());
    const body = { model, max_tokens: req.max_tokens ?? 4096, ...(req.system ? { system: req.system } : {}), messages: req.messages, ...(req.tools?.length ? { tools: req.tools } : {}) };
    let last: AnthropicError | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${this.baseUrl}/v1/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      if (res.ok) return (await res.json()) as MessagesResponse;
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // not JSON
      }
      last = new AnthropicError(`Claude API error ${res.status}: ${message.slice(0, 300)}`, res.status);
      // Retry rate limits and overloads with backoff; everything else is final.
      if (res.status !== 429 && res.status !== 529 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      if (signal?.aborted) break;
    }
    throw last!;
  }
}

export function anthropicOf(services: { config: OmnixConfig; ext: Record<string, unknown> }): AnthropicClient | null {
  if (services.ext.anthropic === undefined) services.ext.anthropic = AnthropicClient.fromConfig(services.config);
  return services.ext.anthropic as AnthropicClient | null;
}

/** Text of the assistant's reply (tool calls left out). */
export function replyText(r: MessagesResponse): string {
  return r.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
