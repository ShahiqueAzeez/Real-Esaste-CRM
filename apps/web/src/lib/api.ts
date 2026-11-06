/** Same-origin API client. Sends the CSRF double-submit token on every write. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: string; message?: string }[]) if (d.path) out[d.path] = d.message ?? 'Invalid value';
    }
    return out;
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(/(?:^|;\s*)crm_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : '';
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } })?.error;
    throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? 'Request failed', e?.details, e?.requestId);
  }
  return data as T;
}

export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown; query?: Query; headers?: Record<string, string> } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/api${withQuery(path, init.query)}`, {
    method,
    credentials: 'include',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return handle<T>(res);
}

export const api = {
  get: <T>(path: string, query?: Query) => apiFetch<T>(path, { query }),
  post: <T>(path: string, body: unknown = {}, headers?: Record<string, string>) => apiFetch<T>(path, { method: 'POST', body, headers }),
  put: <T>(path: string, body: unknown = {}) => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body: unknown = {}) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  async upload<T>(path: string, file: File, field = 'file'): Promise<T> {
    const form = new FormData();
    form.append(field, file);
    const res = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', headers: { 'x-csrf-token': csrfToken() }, body: form });
    return handle<T>(res);
  },
  /** Download a file response (CSV exports) through the authenticated session. */
  async download(path: string, query?: Query, fallbackName = 'export.csv'): Promise<void> {
    const res = await fetch(`/api${withQuery(path, query)}`, { credentials: 'include' });
    if (!res.ok) await handle(res);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
