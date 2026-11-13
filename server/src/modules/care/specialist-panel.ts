/**
 * Painel da especialista ativa e apta (ONEMA-UX-ESP-001, 11/11/2026): quatro campos com resumo real e ação direta
 * (Academy, Meu Financeiro, Habilitações, Oportunidades) + disponibilidade e preferências de alerta.
 * Disponibilidade pausa novas ofertas e seus alertas; não cancela atendimentos aceitos.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, one, run } from '../../db/db.ts';
import { NEEDS } from '../../db/content/pricing-v1.ts';
import { config } from '../../config.ts';
import { audit } from '../../lib/audit.ts';
import { parse, requireRoles } from '../../lib/context.ts';
import { nowIso } from '../../lib/util.ts';

export async function specialistPrefs(userId: string) {
  const p = await one<any>('SELECT * FROM specialist_preferences WHERE user_id = ?', userId);
  return { available: p ? !!p.available : true, soundAlerts: p ? !!p.sound_alerts : true, whatsappAlerts: p ? !!p.whatsapp_alerts : false,
    availableChangedAt: p?.available_changed_at ?? null };
}

/** Serviços habilitados (áreas aprovadas na candidatura). Sem candidatura registrada (contas antigas): todos. */
export async function specialistNeeds(userId: string): Promise<string[] | null> {
  const a = await one<any>(`SELECT needs_json FROM specialist_applications WHERE user_id = ? AND status = 'APROVADA'`, userId);
  if (!a) return null;
  try { const n = JSON.parse(a.needs_json); return Array.isArray(n) && n.length ? n : null; } catch { return null; }
}

export async function specialistPanelRoutes(app: FastifyInstance) {
  app.get('/api/care/specialist/panel', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const training = await one<any>('SELECT journey_state, credentialing_decision FROM partner_training_status WHERE partner_id = ?', a.userId);
    const certs = (await one<any>(`SELECT COUNT(*) AS n FROM academy_certificates c JOIN academy_enrollments e ON e.id = c.enrollment_id WHERE e.partner_id = ? AND c.revoked_at IS NULL`, a.userId))!.n;
    const pay = await all<any>(`SELECT status, COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS n FROM payout_entries WHERE specialist_id = ? GROUP BY status`, a.userId);
    const sum = (sts: string[]) => pay.filter((p) => sts.includes(p.status)).reduce((s, p) => s + Number(p.total), 0);
    const dest = await one<any>(`SELECT masked_key, status FROM bank_destinations WHERE specialist_id = ? AND status IN ('PENDENTE_VERIFICACAO','VERIFICADA')`, a.userId);
    const app_ = await one<any>(`SELECT regions, status FROM specialist_applications WHERE user_id = ?`, a.userId);
    const needs = await specialistNeeds(a.userId);
    const rating = await one<any>('SELECT COUNT(*) AS n, AVG(stars) AS avg FROM specialist_reviews WHERE specialist_id = ?', a.userId);
    const apt = training?.credentialing_decision === 'APTO';
    return {
      status: apt ? 'ATIVO_APTO' : training?.credentialing_decision === 'INAPTO' ? 'INAPTO' : 'EM_HABILITACAO',
      academy: { journeyState: training?.journey_state ?? 'NAO_INICIADA', certificates: Number(certs) },
      finance: { toReceiveCents: sum(['A_LIQUIDAR', 'VALIDADO', 'PROGRAMADO', 'ENVIADO', 'ENVIO_INCERTO', 'SALDO_INSUFICIENTE', 'FALHA']), reservedCents: sum(['RESERVADO']),
        paidCents: sum(['CONFIRMADO']), pix: dest ? { masked: dest.masked_key, verified: dest.status === 'VERIFICADA' } : null },
      habilitations: { services: (needs ? NEEDS.filter((n) => needs.includes(n.key)) : NEEDS).map((n) => n.title), allServices: !needs, regions: app_?.regions ?? null },
      preferences: await specialistPrefs(a.userId),
      whatsappAvailable: config.whatsappEnabled,
      rating: { count: rating?.n ?? 0, average: rating?.avg != null ? Math.round(Number(rating.avg) * 10) / 10 : null },
    };
  });

  /** Avaliações dos atendimentos (estrelas e comentários), separadas das notas da Academy. */
  app.get('/api/care/specialist/reviews', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const rows = await all<any>(`SELECT s.stars, s.comment, s.created_at, e.label FROM specialist_reviews s JOIN care_events e ON e.id = s.event_id
      WHERE s.specialist_id = ? ORDER BY s.created_at DESC LIMIT 200`, a.userId);
    return { reviews: rows };
  });

  /** Disponibilidade e alertas: controles independentes; o estado só muda depois de gravado. */
  app.put('/api/care/specialist/preferences', async (req) => {
    const a = requireRoles(req, ['ESPECIALISTA']);
    const b = parse(z.object({ available: z.boolean().optional(), soundAlerts: z.boolean().optional(), whatsappAlerts: z.boolean().optional() }), req.body);
    const cur = await specialistPrefs(a.userId);
    const next = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    const now = nowIso();
    await run(`INSERT INTO specialist_preferences (user_id, available, available_changed_at, sound_alerts, whatsapp_alerts, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT (user_id) DO UPDATE SET available = EXCLUDED.available, available_changed_at = EXCLUDED.available_changed_at, sound_alerts = EXCLUDED.sound_alerts,
      whatsapp_alerts = EXCLUDED.whatsapp_alerts, updated_at = EXCLUDED.updated_at`,
      a.userId, next.available ? 1 : 0, b.available !== undefined && b.available !== cur.available ? now : cur.availableChangedAt, next.soundAlerts ? 1 : 0, next.whatsappAlerts ? 1 : 0, now);
    if (b.available !== undefined && b.available !== cur.available) {
      await audit({ actorId: a.userId, action: b.available ? 'SPECIALIST_AVAILABLE' : 'SPECIALIST_UNAVAILABLE', subjectType: 'user', subjectId: a.userId, correlationId: req.correlationId });
    }
    return { preferences: await specialistPrefs(a.userId) };
  });
}
