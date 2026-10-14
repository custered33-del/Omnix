/** Small fetch wrapper for the Omnix REST API. Errors carry the server's readable message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(path.startsWith('/') ? path : `/api/${path}`, { ...init, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError('Omnix server is unreachable. Check that it is running.', 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string' ? (data as { error: string }).error : null) ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, data && typeof data === 'object' ? (data as { details?: unknown }).details : undefined);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** Upload a file as a raw body; returns the asset record. */
export async function uploadFile(file: File | Blob, options: { name?: string; projectId?: string; tags?: string[]; onProgress?: (f: number) => void } = {}): Promise<{ asset: AssetSummary; deduplicated: boolean }> {
  const name = options.name ?? (file instanceof File ? file.name : 'upload');
  const params = new URLSearchParams({ name });
  if (options.projectId) params.set('projectId', options.projectId);
  if (options.tags?.length) params.set('tags', options.tags.join(','));
  // XHR for upload progress (fetch has no upload progress events).
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/assets?${params}`);
    xhr.withCredentials = true;
    if (file.type) xhr.setRequestHeader('content-type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: string } & Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else reject(new ApiError(data.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed: the server is unreachable', 0));
    xhr.send(file);
  });
}

export interface AssetSummary {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'lut' | 'font' | 'text' | 'data' | 'other';
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  hasAudio?: boolean;
  colorProfile?: string;
  tags: string[];
  createdAt: string;
  proxyStatus?: 'none' | 'pending' | 'ready' | 'failed';
  hasThumbnail?: boolean;
  waveform?: number[];
  projectIds?: string[];
}

export const assetUrl = (id: string) => `/api/assets/${id}/file`;
export const thumbUrl = (id: string) => `/api/assets/${id}/thumbnail`;
export const proxyUrl = (id: string) => `/api/assets/${id}/proxy`;
/** One decoded video frame as JPEG (for browsers without the video codec). */
export const frameUrl = (id: string, t: number, w = 960) => `/api/assets/${id}/frame?t=${t.toFixed(3)}&w=${w}`;
/** MP3 audio track (for browsers without the original audio codec). */
export const audioUrl = (id: string) => `/api/assets/${id}/audio`;
