import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, loginAs, one, setup } from './helpers.ts';
import { validCpf } from '../src/modules/specialist/routes.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });

const CPF = '529.982.247-25'; // CPF fictício válido (dígitos verificadores)
const FORM = { fullName: 'Ana Enfermeira Fictícia', cpf: CPF, corenNumber: '123456', corenUf: 'SP', phone: '(11) 98888-0000', regions: 'Zona Sul, Vila Mariana', needs: ['CURATIVOS', 'POS_ALTA'], availability: 'Manhãs', consent: true };

/** Envio multipart (arquivo + campo kind) pelo inject do Fastify. */
async function upload(c: Client, kind: string, mime = 'application/pdf', body = Buffer.from('%PDF-1.4 documento fictício')) {
  const boundary = '----onema' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${kind.toLowerCase()}.pdf"\r\nContent-Type: ${mime}\r\n\r\n`),
    body, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({ method: 'POST', url: '/api/specialist/application/documents', payload,
    headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: res.json() };
}

async function newUser(email: string) {
  const c = new Client(app);
  const r = await c.req('POST', '/api/auth/register', { name: 'Ana Enfermeira Fictícia', email, password: 'SenhaFicticia2026' });
  expect(r.status).toBe(201);
  return c;
}

describe('Candidatura ONEMA ONE', () => {
  it('valida CPF, exige identidade e COREN, e só o Credenciamento decide; aprovação libera a Academy, não as ofertas', async () => {
    expect([validCpf(CPF), validCpf('111.111.111-11'), validCpf('529.982.247-24')]).toEqual([true, false, false]);
    const c = await newUser('ana.candidata@exemplo.test');
    expect((await c.put('/api/specialist/application', { ...FORM, cpf: '123.456.789-00' })).status).toBe(400);
    expect((await c.put('/api/specialist/application', { ...FORM, consent: false })).status).toBe(400);
    const saved = await c.put('/api/specialist/application', FORM);
    expect(saved.status).toBe(200);
    expect(saved.body.application).toMatchObject({ status: 'RASCUNHO', cpfMasked: '***.982.247-**', missingDocuments: ['IDENTIDADE', 'COREN'] });
    expect(JSON.stringify(saved.body)).not.toContain('52998224725');
    // CPF criptografado no banco (nem o número nem o formato aparecem); salvar de novo sem redigitar mantém o CPF
    const stored = await one<any>(`SELECT cpf, cpf_hash FROM specialist_applications`);
    expect(stored.cpf).toMatch(/^enc1:/);
    expect(stored.cpf).not.toContain('52998224725');
    expect(stored.cpf_hash).toBeTruthy();
    const { cpf: _omit, ...noCpf } = FORM;
    expect((await c.put('/api/specialist/application', noCpf)).body.application.cpfMasked).toBe('***.982.247-**');
    expect((await c.post('/api/specialist/application/submit')).body.error.code).toBe('DOCUMENTS_REQUIRED');
    expect((await upload(c, 'IDENTIDADE', 'text/html', Buffer.from('<html></html>'))).status).toBe(400);
    // tipo declarado mente: HTML enviado como PDF é recusado pelo conteúdo
    expect((await upload(c, 'IDENTIDADE', 'application/pdf', Buffer.from('<html><script>alert(1)</script></html>'))).body.error.code).toBe('FILE_TYPE');
    expect([400, 413]).toContain((await upload(c, 'IDENTIDADE', 'application/pdf', Buffer.alloc(5 * 1024 * 1024 + 10))).status);
    expect((await upload(c, 'IDENTIDADE')).status).toBe(200);
    expect((await upload(c, 'COREN', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).body.application.missingDocuments).toEqual([]);
    const sent = await c.post('/api/specialist/application/submit');
    expect(sent.body.application.status).toBe('ENVIADA');
    expect((await c.put('/api/specialist/application', FORM)).status).toBe(409); // bloqueada durante a análise
    // outra pessoa não pode usar o mesmo CPF
    const c2 = await newUser('outra.candidata@exemplo.test');
    expect((await c2.put('/api/specialist/application', FORM)).body.error.code).toBe('CPF_IN_USE');

    // Perfis: auditor vê mascarado e não decide; credenciamento vê o CPF, baixa documento (auditado) e decide
    const aud = await loginAs(app, 'auditor');
    const listA = (await aud.get('/api/admin/specialist-applications')).body.applications;
    expect(listA[0].cpf).toBe('***.982.247-**');
    expect((await aud.post(`/api/admin/specialist-applications/${listA[0].id}/decision`, { decision: 'APROVADA', note: 'tentativa indevida', identityAndCorenVerified: true })).status).toBe(403);
    const cred = await loginAs(app, 'credenciamento');
    const app1 = (await cred.get('/api/admin/specialist-applications')).body.applications[0];
    expect(app1.cpf).toBe('52998224725');
    const doc = await cred.req('GET', `/api/admin/specialist-applications/${app1.id}/documents/${app1.documents[0].id}`);
    expect(doc.status).toBe(200);
    expect(String(doc.headers['content-security-policy'])).toContain('sandbox');
    expect((await one<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'SPECIALIST_DOCUMENT_VIEWED'`)).n).toBe(1);
    expect((await cred.post(`/api/admin/specialist-applications/${app1.id}/decision`, { decision: 'APROVADA', note: 'Documentos conferidos.', identityAndCorenVerified: false })).body.error.code).toBe('VERIFICATION_REQUIRED');
    // pendência → candidata ajusta e reenvia → aprovação
    await cred.post(`/api/admin/specialist-applications/${app1.id}/decision`, { decision: 'PENDENCIA', note: 'Envie o COREN frente e verso.', identityAndCorenVerified: false });
    expect((await c.get('/api/specialist/application')).body.application).toMatchObject({ status: 'PENDENCIA', decisionNote: 'Envie o COREN frente e verso.' });
    await upload(c, 'COREN');
    await c.post('/api/specialist/application/submit');
    expect((await cred.post(`/api/admin/specialist-applications/${app1.id}/decision`, { decision: 'APROVADA', note: 'Identidade e COREN ativo conferidos.', identityAndCorenVerified: true })).status).toBe(200);
    const u = await one<any>(`SELECT u.academy_eligible, (SELECT COUNT(*) FROM user_roles r WHERE r.user_id = u.id AND r.role = 'ESPECIALISTA') AS esp FROM users u WHERE email = 'ana.candidata@exemplo.test'`);
    expect([u.academy_eligible, u.esp]).toEqual([1, 1]);
    // Nova sessão com o perfil novo: Academy liberada, ofertas ainda não (credenciamento final é após a Academy)
    const again = new Client(app); await again.login('ana.candidata@exemplo.test', 'SenhaFicticia2026');
    expect((await again.get('/api/care/specialist/offers')).body.error.code).toBe('NOT_CREDENTIALED');
    expect((await again.get('/api/care/specialist/summary')).body).toMatchObject({ eligible: false, credentialing: 'PENDENTE' });
  });

  it('anônimo não envia candidatura; quem já é especialista credenciado continua recebendo ofertas', async () => {
    expect((await new Client(app).put('/api/specialist/application', FORM)).status).toBe(401);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    expect((await sp.get('/api/care/specialist/summary')).body.eligible).toBe(true);
  });
});
