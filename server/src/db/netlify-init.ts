/**
 * Executado na etapa de build da Netlify (sem o limite de 10 s das Functions):
 * migrations, seed oficial, segredos, administrador inicial e, se SEED_DEMO=true, dados fictícios.
 * Se o banco não estiver acessível no build, o deploy continua e a API tenta inicializar no primeiro acesso.
 */
process.env.APP_ENV ??= 'homologacao';
const { databaseUrl, getDriver } = await import('./db.ts');
if (!databaseUrl()) {
  console.warn('\n[netlify-init] NETLIFY_DATABASE_URL/DATABASE_URL não disponível no build — inicialização do banco adiada para o primeiro acesso da API.\n');
  process.exit(0);
}
try {
  const { ensureReady } = await import('../bootstrap.ts');
  const applied = await ensureReady();
  console.log(`[netlify-init] Banco pronto. Migrations aplicadas neste build: ${applied.join(', ') || 'nenhuma nova'}.`);
} catch (e: any) {
  console.warn(`\n[netlify-init] AVISO: não foi possível inicializar o banco no build (${e?.code ?? ''} ${e?.message}). A API tentará no primeiro acesso.\n`);
} finally {
  await (await getDriver()).close().catch(() => {});
}
export {};
