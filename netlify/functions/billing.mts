/** Motor de ciclos PRIME + conciliação financeira e alertas de repasse — executa a cada hora. */
import type { Config } from '@netlify/functions';

export default async () => {
  process.env.APP_ENV ??= 'homologacao';
  const { ensureReady } = await import('../../server/src/bootstrap.ts');
  const { tx } = await import('../../server/src/db/db.ts');
  const { runBilling } = await import('../../server/src/modules/prime/core.ts');
  const { audit } = await import('../../server/src/lib/audit.ts');
  await ensureReady();
  const summary = await tx(() => runBilling());
  await audit({ actorId: null, action: 'BILLING_RUN_SCHEDULED', subjectType: 'system', meta: summary });
  console.log('Motor de ciclos PRIME:', JSON.stringify(summary));
  // Conciliação financeira (cobranças pendentes, transferências) e alertas de prazo dos repasses.
  const { runFinanceJobs } = await import('../../server/src/modules/finance/jobs.ts');
  try { console.log('Conciliação financeira:', JSON.stringify(await runFinanceJobs())); } catch (e: any) { console.error('[financeiro] falha na conciliação:', e?.code ?? '', e?.message); }
};

export const config: Config = { schedule: '@hourly' };
