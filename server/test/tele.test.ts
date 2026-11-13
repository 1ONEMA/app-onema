/** Telenfermagem (POP-ONEMA-TELE-001) — matriz de testes T01–T20 do pacote de homologação. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, emailOf, idOf, loginAs, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { EMPTY_TELE_NOTE } from '../src/modules/tele/core.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const ADDR = { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' };
const NOTE = { ...EMPTY_TELE_NOTE, relato: 'Paciente refere melhora da dor no local do curativo.', avaliacao: 'Ferida observada por vídeo sem sinais de infecção.',
  orientacoes: 'Manter curativo seco e retornar se houver febre.', origemDados: 'Relatado e observado por vídeo.' };

/** Atendimento presencial concluído pela especialista credenciada (origem do retorno). */
async function concludedVisit() {
  const c = new Client(app); await c.login(emailOf('paciente'));
  const req = (await c.post('/api/care/requests', { need: NEED_OF['CAT-03'], itemCode: 'CAT-03', infoText: '', materials: 'NAO', materialsDetail: '', materialsSupplyRequested: false,
    patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'HOJE', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
    timeWindow: 'TARDE', patientBirthDate: '1950-05-10', address: ADDR }, true)).body.request;
  await c.post(`/api/care/requests/${req.id}/accept`, { quoteVersion: 1 });
  await c.post(`/api/care/requests/${req.id}/checkout`, { quoteVersion: 1, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: req.quote.totalCents }, true);
  const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
  const ev = (await sp.get('/api/care/specialist/offers')).body.offers[0];
  await sp.post(`/api/care/specialist/events/${ev.id}/accept`);
  await run(`UPDATE care_events SET status = 'CONCLUIDO', completed_at = ? WHERE id = ?`, new Date().toISOString(), ev.id);
  return { patient: c, sp, eventId: ev.id as string };
}

