import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, idOf, one, run, setup } from './helpers.ts';
import { PRICING_V1 } from '../src/db/content/pricing-v1.ts';
import { openField, sealField } from '../src/lib/security.ts';

/** Ajustes A01/A02 (22/11/2026): pré-preenchimento "O cuidado é para mim", endereço completo e etapa de materiais. */
let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
const NEED_OF = Object.fromEntries(PRICING_V1.map((d) => [d.code, d.need]));
const ADDR = { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: 'ap 1', district: 'Vila Mariana', city: 'São Paulo', uf: 'SP', reference: 'Perto da praça' };
const form = (extra: any = {}) => ({ need: NEED_OF['CAT-02A'], itemCode: 'CAT-02A', infoText: '', materials: 'SIM', materialsDetail: '', materialsSupplyRequested: false,
  patientName: 'Paciente Fictício', phone: '(11) 99999-0000', location: 'Vila Mariana', whenPref: 'PROXIMOS_DIAS', whenDate: null, notes: '', forSelf: true, responsibleAuthorized: false,
  timeWindow: 'MANHA', patientBirthDate: '1950-05-10', address: ADDR, ...extra });

async function patientClient() { const c = new Client(app); await c.login(emailOf('paciente')); return c; }

describe('Cadastro próprio para "O cuidado é para mim" (A01)', () => {
  it('perfil vazio e sem solicitações: só o nome; o resto fica vazio para completar', async () => {
    const c = await patientClient();
    const p = (await c.get('/api/care/self-profile')).body;
    const u = await one<any>('SELECT name FROM users WHERE id = ?', await idOf('paciente'));
    expect(p).toEqual({ name: u.name, phone: '', birthDate: '', address: null });
  });

  it('exige paciente autenticado', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/care/self-profile' })).statusCode).toBe(401);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    expect((await sp.get('/api/care/self-profile')).status).toBe(403);
  });

  it('usa o cadastro do usuário (endereço aberto do campo cifrado)', async () => {
    const c = await patientClient();
    const id = await idOf('paciente');
    await run('UPDATE users SET phone = ?, birth_date = ?, address_sealed = ? WHERE id = ?', '(11) 98888-7777', '1961-02-03', sealField(JSON.stringify(ADDR)), id);
    const p = (await c.get('/api/care/self-profile')).body;
    expect(p).toMatchObject({ phone: '(11) 98888-7777', birthDate: '1961-02-03', address: { street: 'Rua Fictícia', number: '100', uf: 'SP', district: 'Vila Mariana' } });
  });

  it('primeira solicitação "para mim" preenche o cadastro vazio; depois nunca sobrescreve; recorrente reaproveita', async () => {
    const c = await patientClient();
    const id = await idOf('paciente');
    const first = await c.post('/api/care/requests', form(), true);
    expect(first.status).toBe(201);
    const u1 = await one<any>('SELECT phone, birth_date, address_sealed FROM users WHERE id = ?', id);
    expect(u1.phone).toBe('(11) 99999-0000');
    expect(u1.birth_date).toBe('1950-05-10');
    expect(u1.address_sealed).not.toContain('Rua Fictícia'); // cifrado
    expect(JSON.parse(openField(u1.address_sealed))).toMatchObject({ street: 'Rua Fictícia', uf: 'SP' });
    // mudança de endereço/telefone em solicitação posterior: a solicitação leva os dados novos, o cadastro não muda
    const other = { ...ADDR, street: 'Avenida Nova', number: '2000' };
    const second = (await c.post('/api/care/requests', form({ phone: '(11) 97777-1111', address: other }), true)).body.request;
    expect(second.address).toMatchObject({ street: 'Avenida Nova', number: '2000' });
    expect(second.phone).toBe('(11) 97777-1111');
    const u2 = await one<any>('SELECT phone, birth_date, address_sealed FROM users WHERE id = ?', id);
    expect(u2).toEqual(u1);
    const p = (await c.get('/api/care/self-profile')).body;
    expect(p).toMatchObject({ phone: '(11) 99999-0000', birthDate: '1950-05-10', address: { street: 'Rua Fictícia' } });
  });

  it('cadastro incompleto: completa com a última solicitação "para mim", nunca com a de outra pessoa', async () => {
    const c = await patientClient();
    const id = await idOf('paciente');
    // solicitação antiga para mim
    const mine = (await c.post('/api/care/requests', form({ phone: '(11) 95555-0000', patientBirthDate: '1955-01-01' }), true)).body.request;
    // simula cadastro vazio (ex.: dados anteriores à migração 029)
    await run('UPDATE users SET phone = NULL, birth_date = NULL, address_sealed = NULL WHERE id = ?', id);
    // solicitação mais recente, para OUTRA pessoa (dependente)
    await run('UPDATE care_requests SET created_at = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', mine.id);
    const dep = await c.post('/api/care/requests', form({ forSelf: false, responsibleAuthorized: true, relationship: 'filha', patientName: 'Dependente Fictício',
      phone: '(11) 91111-2222', patientBirthDate: '1930-09-09', address: { ...ADDR, street: 'Rua do Dependente' } }), true);
    expect(dep.status).toBe(201);
    // solicitação para outra pessoa não preenche o cadastro
    expect((await one<any>('SELECT phone, birth_date, address_sealed FROM users WHERE id = ?', id))).toEqual({ phone: null, birth_date: null, address_sealed: null });
    const p = (await c.get('/api/care/self-profile')).body;
    expect(p).toMatchObject({ phone: '(11) 95555-0000', birthDate: '1955-01-01', address: { street: 'Rua Fictícia' } });
    expect(JSON.stringify(p)).not.toContain('Dependente');
    expect(JSON.stringify(p)).not.toContain('1930-09-09');
    // campo do cadastro preenchido tem prioridade; vazio cai para a solicitação
    await run('UPDATE users SET phone = ? WHERE id = ?', '(11) 94444-3333', id);
    expect((await c.get('/api/care/self-profile')).body).toMatchObject({ phone: '(11) 94444-3333', birthDate: '1955-01-01' });
  });

  it('só solicitações para outra pessoa: nada além do nome', async () => {
    const c = await patientClient();
    await c.post('/api/care/requests', form({ forSelf: false, responsibleAuthorized: true, patientName: 'Dependente Fictício', phone: '(11) 91111-2222' }), true);
    const p = (await c.get('/api/care/self-profile')).body;
    expect(p).toMatchObject({ phone: '', birthDate: '', address: null });
  });
});

