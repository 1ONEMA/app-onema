/** Validação documental de parceiros (guia ONEMA v1.0) — critérios de aceite e casos de teste do pacote. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, all, loginAs, one, run, setup } from './helpers.ts';
import { runPartnerRevalidation } from '../src/modules/specialist/routes.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const FORM = { fullName: 'Bia Enfermeira Fictícia', cpf: '529.982.247-25', corenNumber: '654321', corenUf: 'SP', professionalCategory: 'ENFERMEIRO', states: ['SP'],
  phone: '(11) 97777-0000', regions: 'Zona Sul', needs: ['CURATIVOS'], availability: '', consent: true, dataTerm: true };
const PDF = Buffer.from('%PDF-1.4 documento fictício');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function multipart(url: string, c: Client, fields: Record<string, string>, body: Buffer, filename = 'arquivo.pdf') {
  const b = '----onema' + Math.random().toString(16).slice(2);
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const payload = Buffer.concat([...parts, Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`), body, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, payload, headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': `multipart/form-data; boundary=${b}` } });
}
const upload = (c: Client, kind: string, body = PDF) => multipart('/api/specialist/application/documents', c, { kind }, body);

async function candidate(email = 'bia.parceira@exemplo.test', docs = ['FOTO', 'PROVA_VIVA', 'IDENTIDADE', 'COREN', 'DIPLOMA_FRENTE', 'DIPLOMA_VERSO']) {
  const c = new Client(app);
  expect((await c.req('POST', '/api/auth/register', { name: 'Bia Enfermeira Fictícia', email, password: 'SenhaFicticia2026' })).status).toBe(201);
  expect((await c.put('/api/specialist/application', FORM)).status).toBe(200);
  for (const k of docs) expect((await upload(c, k, k === 'PROVA_VIVA' ? PNG : PDF)).statusCode).toBe(200);
  return c;
}
async function check(rt: Client, appId: string, checkKind: string, result = 'CONFERIDA', note = '') {
  return await rt.post(`/api/admin/specialist-applications/${appId}/verifications`, { checkKind, result, note, source: 'COFEN — Consulta de profissionais', sourceUrl: 'https://www.cofen.gov.br/' });
}
async function approveAll(rt: Client, appId: string) {
  for (const k of ['PROVA_VIVA', 'IDENTIDADE', 'INSCRICAO']) expect((await check(rt, appId, k)).status).toBe(200);
  expect((await rt.post(`/api/admin/specialist-applications/${appId}/decision`, { decision: 'APROVADA', note: 'Identidade, prova viva e inscrição conferidas.' })).status).toBe(200);
}
/** Academy concluída + credenciamento APTO (decisão separada da documentação). */
async function completeAcademyAndCredential(email: string) {
  const id = (await one<any>('SELECT id FROM users WHERE email = ?', email)).id;
  await run(`UPDATE partner_training_status SET journey_state = 'CONCLUIDA' WHERE partner_id = ?`, id);
  const cred = await loginAs(app, 'credenciamento');
  return await cred.post(`/api/admin/academy/training-status/${id}/decision`, { decision: 'APTO', note: 'Jornada concluída e requisitos conferidos.', otherGatesConfirmed: true });
}