/** Até AGENDADO: indicação → elegibilidade → consentimento → aceite → agenda (agora). */
async function scheduled(opts: { modality?: string } = {}) {
  const { patient, sp, eventId } = await concludedVisit();
  const ep = (await sp.post('/api/tele/episodes', { modality: opts.modality ?? 'RETORNO_ONLINE', reason: 'Reavaliar evolução da ferida após curativo.', originEventId: eventId })).body.episode;
  const rt = await loginAs(app, 'rt');
  const el = (await rt.post(`/api/tele/episodes/${ep.id}/eligibility`, { eligible: true, note: 'Elegível pelo protocolo.' })).body.episode;
  const accepted = el.pricing.rule === 'COBRADO' ? { acceptedPriceCents: el.pricing.priceCents } : {};
  expect((await patient.post(`/api/tele/episodes/${ep.id}/consent`, { decision: 'ACEITO', ...accepted })).status).toBe(200);
  expect((await sp.post(`/api/tele/episodes/${ep.id}/accept`)).status).toBe(200);
  expect((await sp.post(`/api/tele/episodes/${ep.id}/schedule`, { startAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(200);
  return { patient, sp, rt, id: ep.id as string, eventId };
}
async function inCall() {
  const s = await scheduled();
  const t = (await s.sp.post(`/api/tele/episodes/${s.id}/video-token`)).body;
  expect((await s.sp.post(`/api/tele/episodes/${s.id}/join`, { token: t.token })).body.status).toBe('EM_ATENDIMENTO');
  return s;
}

describe('Telenfermagem (homologação)', () => {
  it('jornada completa: retorno incluído → sala → registro assinado → Carteira (T07, T14, T17, T18, T19, T20)', async () => {
    const s = await inCall();
    const mediaBefore = (await one<any>('SELECT COUNT(*) AS n FROM academy_media_assets'))!.n;
    const payBefore = JSON.stringify(await all('SELECT id, status, amount_cents FROM payout_entries ORDER BY id'));
    const ordersBefore = (await one<any>('SELECT COUNT(*) AS n FROM service_orders'))!.n;
    const ep = (await s.patient.get(`/api/tele/episodes/${s.id}`)).body.episode;
    expect(ep.pricing).toMatchObject({ rule: 'INCLUIDO', priceCents: 0 }); // T07
    expect(ep.homologation).toBe(true);
    // T14: Kary indisponível no teste → rascunho manual; registro sempre exige revisão humana
    const org = (await s.sp.post(`/api/tele/episodes/${s.id}/notes/organize`, { dictation: 'Paciente refere melhora da dor, ferida limpa ao vídeo, orientado manter curativo seco.' })).body;
    expect(org.aiMessage).toBeTruthy();
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/sign`, { content: NOTE })).status).toBe(400); // sem confirmação humana
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/sign`, { content: NOTE, confirm: true })).body.error.code).toBe('TELE_STATE_CONFLICT'); // chamada aberta
    const ended = (await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'ENCERRADO' })).body.episode;
    expect(ended.status).toBe('AGUARDANDO_REGISTRO');
    // T20: encerrar a chamada não gera cobrança nem repasse
    expect(JSON.stringify(await all('SELECT id, status, amount_cents FROM payout_entries ORDER BY id'))).toBe(payBefore);
    expect((await one<any>('SELECT COUNT(*) AS n FROM service_orders'))!.n).toBe(ordersBefore);
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/sign`, { content: NOTE, confirm: true })).body.episode.status).toBe('ASSINADO');
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/close`)).body.episode.status).toBe('CONCLUIDO');
    expect(JSON.stringify(await all('SELECT id, status, amount_cents FROM payout_entries ORDER BY id'))).toBe(payBefore);
    // T19: nota no prontuário único (Carteira), episódio e origem corretos
    const w = (await s.patient.get('/api/care/wallet')).body;
    expect(w.teleNotes).toHaveLength(1);
    expect(w.teleNotes[0]).toMatchObject({ episodeId: s.id, originEventId: s.eventId, kind: 'REGISTRO' });
    // T17: notificações sem conteúdo clínico
    const pid = await idOf('paciente');
    const notes = await all<any>('SELECT title, body FROM notifications WHERE user_id = ?', pid);
    for (const n of notes.filter((x) => /tele|registro|enfermeira/i.test(x.title))) expect(n.body).not.toMatch(/ferida|dor|curativo/i);
    // T18: nenhuma mídia persistida
    expect((await one<any>('SELECT COUNT(*) AS n FROM academy_media_assets'))!.n).toBe(mediaBefore);
  });

  it('T01 consentimento: sem aceite não abre a sala; recusa documentada', async () => {
    const { patient, sp, eventId } = await concludedVisit();
    const ep = (await sp.post('/api/tele/episodes', { modality: 'RETORNO_ONLINE', reason: 'Reavaliar evolução da ferida.', originEventId: eventId })).body.episode;
    const rt = await loginAs(app, 'rt');
    await rt.post(`/api/tele/episodes/${ep.id}/eligibility`, { eligible: true, note: 'Elegível.' });
    expect((await patient.post(`/api/tele/episodes/${ep.id}/video-token`)).body.error.code).toBe('CONSENT_REQUIRED');
    expect((await patient.post(`/api/tele/episodes/${ep.id}/consent`, { decision: 'RECUSADO' })).body.episode.status).toBe('RECUSADO');
    expect((await one<any>(`SELECT decision FROM tele_consents WHERE episode_id = ?`, ep.id)).decision).toBe('RECUSADO');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE subject_id = ? AND action = 'TELE_BLOCKED_NO_CONSENT'`, ep.id)).n).toBe(1);
    await expect(run(`UPDATE tele_consents SET decision = 'ACEITO' WHERE episode_id = ?`, ep.id)).rejects.toThrow();
  });

  it('T02/T04: parceiro sem vínculo e paciente de outro episódio não acessam (auditado)', async () => {
    const s = await scheduled();
    const outra = new Client(app); await outra.login(emailOf('especialista'));
    expect((await outra.get(`/api/tele/episodes/${s.id}`)).status).toBe(404);
    expect((await outra.post(`/api/tele/episodes/${s.id}/video-token`)).status).toBe(404);
    const outro = new Client(app); await outro.login(emailOf('responsavel'));
    expect((await outro.get(`/api/tele/episodes/${s.id}`)).status).toBe(404);
    expect((await outro.post(`/api/tele/episodes/${s.id}/video-token`)).status).toBe(404);
    expect((await outro.req('PUT', `/api/tele/episodes/${s.id}/notes`, { content: NOTE })).status).toBe(404);
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE subject_id = ? AND action = 'TELE_ACCESS_DENIED'`, s.id)).n).toBeGreaterThanOrEqual(5);
  });

  it('T03: token expirado ou de outra pessoa é negado; novo token funciona', async () => {
    const s = await scheduled();
    const t = (await s.patient.post(`/api/tele/episodes/${s.id}/video-token`)).body;
    expect(t).toMatchObject({ provider: 'SIMULADO', recording: false });
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/join`, { token: t.token })).body.error.code).toBe('ROOM_TOKEN_EXPIRED'); // token do paciente
    await run(`UPDATE tele_room_tokens SET expires_at = ? WHERE episode_id = ?`, new Date(Date.now() - 1000).toISOString(), s.id);
    expect((await s.patient.post(`/api/tele/episodes/${s.id}/join`, { token: t.token })).status).toBe(401);
    const t2 = (await s.patient.post(`/api/tele/episodes/${s.id}/video-token`)).body;
    expect((await s.patient.post(`/api/tele/episodes/${s.id}/join`, { token: t2.token })).status).toBe(200);
    expect(JSON.stringify(await all('SELECT * FROM tele_room_tokens'))).not.toContain(t2.token);
  });

  it('T05 queda de conexão marca falha sem concluir e permite reagendar', async () => {
    const s = await inCall();
    const f = (await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'FALHA_TECNICA' })).body.episode;
    expect(f).toMatchObject({ status: 'FALHA_TECNICA', failures: 1 });
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/close`)).body.error.code).toBe('SIGNATURE_REQUIRED');
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/schedule`, { startAt: new Date(Date.now() + 3600_000).toISOString() })).body.episode.status).toBe('AGENDADO');
  });

  it('T06/T11/T12: conclusão exige assinatura; assinada é imutável (adendo); sem assinatura duplicada', async () => {
    const s = await inCall();
    await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'ENCERRADO' });
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/close`)).body.error.code).toBe('SIGNATURE_REQUIRED'); // T06
    const [r1, r2] = await Promise.all([
      s.sp.post(`/api/tele/episodes/${s.id}/sign`, { content: NOTE, confirm: true }),
      s.sp.post(`/api/tele/episodes/${s.id}/sign`, { content: { ...NOTE, relato: 'Outra versão concorrente do registro.' }, confirm: true }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]); // T12
    expect((await one<any>(`SELECT COUNT(*) AS n FROM tele_notes WHERE episode_id = ? AND status = 'ASSINADA'`, s.id)).n).toBe(1);
    expect((await s.sp.req('PUT', `/api/tele/episodes/${s.id}/notes`, { content: NOTE })).status).toBe(409);
    await expect(run(`UPDATE tele_notes SET content_json = '{}' WHERE episode_id = ?`, s.id)).rejects.toThrow(); // T11
    const ad = (await s.sp.post(`/api/tele/episodes/${s.id}/addenda`, { text: 'Correção: retorno combinado para 7 dias.', confirm: true })).body.episode;
    expect(ad.notes.map((n: any) => [n.kind, n.version])).toEqual([['REGISTRO', 1], ['ADENDO', 2]]);
    expect(ad.notes[0].content.relato).toBe(NOTE.relato);
  });

  it('T08 retorno cobrado: preço exibido e aceite explícito antes da confirmação', async () => {
    const { patient, sp, eventId } = await concludedVisit();
    await run(`UPDATE care_events SET completed_at = ? WHERE id = ?`, new Date(Date.now() - 40 * 86400000).toISOString(), eventId);
    const ep = (await sp.post('/api/tele/episodes', { modality: 'RETORNO_ONLINE', reason: 'Reavaliar fora da janela.', originEventId: eventId })).body.episode;
    const rt = await loginAs(app, 'rt');
    const el = (await rt.post(`/api/tele/episodes/${ep.id}/eligibility`, { eligible: true, note: 'Elegível.' })).body.episode;
    expect(el.pricing.rule).toBe('COBRADO');
    expect(el.pricing.priceCents).toBeGreaterThan(0);
    expect((await patient.post(`/api/tele/episodes/${ep.id}/consent`, { decision: 'ACEITO' })).body.error.code).toBe('PRICE_NOT_ACCEPTED');
    const ok = (await patient.post(`/api/tele/episodes/${ep.id}/consent`, { decision: 'ACEITO', acceptedPriceCents: el.pricing.priceCents })).body.episode;
    expect(ok.status).toBe('OFERTADO');
    expect(ok.pricing.acceptedAt).toBeTruthy();
  });

  it('T09/T10: encaminhamento presencial e urgência documentados', async () => {
    const a = await inCall();
    const p = (await a.sp.post(`/api/tele/episodes/${a.id}/referral`, { kind: 'PRESENCIAL', reason: 'Necessita avaliação presencial da ferida.', plan: 'Agendar curativo presencial em 48 h.' })).body;
    expect(p.episode).toMatchObject({ status: 'ENCAMINHADO_PRESENCIAL', outcomeReason: 'Necessita avaliação presencial da ferida.' });
    // registro ainda pode ser assinado depois do encaminhamento
    expect((await a.sp.post(`/api/tele/episodes/${a.id}/sign`, { content: NOTE, confirm: true })).status).toBe(200);
    const b = await inCall();
    const u = (await b.sp.post(`/api/tele/episodes/${b.id}/referral`, { kind: 'URGENCIA', reason: 'Dor torácica relatada.', plan: 'Orientado acionar SAMU.' })).body;
    expect(u.episode.status).toBe('URGENCIA_ENCAMINHADA');
    expect(u.guidance).toMatch(/192/);
    expect(u.episode.outcomePlan).toMatch(/SAMU/);
  });

  it('T13 Life Score não é recalculado pelo teleatendimento; T15 auditoria só para RT/Central', async () => {
    const before = (await one<any>('SELECT COUNT(*) AS n FROM lifescore_assessments'))!.n;
    const s = await inCall();
    await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'ENCERRADO' });
    expect((await one<any>('SELECT COUNT(*) AS n FROM lifescore_assessments'))!.n).toBe(before);
    expect((await s.patient.get(`/api/tele/episodes/${s.id}/audit`)).status).toBe(403);
    expect((await s.sp.get(`/api/tele/episodes/${s.id}/audit`)).status).toBe(403);
    const trail = (await s.rt.get(`/api/tele/episodes/${s.id}/audit`)).body.events;
    expect(trail.map((e: any) => e.action)).toEqual(expect.arrayContaining(['TELE_REQUESTED', 'TELE_STATUS', 'TELE_CONSENT_ACEITO', 'TELE_TOKEN_ISSUED', 'TELE_ROOM_JOINED']));
    expect(JSON.stringify(trail)).not.toMatch(/ferida|Reavaliar/);
    const pend = (await s.rt.get('/api/admin/tele/pending')).body;
    expect(pend.counts.AGUARDANDO_REGISTRO).toBe(1);
  });

  it('T16 ausência do paciente registrada com a política', async () => {
    const s = await scheduled();
    expect((await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'NAO_COMPARECEU' })).body.error.code).toBe('TOO_EARLY');
    await run(`UPDATE tele_episodes SET scheduled_at = ? WHERE id = ?`, new Date(Date.now() - 20 * 60_000).toISOString(), s.id);
    const r = (await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'NAO_COMPARECEU' })).body.episode;
    expect(r.status).toBe('NAO_COMPARECEU');
    expect(r.outcomeReason).toMatch(/Ausência registrada/);
  });

  it('oferta: preferência à enfermeira de origem, redistribuição no prazo; inelegível; homologação só com conta de teste', async () => {
    const { patient, sp, eventId } = await concludedVisit();
    const ep = (await sp.post('/api/tele/episodes', { modality: 'RETORNO_ONLINE', reason: 'Reavaliar evolução da ferida.', originEventId: eventId })).body.episode;
    const rt = await loginAs(app, 'rt');
    await rt.post(`/api/tele/episodes/${ep.id}/eligibility`, { eligible: true, note: 'Elegível.' });
    await patient.post(`/api/tele/episodes/${ep.id}/consent`, { decision: 'ACEITO' });
    const outraId = await idOf('especialista');
    await run(`INSERT INTO partner_training_status (partner_id, journey_state, credentialing_decision, updated_at) VALUES (?, 'CONCLUIDA', 'APTO', ?)
      ON CONFLICT (partner_id) DO UPDATE SET credentialing_decision = 'APTO'`, outraId, new Date().toISOString());
    const outra = new Client(app); await outra.login(emailOf('especialista'));
    expect((await outra.post(`/api/tele/episodes/${ep.id}/accept`)).status).toBe(404); // ainda reservada à de origem
    await run(`UPDATE tele_episodes SET offer_expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), ep.id);
    expect((await outra.get('/api/tele/episodes?scope=profissional')).body.episodes.map((e: any) => e.id)).toContain(ep.id);
    const offer = (await outra.get('/api/tele/episodes?scope=profissional')).body.episodes.find((e: any) => e.id === ep.id);
    expect(offer.patientName).toBeUndefined(); // oferta sem dados pessoais
    expect((await outra.post(`/api/tele/episodes/${ep.id}/accept`)).status).toBe(200);
    expect((await sp.post(`/api/tele/episodes/${ep.id}/accept`)).status).toBe(404);
    // inelegível
    const ep2 = (await sp.post('/api/tele/episodes', { modality: 'MONITORAMENTO', reason: 'Monitorar glicemia semanal.', originEventId: eventId })).body.episode;
    expect((await rt.post(`/api/tele/episodes/${ep2.id}/eligibility`, { eligible: false, note: 'Fora do protocolo.' })).body.episode.status).toBe('INELEGIVEL');
    // conta real (fora de @exemplo.test) bloqueada
    await run(`UPDATE users SET email = 'pessoa.real@gmail.com' WHERE email = ?`, emailOf('paciente'));
    expect((await sp.post('/api/tele/episodes', { modality: 'RETORNO_ONLINE', reason: 'Reavaliar evolução da ferida.', originEventId: eventId })).body.error.code).toBe('TELE_HOMOLOGATION_ONLY');
  });

  it('vídeo real (Daily): sala privada sem gravação, acesso só depois do token ONEMA, sala encerrada no fim', async () => {
    const s = await scheduled();
    const calls: { method: string; url: string; body: any }[] = [];
    const real = globalThis.fetch;
    process.env.DAILY_API_KEY = 'chave-ficticia';
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (!u.startsWith('https://api.daily.co/')) return real(url, init);
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ method: init?.method ?? 'GET', url: u, body });
      if (init?.method === 'GET') return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
      if (u.endsWith('/rooms')) return new Response(JSON.stringify({ name: body.name, url: `https://onema-saude.daily.co/${body.name}` }), { status: 200 });
      if (u.endsWith('/meeting-tokens')) return new Response(JSON.stringify({ token: `tok-${body.properties.is_owner ? 'owner' : 'guest'}` }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as any;
    try {
      const t = (await s.sp.post(`/api/tele/episodes/${s.id}/video-token`)).body;
      expect(t.provider).toBe('DAILY');
      expect(calls).toHaveLength(0); // nada no Daily antes da conferência do token ONEMA
      const j = (await s.sp.post(`/api/tele/episodes/${s.id}/join`, { token: t.token })).body;
      expect(j.video.url).toMatch(/^https:\/\/onema-saude\.daily\.co\/onema-[0-9a-f]{16}\?t=tok-owner$/);
      const room = calls.find((c) => c.url.endsWith('/rooms'))!.body;
      expect(room).toMatchObject({ privacy: 'private' });
      expect(JSON.stringify(room)).not.toMatch(/record/);
      expect(room.name).not.toContain(s.id);
      const tokenReq = calls.find((c) => c.url.endsWith('/meeting-tokens'))!.body.properties;
      expect(tokenReq).toMatchObject({ is_owner: true, enable_recording: false });
      const pt = (await s.patient.post(`/api/tele/episodes/${s.id}/video-token`)).body;
      expect((await s.patient.post(`/api/tele/episodes/${s.id}/join`, { token: pt.token })).body.video.url).toMatch(/tok-guest$/);
      await s.sp.post(`/api/tele/episodes/${s.id}/end`, { outcome: 'ENCERRADO' });
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/rooms/onema-'))).toBe(true);
    } finally {
      globalThis.fetch = real; delete process.env.DAILY_API_KEY;
    }
  });
});
