/** Motor de ciclos PRIME (renovações, novas tentativas, suspensões, encerramentos) — executa a cada hora. */
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
};

export const config: Config = { schedule: '@hourly' };
