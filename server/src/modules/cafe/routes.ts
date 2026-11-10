/**
 * Café com a ONEMA — devocional diário (conteúdo opcional).
 * Cada dia mostra 1 versículo com referência e 1 parágrafo autoral de reflexão.
 * Ordem de escolha: publicação da equipe para a data (publish_date) → biblioteca anual (day_key MM-DD).
 * A data é a de America/Sao_Paulo (lotes mensais entregues pela ONEMA); a tela troca na virada do dia e ao voltar ao app.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, insertMany, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { notFound } from '../../lib/errors.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { CAFE_LIBRARY } from './library.ts';
import CAFE_BATCH_2026_11 from '../../db/content/cafe-2026-11-07_2026-12-06.json';

/** Lotes mensais entregues pela ONEMA (data editorial em America/Sao_Paulo; 2 parágrafos cada). */
export const CAFE_BATCHES: { name: string; items: unknown[] }[] = [{ name: '2026-11-07_2026-12-06', items: CAFE_BATCH_2026_11 }];
const batchItem = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), verse: z.string().trim().min(1), reference: z.string().trim().min(1),
  paragraphs: z.array(z.string().trim().min(100).max(1800)).length(2), scriptureEdition: z.string().trim().min(1), sourceUrl: z.string().url(),
}).strict();

/**
 * Importa os lotes: insere só as datas que ainda não existem (nunca sobrescreve uma data já publicada).
 * Os parágrafos ficam separados por linha em branco no campo `reflection`.
 */
export async function importCafeBatches() {
  let inserted = 0;
  for (const b of CAFE_BATCHES) {
    const items = z.array(batchItem).parse(b.items);
    for (const m of items) {
      const now = nowIso();
      const r = await run(`INSERT INTO devotionals (id, publish_date, ref, verse, reflection, scripture_edition, source_url, batch, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (publish_date) DO NOTHING`, uid(), m.date, m.reference, m.verse, m.paragraphs.join('\n\n'), m.scriptureEdition, m.sourceUrl, b.name, now, now);
      inserted += r.changes;
    }
  }
  return inserted;
}
export const CAFE_LAST_BATCH_DATE = '2026-12-06';


const EDITORS = ['GESTOR_CONTEUDO', 'ADMIN_PRIME', 'ADMIN_ACADEMY'] as const;
const dateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Data inválida (AAAA-MM-DD).');
const bodySchema = z.object({
  ref: z.string().trim().min(3, 'Informe a referência bíblica.').max(60),
  verse: z.string().trim().min(5, 'Informe o versículo.').max(400),
  reflection: z.string().trim().min(80, 'Escreva a reflexão (mínimo de 80 caracteres).').max(3800, 'Até 3.800 caracteres (dois parágrafos separados por uma linha em branco).'),
});

/** Carga idempotente da biblioteca anual (366 dias). Só insere os dias que ainda não existem. */
export async function seedCafeLibrary() {
  const have = new Set((await all<any>('SELECT day_key FROM devotionals WHERE day_key IS NOT NULL')).map((r) => r.day_key));
  const now = nowIso();
  const rows = CAFE_LIBRARY.filter((d) => !have.has(d.day)).map((d) => [uid(), d.day, d.ref, d.verse, d.reflection, now, now]);
  for (let i = 0; i < rows.length; i += 100) {
    await insertMany('devotionals', ['id', 'day_key', 'ref', 'verse', 'reflection', 'created_at', 'updated_at'], rows.slice(i, i + 100));
  }
  return rows.length;
}

async function forDate(date: string) {
  const own = await one<any>('SELECT * FROM devotionals WHERE publish_date = ?', date);
  const row = own ?? await one<any>('SELECT * FROM devotionals WHERE day_key = ?', date.slice(5));
  if (!row) return null;
  const paragraphs = String(row.reflection).split(/\n\s*\n/).map((x: string) => x.trim()).filter(Boolean);
  return { date, ref: row.ref, verse: row.verse, reflection: row.reflection, paragraphs, scriptureEdition: row.scripture_edition ?? null, source: own ? 'PUBLICACAO' : 'BIBLIOTECA' };
}

export async function cafeRoutes(app: FastifyInstance) {
  /** Público: devocional da data local do aparelho. */
  app.get('/api/public/cafe', async (req) => {
    const { date } = parse(z.object({ date: dateSchema }), req.query);
    const d = await forDate(date);
    if (!d) throw notFound('Devocional não encontrado para esta data.');
    const { source: _s, ...out } = d;
    return out;
  });

  /** Equipe: próximos dias (o que será exibido) e publicações por data. */
  app.get('/api/admin/cafe', async (req) => {
    requireRoles(req, [...EDITORS, 'AUDITOR']);
    const { from } = parse(z.object({ from: dateSchema }), req.query);
    const days: any[] = [];
    const base = new Date(`${from}T12:00:00Z`);
    for (let i = 0; i < 14; i++) {
      const date = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
      days.push(await forDate(date));
    }
    return { days: days.filter(Boolean) };
  });

  app.put('/api/admin/cafe/:date', async (req) => {
    const a = requireRoles(req, [...EDITORS]);
    const { date } = parse(z.object({ date: dateSchema }), req.params);
    const b = parse(bodySchema, req.body);
    return await tx(async () => {
      const now = nowIso();
      const prev = await one<any>('SELECT id FROM devotionals WHERE publish_date = ?', date);
      if (prev) await run('UPDATE devotionals SET ref = ?, verse = ?, reflection = ?, created_by = ?, updated_at = ? WHERE id = ?', b.ref, b.verse, b.reflection, a.userId, now, prev.id);
      else await run('INSERT INTO devotionals (id, publish_date, ref, verse, reflection, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', uid(), date, b.ref, b.verse, b.reflection, a.userId, now, now);
      await audit({ actorId: a.userId, action: 'CAFE_PUBLICADO', subjectType: 'devotional', subjectId: date, correlationId: req.correlationId, meta: { ref: b.ref } });
      return { day: await forDate(date) };
    });
  });

  app.delete('/api/admin/cafe/:date', async (req) => {
    const a = requireRoles(req, [...EDITORS]);
    const { date } = parse(z.object({ date: dateSchema }), req.params);
    await run('DELETE FROM devotionals WHERE publish_date = ?', date);
    await audit({ actorId: a.userId, action: 'CAFE_REMOVIDO', subjectType: 'devotional', subjectId: date, correlationId: req.correlationId });
    return { day: await forDate(date) };
  });
}
