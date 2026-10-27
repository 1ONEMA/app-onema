/**
 * Café com a ONEMA — devocional diário (conteúdo opcional).
 * Cada dia mostra 1 versículo com referência e 1 parágrafo autoral de reflexão.
 * Ordem de escolha: publicação da equipe para a data (publish_date) → biblioteca anual (day_key MM-DD).
 * A data é a do aparelho (virada do dia local), sem depender de atualização do aplicativo.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, insertMany, one, run, tx } from '../../db/db.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { notFound } from '../../lib/errors.ts';
import { nowIso, uid } from '../../lib/util.ts';
import { CAFE_LIBRARY } from './library.ts';

const EDITORS = ['GESTOR_CONTEUDO', 'ADMIN_PRIME', 'ADMIN_ACADEMY'] as const;
const dateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Data inválida (AAAA-MM-DD).');
const bodySchema = z.object({
  ref: z.string().trim().min(3, 'Informe a referência bíblica.').max(60),
  verse: z.string().trim().min(5, 'Informe o versículo.').max(400),
  reflection: z.string().trim().min(80, 'Escreva um parágrafo de reflexão (mínimo de 80 caracteres).').max(1600),
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
  return { date, ref: row.ref, verse: row.verse, reflection: row.reflection, source: own ? 'PUBLICACAO' : 'BIBLIOTECA' };
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
