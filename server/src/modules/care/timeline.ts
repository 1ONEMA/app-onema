/**
 * Linha do tempo do atendimento (paciente, responsável autorizado e Carteira): somente fatos registrados.
 * Pagamento → especialista confirmada → início com código → evolução registrada → confirmação do paciente → conclusão → avaliação.
 */
import { all } from '../../db/db.ts';

export interface TimelineItem { at: string; orderId: string; eventId: string | null; kind: string; title: string; detail: string }

export async function careTimeline(patientId: string, orderId?: string): Promise<TimelineItem[]> {
  const orders = await all<any>(`SELECT id, item_name, paid_at, status FROM service_orders WHERE patient_id = ? ${orderId ? 'AND id = ?' : ''} AND status IN ('PAID','REFUNDED') ORDER BY created_at DESC LIMIT 100`,
    ...(orderId ? [patientId, orderId] : [patientId]));
  const items: TimelineItem[] = [];
  for (const o of orders) {
    if (o.paid_at) items.push({ at: o.paid_at, orderId: o.id, eventId: null, kind: 'PAGAMENTO', title: 'Pagamento confirmado', detail: o.item_name });
    const events = await all<any>(`SELECT e.id, e.label, e.modality, e.accepted_at, e.started_at, e.completed_at, e.patient_signed_at, e.patient_signature_name,
        u.name AS specialist_name, v.signed_at AS evolution_at, r.created_at AS reviewed_at, r.stars,
        (SELECT sa.coren_number || '-' || sa.coren_uf FROM specialist_applications sa WHERE sa.user_id = e.specialist_id AND sa.status = 'APROVADA') AS coren
      FROM care_events e LEFT JOIN users u ON u.id = e.specialist_id LEFT JOIN care_evolutions v ON v.event_id = e.id AND v.status = 'ASSINADA'
      LEFT JOIN specialist_reviews r ON r.event_id = e.id WHERE e.order_id = ? ORDER BY e.seq`, o.id);
    for (const e of events) {
      const who = e.specialist_name ? `${e.specialist_name}${e.coren ? ` · COREN ${e.coren}` : ''}` : '';
      if (e.accepted_at) items.push({ at: e.accepted_at, orderId: o.id, eventId: e.id, kind: 'ESPECIALISTA', title: `Especialista confirmada · ${e.label}`, detail: who });
      if (e.started_at) items.push({ at: e.started_at, orderId: o.id, eventId: e.id, kind: 'INICIO', title: `Atendimento iniciado · ${e.label}`, detail: e.modality === 'PRESENCIAL' ? 'Início confirmado com o código do paciente.' : 'Atendimento remoto iniciado.' });
      if (e.evolution_at) items.push({ at: e.evolution_at, orderId: o.id, eventId: e.id, kind: 'EVOLUCAO', title: `Evolução registrada · ${e.label}`, detail: 'Assinada pela especialista e guardada na Carteira Digital.' });
      if (e.patient_signed_at) items.push({ at: e.patient_signed_at, orderId: o.id, eventId: e.id, kind: 'CONFIRMACAO', title: `Atendimento confirmado · ${e.label}`, detail: `Assinado por ${e.patient_signature_name}.` });
      if (e.completed_at) items.push({ at: e.completed_at, orderId: o.id, eventId: e.id, kind: 'CONCLUSAO', title: `Atendimento concluído · ${e.label}`, detail: who });
      if (e.reviewed_at) items.push({ at: e.reviewed_at, orderId: o.id, eventId: e.id, kind: 'AVALIACAO', title: `Avaliação enviada · ${e.label}`, detail: `${e.stars} de 5 estrelas.` });
    }
  }
  return items.sort((x, y) => (x.at < y.at ? 1 : -1));
}
