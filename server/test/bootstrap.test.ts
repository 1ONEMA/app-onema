import { describe, expect, it } from 'vitest';
import { one, run, setup } from './helpers.ts';
import { bootstrapKey, ensureReady } from '../src/bootstrap.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

describe('Inicialização em banco já existente', () => {
  it('carrega a precificação oficial v1 quando o banco foi inicializado antes dela (caminho rápido)', async () => {
    await setup();
    // Simula um banco publicado antes da precificação: inicializado, schema atual e catálogo oficial ausente.
    const key = bootstrapKey();
    await run(`INSERT INTO system_settings (key, value, created_at) VALUES ('bootstrap_version', ?, now()::text), ('schema_head', ?, now()::text)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, MIGRATIONS[MIGRATIONS.length - 1].name);
    await run('DELETE FROM catalog_item_components');
    await run('DELETE FROM catalog_item_versions');
    await run('DELETE FROM catalog_items WHERE need IS NOT NULL');
    await ensureReady();
    expect((await one<any>('SELECT COUNT(*) AS n FROM catalog_item_versions')).n).toBe(19);
    expect((await one<any>(`SELECT price_cents FROM catalog_items WHERE code = 'PAC-02'`)).price_cents).toBe(72990);
  });
});