describe('Validação documental de parceiros', () => {
  it('prova viva obrigatória; divergência bloqueia aprovação; evidência interna invisível ao parceiro; versões preservadas', async () => {
    const c = await candidate('sem.prova@exemplo.test', ['FOTO', 'IDENTIDADE', 'COREN', 'DIPLOMA_FRENTE', 'DIPLOMA_VERSO']);
    const r0 = await c.post('/api/specialist/application/submit');
    expect(r0.body.error.code).toBe('DOCUMENTS_REQUIRED');
    expect(r0.body.error.message).toMatch(/prova viva/);
    await upload(c, 'PROVA_VIVA', PNG);
    await upload(c, 'IDENTIDADE'); // substituição: a versão anterior fica preservada
    expect((await c.post('/api/specialist/application/submit')).body.application).toMatchObject({ status: 'ENVIADA', partnerState: 'EM_ANALISE' });
    const rt = await loginAs(app, 'rt');
    const a = (await rt.get('/api/admin/specialist-applications')).body.applications[0];
    expect(a.queue).toBe('NOVO');
    expect(a.documents.filter((d: any) => d.kind === 'IDENTIDADE')).toHaveLength(2);
    expect((await c.get('/api/specialist/application')).body.application.documents.filter((d: any) => d.kind === 'IDENTIDADE')).toHaveLength(1);
    // prova viva divergente: justificativa obrigatória e aprovação bloqueada
    expect((await check(rt, a.id, 'PROVA_VIVA', 'DIVERGENTE')).status).toBe(400);
    expect((await check(rt, a.id, 'PROVA_VIVA', 'DIVERGENTE', 'Documento na foto não é o mesmo enviado.')).status).toBe(200);
    await check(rt, a.id, 'IDENTIDADE'); await check(rt, a.id, 'INSCRICAO');
    const blocked = await rt.post(`/api/admin/specialist-applications/${a.id}/decision`, { decision: 'APROVADA', note: 'Tentativa de aprovar com divergência.' });
    expect(blocked.body.error).toMatchObject({ code: 'VERIFICATION_REQUIRED', details: { missing: ['PROVA_VIVA'] } });
    // evidência (print da consulta) anexada pelo RT e vinculada à conferência de inscrição
    const insc = (await rt.get('/api/admin/specialist-applications')).body.applications[0].checks.find((x: any) => x.kind === 'INSCRICAO');
    expect((await multipart(`/api/admin/specialist-applications/${a.id}/verifications/${insc.id}/evidence`, rt, {}, PNG, 'consulta-cofen.png')).statusCode).toBe(200);
    const withEv = (await rt.get('/api/admin/specialist-applications')).body.applications[0].checks.find((x: any) => x.kind === 'INSCRICAO');
    expect(withEv.evidence).toHaveLength(1);
    const evFile = await app.inject({ method: 'GET', url: `/api/admin/specialist-applications/${a.id}/evidence/${withEv.evidence[0].id}`, headers: { cookie: rt.cookie } });
    expect(evFile.statusCode).toBe(200);
    // parceiro: nada de conferências, evidências ou campo de anexo
    const own = JSON.stringify((await c.get('/api/specialist/application')).body);
    expect(own).not.toMatch(/consulta-cofen|evidence|DIVERGENTE|verification/i);
    expect((await multipart(`/api/admin/specialist-applications/${a.id}/verifications/${insc.id}/evidence`, c, {}, PNG)).statusCode).toBe(403);
    expect((await c.get('/api/admin/specialist-applications')).status).toBe(403);
    // auditor vê, mas não anexa nem decide
    const aud = await loginAs(app, 'auditor');
    expect((await multipart(`/api/admin/specialist-applications/${a.id}/verifications/${insc.id}/evidence`, aud, {}, PNG)).statusCode).toBe(403);
    // conferências são append-only
    await expect(run(`UPDATE partner_verifications SET result = 'CONFERIDA' WHERE application_id = ?`, a.id)).rejects.toThrow();
    // nova conferência corrige: aprovação liberada
    await check(rt, a.id, 'PROVA_VIVA', 'CONFERIDA', 'Nova foto enviada e conferida.');
    expect((await rt.post(`/api/admin/specialist-applications/${a.id}/decision`, { decision: 'APROVADA', note: 'Conferências concluídas.' })).status).toBe(200);
    expect((await c.get('/api/specialist/application')).body.application.partnerState).toBe('INTEGRACAO_PENDENTE');
  });

  it('inscrição não encontrada ou portal indisponível mantém em análise; correção e reenvio preservam histórico', async () => {
    const c = await candidate();
    await c.post('/api/specialist/application/submit');
    const rt = await loginAs(app, 'rt');
    const a = (await rt.get('/api/admin/specialist-applications')).body.applications[0];
    await check(rt, a.id, 'PROVA_VIVA'); await check(rt, a.id, 'IDENTIDADE');
    await check(rt, a.id, 'INSCRICAO', 'INDISPONIVEL', 'Portal do COFEN fora do ar; tentar novamente.');
    expect((await rt.post(`/api/admin/specialist-applications/${a.id}/decision`, { decision: 'APROVADA', note: 'Tentativa sem inscrição confirmada.' })).body.error.code).toBe('VERIFICATION_REQUIRED');
    await check(rt, a.id, 'INSCRICAO', 'NAO_ENCONTRADA', 'Número não localizado no COREN-SP.');
    await rt.post(`/api/admin/specialist-applications/${a.id}/decision`, { decision: 'PENDENCIA', note: 'Confira o número do COREN e envie a carteira atualizada.' });
    const own = (await c.get('/api/specialist/application')).body.application;
    expect(own).toMatchObject({ status: 'PENDENCIA', partnerState: 'CORRECAO_SOLICITADA' });
    expect(own.history.map((h: any) => h.action)).toEqual(['CORRECAO_SOLICITADA', 'ENVIADA']);
    expect((await one<any>('SELECT COUNT(*) AS n FROM partner_verifications WHERE application_id = ?', a.id)).n).toBe(4);
  });

  it('liberação só com documentação + cursos; mudança de UF e revalidação vencida bloqueiam ofertas', async () => {
    const email = 'bia.parceira@exemplo.test';
    const c = await candidate(email);
    await c.post('/api/specialist/application/submit');
    const rt = await loginAs(app, 'rt');
    const a = (await rt.get('/api/admin/specialist-applications')).body.applications[0];
    const login = async () => { const s = new Client(app); await s.login(email, 'SenhaFicticia2026'); return s; };
    // cursos concluídos sem documentação aprovada: credenciamento APTO recusado
    const id = (await one<any>('SELECT id FROM users WHERE email = ?', email)).id;
    await run(`INSERT INTO partner_training_status (partner_id, journey_state, updated_at) VALUES (?, 'CONCLUIDA', ?) ON CONFLICT (partner_id) DO UPDATE SET journey_state = 'CONCLUIDA'`, id, new Date().toISOString());
    await run(`INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'ESPECIALISTA', ?) ON CONFLICT DO NOTHING`, id, new Date().toISOString());
    expect((await completeAcademyAndCredential(email)).body.error.code).toBe('DOCUMENTATION_NOT_APPROVED');
    // documentação aprovada, mas cursos incompletos: ainda não atende
    await run(`UPDATE partner_training_status SET journey_state = 'EM_ANDAMENTO' WHERE partner_id = ?`, id);
    await approveAll(rt, a.id);
    expect((await (await login()).get('/api/care/specialist/offers')).body.error.code).toBe('NOT_CREDENTIALED');
    // as duas condições: ativo
    expect((await completeAcademyAndCredential(email)).status).toBe(200);
    const sp = await login();
    expect((await sp.get('/api/care/specialist/offers')).status).toBe(200);
    expect((await sp.get('/api/care/specialist/panel')).body).toMatchObject({ status: 'ATIVO_APTO', validation: { state: 'ATIVO' } });
    const next = (await one<any>('SELECT next_revalidation_at FROM specialist_applications WHERE id = ?', a.id)).next_revalidation_at;
    expect(Math.round((new Date(next).getTime() - Date.now()) / 86400000)).toBe(180);
    // mudança de UF: reabre o cadastro e bloqueia novos atendimentos até nova análise
    expect((await sp.post('/api/specialist/application/reopen', { reason: 'MUDANCA_DADOS' })).body.application.partnerState).toBe('CORRECAO_SOLICITADA');
    expect((await sp.get('/api/care/specialist/offers')).body.error.code).toBe('NOT_CREDENTIALED');
    await sp.put('/api/specialist/application', { ...FORM, cpf: undefined, corenUf: 'RJ', states: ['RJ', 'SP'] });
    await sp.post('/api/specialist/application/submit');
    const again = (await rt.get('/api/admin/specialist-applications')).body.applications[0];
    expect(again).toMatchObject({ queue: 'REVALIDACAO', reviewReason: 'MUDANCA_DADOS', corenUf: 'RJ' });
    await approveAll(rt, a.id);
    expect((await sp.get('/api/care/specialist/offers')).status).toBe(200);
    // revalidação: aviso 7 dias antes; vencida → suspensa e bloqueada
    // 180 dias sem atendimento contados da última atividade (aqui, a aprovação): aviso a 3 dias do prazo
    await run(`UPDATE specialist_applications SET decided_at = ? WHERE id = ?`, new Date(Date.now() - 177 * 86400000).toISOString(), a.id);
    expect(await runPartnerRevalidation()).toMatchObject({ warned: 1, suspended: 0 });
    await run(`UPDATE specialist_applications SET decided_at = ? WHERE id = ?`, new Date(Date.now() - 181 * 86400000).toISOString(), a.id);
    expect(await runPartnerRevalidation()).toMatchObject({ suspended: 1 });
    expect((await sp.get('/api/care/specialist/offers')).body.error.code).toBe('NOT_CREDENTIALED');
    expect((await sp.get('/api/specialist/application')).body.application).toMatchObject({ status: 'SUSPENSA', partnerState: 'SUSPENSO_REVALIDAR' });
    const notes = await all<any>('SELECT title FROM notifications WHERE user_id = ?', id);
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining(['Revalidação do cadastro em breve', 'Revalide seu cadastro ONEMA ONE']));
    // parceiro envia para revalidação → nova análise → reativado
    await sp.post('/api/specialist/application/reopen', { reason: 'REVALIDACAO' });
    await sp.post('/api/specialist/application/submit');
    await approveAll(rt, a.id);
    expect((await sp.get('/api/care/specialist/offers')).status).toBe(200);
    // suspensão manual pela Central
    expect((await rt.post(`/api/admin/specialist-applications/${a.id}/decision`, { decision: 'SUSPENSA', note: 'Alerta recebido; revisão extraordinária.' })).status).toBe(200);
    expect((await sp.get('/api/care/specialist/offers')).body.error.code).toBe('NOT_CREDENTIALED');
  });
});
