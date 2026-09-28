/** Cliente HTTP: sessão por cookie httpOnly, token CSRF em memória, chaves de idempotência. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any, public correlationId?: string) {
    super(message);
  }
  get isNetwork() { return this.status === 0; }
}

let csrfToken = '';
export const setCsrf = (t: string) => { csrfToken = t; };

export const newKey = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, '');

type Opts = { idempotencyKey?: string; signal?: AbortSignal };

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export async function api<T = any>(method: string, url: string, body?: unknown, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, {
      method, headers, credentials: 'same-origin', signal: opts.signal,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor. Verifique sua internet e tente novamente. Nada foi confirmado.');
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.ok && data === null && text && !(res.headers.get('content-type') ?? '').includes('json')) {
    throw new ApiError(503, 'API_UNAVAILABLE', 'A API da ONEMA SAÚDE não está disponível neste endereço.');
  }
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 401 && onUnauthorized && !url.startsWith('/api/auth/')) onUnauthorized();
    const fallback = [502, 503, 504].includes(res.status)
      ? 'O servidor está indisponível ou demorou para responder. Aguarde alguns segundos e tente novamente.'
      : 'Não foi possível concluir a operação.';
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? fallback, err?.details, err?.correlationId);
  }
  return data as T;
}

export const get = <T = any>(url: string, signal?: AbortSignal) => api<T>('GET', url, undefined, { signal });
