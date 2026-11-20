import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, get, newKey } from './api';

/** Carrega dados de uma rota GET, com estados de carregamento/erro e recarga. */
export function useApi<T = any>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) { setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    get<T>(url, ctl.signal)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { if (e?.name !== 'AbortError') { setError(e); setLoading(false); } });
    return () => ctl.abort();
  }, [url, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/**
 * Envio de mutações: bloqueia duplo envio, reutiliza a mesma Idempotency-Key em novas tentativas
 * após falha de rede (evita duplicidade) e gera uma nova chave após sucesso ou erro de negócio.
 */
export function useSubmit<T = any>() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const keyRef = useRef<string | null>(null);
  const inflight = useRef(false);
  const run = useCallback(async (method: string, url: string, body?: unknown, opts: { idempotent?: boolean } = {}): Promise<T | null> => {
    if (inflight.current) return null;
    inflight.current = true;
    setBusy(true);
    setError(null);
    if (opts.idempotent && !keyRef.current) keyRef.current = newKey();
    try {
      const r = await api<T>(method, url, body, { idempotencyKey: opts.idempotent ? keyRef.current! : undefined });
      keyRef.current = null;
      return r;
    } catch (e: any) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'UNKNOWN', 'Erro inesperado.');
      if (!err.isNetwork) keyRef.current = null;
      setError(err);
      return null;
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

export function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

/**
 * Dados que se atualizam sozinhos (regra comum dos ajustes do RT, 20/11/2026): recarrega em segundo plano a cada
 * `intervalMs` enquanto a tela está visível, ao voltar para o app, recuperar o foco ou reconectar. Não pisca a tela:
 * só troca os dados quando mudaram. Respostas de uma tela/conta anterior são descartadas (troca de URL aborta).
 */
export function useLiveApi<T = any>(url: string | null, intervalMs = 3000) {
  const base = useApi<T>(url);
  const { setData } = base;
  const last = useRef<string>('');
  const inflight = useRef(false);
  const [offline, setOffline] = useState(false);
  useEffect(() => { last.current = ''; }, [url]);
  useEffect(() => {
    if (!url) return;
    let ctl: AbortController | null = null;
    let stopped = false;
    const refresh = async () => {
      if (stopped || inflight.current || document.visibilityState !== 'visible') return;
      inflight.current = true;
      ctl = new AbortController();
      try {
        const d = await get<T>(url, ctl.signal);
        if (stopped) return;
        setOffline(false);
        const s = JSON.stringify(d);
        if (s !== last.current) { last.current = s; setData(d); }
      } catch (e: any) {
        if (e?.name !== 'AbortError' && (e?.isNetwork || !navigator.onLine)) setOffline(true);
      } finally { inflight.current = false; }
    };
    const t = window.setInterval(refresh, intervalMs);
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    const off = () => setOffline(true);
    window.addEventListener('offline', off);
    return () => {
      stopped = true; ctl?.abort(); window.clearInterval(t);
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake); window.removeEventListener('offline', off);
    };
  }, [url, intervalMs, setData]);
  return { ...base, offline };
}
