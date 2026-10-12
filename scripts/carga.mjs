/**
 * Medição de referência de carga (Documento Mestre Academy, ACA-T047: picos de leitura do catálogo/player).
 * O SLO ainda não foi definido pela ONEMA; este script mede latência e erros e confere consistência.
 * Uso: node scripts/carga.mjs [baseURL] [concorrência] [segundos]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const CONC = Number(process.argv[3] ?? 50);
const SECS = Number(process.argv[4] ?? 20);

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, password: 'Onema-Demo-2026' }) });
  if (!r.ok) throw new Error(`login ${r.status}`);
  return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: (await r.json()).csrfToken };
}
const { cookie, csrf } = await login('especialista.demo@exemplo.test');
// Matrícula (pedido sandbox de R$ 19,90 + pagamento simulado), para medir também curso e player da aula.
const post = (url, body) => fetch(BASE + url, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, origin: BASE, 'content-type': 'application/json', 'idempotency-key': `carga_${Math.random().toString(36).slice(2, 12)}` }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const order = (await post('/api/academy/payment-orders')).order;
if (order.status !== 'PAGO') await post(`/api/academy/payment-orders/${order.id}/sandbox-pay`, { outcome: 'APROVADO' });
await post('/api/academy/enrollments');
const ROUTES = ['/api/academy/catalog', '/api/academy/journey', '/api/academy/courses/C01', '/api/academy/lessons/C01-A01', '/api/care/needs'];
const before = await (await fetch(`${BASE}/api/academy/journey`, { headers: { cookie } })).text();

const lat = Object.fromEntries(ROUTES.map((r) => [r, []]));
let errors = 0, total = 0;
const end = Date.now() + SECS * 1000;
async function worker(i) {
  let k = i;
  while (Date.now() < end) {
    const route = ROUTES[k++ % ROUTES.length];
    const t = performance.now();
    try {
      const r = await fetch(BASE + route, { headers: { cookie } });
      await r.arrayBuffer();
      if (!r.ok) errors++;
    } catch { errors++; }
    lat[route].push(performance.now() - t);
    total++;
  }
}
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
const after = await (await fetch(`${BASE}/api/academy/journey`, { headers: { cookie } })).text();
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(0) : '-'; };
console.log(`Base: ${BASE} · concorrência ${CONC} · ${SECS}s · ${total} requisições (${(total / SECS).toFixed(0)}/s) · erros ${errors} (${((errors / total) * 100).toFixed(2)}%)`);
for (const r of ROUTES) console.log(`${r.padEnd(28)} n=${String(lat[r].length).padStart(5)} p50=${pct(lat[r], 50)}ms p95=${pct(lat[r], 95)}ms p99=${pct(lat[r], 99)}ms`);
console.log(`Consistência da jornada antes/depois: ${before === after ? 'idêntica' : 'DIFERENTE'}`);