describe('Endereço completo do atendimento (A01)', () => {
  it('aceita UF e "sem número"; especialista recebe os mesmos dados da solicitação', async () => {
    const c = await patientClient();
    const r = (await c.post('/api/care/requests', form({ address: { ...ADDR, number: '', noNumber: true, uf: 'sp' } }), true)).body.request;
    expect(r.address).toMatchObject({ number: 'S/N', noNumber: true, uf: 'SP', reference: 'Perto da praça' });
    // número vazio sem marcar "sem número": erro no campo
    const bad = await c.post('/api/care/requests', form({ address: { ...ADDR, number: '' } }), true);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('address.number');
    expect((await c.post('/api/care/requests', form({ address: { ...ADDR, uf: 'SPX' } }), true)).status).toBe(400);
    // solicitação antiga (sem UF nem noNumber) continua válida
    const legacy = { cep: '04101-000', street: 'Rua Fictícia', number: '100', complement: '', district: 'Vila Mariana', city: 'São Paulo', reference: '' };
    expect((await c.post('/api/care/requests', form({ address: legacy }), true)).status).toBe(201);
    // fluxo até a especialista: endereço igual ao da solicitação
    await c.post(`/api/care/requests/${r.id}/accept`, { quoteVersion: r.quoteVersion });
    await c.post(`/api/care/requests/${r.id}/checkout`, { quoteVersion: r.quoteVersion, paymentMethod: 'SANDBOX_APROVADO', expectedTotalCents: r.quote.totalCents }, true);
    const sp = new Client(app); await sp.login(emailOf('especialistaOne'));
    const ev = (await sp.get('/api/care/specialist/offers')).body.offers.find((o: any) => o.modality === 'PRESENCIAL');
    expect((await sp.post(`/api/care/specialist/events/${ev.id}/accept`)).status).toBe(200);
    const visit = (await sp.get(`/api/care/specialist/events/${ev.id}/evolution`)).body.visit;
    expect(visit).toMatchObject({ patientName: 'Paciente Fictício', phone: '(11) 99999-0000', patientBirthDate: '1950-05-10', address: r.address });
  });

  it('remoto sem endereço continua aceito (só a localização); troca de paciente na edição grava os novos dados', async () => {
    const c = await patientClient();
    const remote = form({ need: NEED_OF['CONT-01'], itemCode: 'CONT-01', address: null, location: 'São Paulo' });
    const r = (await c.post('/api/care/requests', remote, true)).body.request;
    expect(r.address).toBeNull();
    expect(r.guidance.status).toBe('NAO_APLICAVEL');
    expect((await c.post(`/api/care/requests/${r.id}/accept`, { quoteVersion: r.quoteVersion })).status).toBe(200);
    // troca para outra pessoa: dados da solicitação substituídos, cadastro próprio intacto
    const before = await one<any>('SELECT phone, birth_date FROM users WHERE id = ?', await idOf('paciente'));
    const upd = (await c.put(`/api/care/requests/${r.id}`, { ...remote, forSelf: false, responsibleAuthorized: true, patientName: 'Dependente Fictício', phone: '(11) 91111-2222', patientBirthDate: null })).body.request;
    expect(upd).toMatchObject({ forSelf: false, patientName: 'Dependente Fictício', phone: '(11) 91111-2222', patientBirthDate: null });
    expect(await one<any>('SELECT phone, birth_date FROM users WHERE id = ?', await idOf('paciente'))).toEqual(before);
  });
});

describe('Etapa de materiais não aplicável (A02)', () => {
  it('serviço somente remoto com materials SIM: sem orientação pendente, sem alterar preço', async () => {
    const c = await patientClient();
    const base = form({ need: NEED_OF['CAT-08'], itemCode: 'CAT-08', address: null, location: 'São Paulo' });
    const a = (await c.post('/api/care/requests', base, true)).body.request;
    expect(a.quote.offer.modality).toBe('REMOTO');
    expect(a.guidance.status).toBe('NAO_APLICAVEL');
    expect(a.quote.pending).toBe(false);
    expect(a.status).toBe('ORCADO');
    const price = (await c.get('/api/care/price?itemCode=CAT-08')).body;
    expect(a.quote.totalCents).toBe(price.personal.totalCents);
  });
});
