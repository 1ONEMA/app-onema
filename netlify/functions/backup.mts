/** Backup lógico diário do banco (Netlify Blobs, store privado "onema-backups"; retenção BACKUP_KEEP, padrão 30). */
import type { Config } from '@netlify/functions';

export default async () => {
  process.env.APP_ENV ??= 'homologacao';
  const { ensureReady } = await import('../../server/src/bootstrap.ts');
  const { runBackup } = await import('../../server/src/lib/backup.ts');
  const { audit } = await import('../../server/src/lib/audit.ts');
  await ensureReady();
  const r = await runBackup();
  await audit({ actorId: null, action: 'BACKUP_CREATED', subjectType: 'system', meta: { key: r.key, size: r.size, rows: r.rows, trigger: 'agendado' } });
  console.log('Backup diário:', r.key, r.size, 'bytes');
};

export const config: Config = { schedule: '@daily' };
