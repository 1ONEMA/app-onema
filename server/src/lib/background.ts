/**
 * Trabalho em segundo plano depois da resposta HTTP.
 * Na Netlify, a Function só continua viva se a tarefa for registrada em `context.waitUntil`
 * (repassado por requisição via AsyncLocalStorage em netlify/functions/api.mts). No servidor Node local,
 * a promessa simplesmente continua rodando.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage<{ waitUntil?: (p: Promise<unknown>) => void }>();

export function runInBackground(task: () => Promise<unknown>) {
  const p = task().catch((e) => console.error('[background] falha:', e?.message ?? e));
  requestContext.getStore()?.waitUntil?.(p);
  return p;
}
