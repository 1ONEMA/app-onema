import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client, emailOf, one, setup } from './helpers.ts';

let app: FastifyInstance;
beforeEach(async () => { app = await setup(); });
afterEach(() => { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM; vi.unstubAllGlobals(); });

describe('E-mail transacional (opcional)', () => {
  it('sem provedor: nada é enviado e a mensagem fica registrada como não enviada', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    const r = await new Client(app).req('POST', '/api/auth/forgot', { email: emailOf('paciente') });
    expect(r.status).toBe(202);
    expect(r.body.emailDeliveryConfigured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await one<any>(`SELECT status FROM outbox_messages WHERE template = 'PASSWORD_RESET'`)).status).toBe('NAO_ENVIADO_SEM_PROVEDOR');
  });

  it('com provedor: envia o link de redefinição (sem dados de saúde) e registra ENVIADO', async () => {
    process.env.RESEND_API_KEY = 're_teste'; process.env.EMAIL_FROM = 'ONEMA <nao-responda@exemplo.test>';
    const fetchSpy = vi.fn(async () => new Response('{"id":"x"}', { status: 200 })); vi.stubGlobal('fetch', fetchSpy);
    const r = await new Client(app).req('POST', '/api/auth/forgot', { email: emailOf('paciente') });
    expect(r.body.emailDeliveryConfigured).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as any;
    expect(url).toBe('https://api.resend.com/emails');
    const payload = JSON.parse(init.body);
    expect(payload.to).toEqual([emailOf('paciente')]);
    expect(payload.text).toContain(`/redefinir-senha?token=${r.headers['x-test-reset-token']}`);
    expect((await one<any>(`SELECT status FROM outbox_messages WHERE template = 'PASSWORD_RESET'`)).status).toBe('ENVIADO');
    // e-mail inexistente: nenhuma chamada (sem enumeração de contas)
    await new Client(app).req('POST', '/api/auth/forgot', { email: 'ninguem@exemplo.test' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falha do provedor não quebra o fluxo e fica registrada', async () => {
    process.env.RESEND_API_KEY = 're_teste'; process.env.EMAIL_FROM = 'x@exemplo.test';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('erro', { status: 500 })));
    expect((await new Client(app).req('POST', '/api/auth/forgot', { email: emailOf('paciente') })).status).toBe(202);
    expect((await one<any>(`SELECT status FROM outbox_messages WHERE template = 'PASSWORD_RESET'`)).status).toBe('FALHA_HTTP_500');
  });
});
