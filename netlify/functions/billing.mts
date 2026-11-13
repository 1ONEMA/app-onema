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
  // Lembretes PRIME do Life Score (planos de retorno definidos pela enfermeira).
  const { runLifescoreReminders } = await import('../../server/src/modules/lifescore/service.ts');
  try { console.log('Lembretes Life Score:', JSON.stringify(await runLifescoreReminders())); } catch (e: any) { console.error('[lifescore] falha nos lembretes:', e?.message); }
  // Revalidação periódica dos parceiros (aviso 7 dias antes; suspensão quando vence).
  const { runPartnerRevalidation } = await import('../../server/src/modules/specialist/routes.ts');
  try { console.log('Revalidação de parceiros:', JSON.stringify(await runPartnerRevalidation())); } catch (e: any) { console.error('[parceiros] falha na revalidação:', e?.message); }
  // Carteira Digital: lembretes do plano de cuidados, escalonamento de alertas e falhas de canal.
  const { runCarteiraAlerts } = await import('../../server/src/modules/carteira/engine.ts');
  try { console.log('Alertas da Carteira:', JSON.stringify(await runCarteiraAlerts())); } catch (e: any) { console.error('[carteira] falha nos alertas:', e?.message); }
};

export const config: Config = { schedule: '@hourly' };
