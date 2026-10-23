import { expect, test } from '@playwright/test';
import { login, loginAdmin, shot } from './helpers';

/**
 * Jornada "Solicitar cuidado" (Comando de Precificação, seção 5) e evidências de tela para o RT:
 * paciente (valores logo após materiais → onde e quando → revisão → pagamento → comprovante),
 * especialista (oferta com repasse integral) e Central (operação, precificação, conciliação, autoteste).
 */
const secrets = new Map<string, string>();

test('paciente, especialista e Central: jornada completa com evidências', async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'desktop' && info.project.name !== 'mobile', 'fluxo executado em celular e desktop');
  test.setTimeout(240_000);
  const p = info.project.name;
  // Início público no modelo do protótipo
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Sua saúde não\s*precisa esperar/ })).toBeVisible();
  await expect(page.getByText('Café com a ONEMA')).toBeVisible();
  await page.getByRole('button', { name: /Ler mensagem/ }).click();
  await expect(page.getByText('A Ele toda honra e toda glória.')).toBeVisible();
  await shot(page, 'evid-01-inicio', p);

  // Kary
  await page.getByRole('button', { name: /Falar com a Kary/ }).click();
  await page.getByLabel('Mensagem para a Kary').fill('Quanto custa curativo simples?');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText(/Curativo simples: R\$\s309,90/)).toBeVisible();
  await page.getByLabel('Mensagem para a Kary').fill('minha mãe está com falta de ar');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText(/Ligue agora para o SAMU 192/)).toBeVisible();
  await shot(page, 'evid-02-kary', p);
  await page.getByRole('button', { name: 'Fechar a Kary' }).click();

  // Paciente: necessidade → atendimento → materiais → valores (sem login)
  await page.getByRole('link', { name: /Preciso de cuidado/ }).click();
  await page.getByRole('button', { name: /Pós-alta Hospitalar/ }).click();
  await page.getByText('Pós-Alta 14 dias', { exact: true }).click();
  await shot(page, 'evid-03-atendimento', p);
  await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByText('Sim, tenho os materiais').click();
  await page.getByRole('button', { name: /Ver valores do atendimento/ }).click();
  await expect(page.getByText('R$ 729,90').first()).toBeVisible();
  await expect(page.getByText('R$ 709,90')).toBeVisible(); // exemplo com PRIME
  await shot(page, 'evid-04-valores-visitante', p);
  await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByRole('link', { name: 'Entrar' }).last().click();
  await page.getByLabel('E-mail').fill(p === 'mobile' ? 'responsavel.demo@exemplo.test' : 'paciente.demo@exemplo.test');
  await page.getByLabel('Senha').fill('Onema-Demo-2026');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/solicitar/);
  await expect(page.getByRole('heading', { name: 'Onde e quando?' })).toBeVisible();
  await page.getByLabel('Nome do paciente').fill('Maria Fictícia');
  await page.getByLabel('Telefone').fill('(11) 99999-9999');
  await page.getByLabel('Bairro ou CEP').fill(`Vila Mariana ${p}`);
  await shot(page, 'evid-05-onde-e-quando', p);
  await page.getByRole('button', { name: /Revisar solicitação/ }).click();
  await expect(page.getByRole('heading', { name: 'Revise antes de confirmar' })).toBeVisible();
  await expect(page.getByText('Avaliação presencial (inicial e final)').or(page.getByText('Avaliações presenciais inicial e final.'))).toBeVisible();
  await shot(page, 'evid-06-revisao-orcamento', p);
  await page.getByText(/aceito este orçamento/).click();
  await page.getByRole('button', { name: /Ir para o pagamento/ }).click();
  await expect(page.getByRole('button', { name: 'Confirmar e pagar R$ 729,90' })).toBeVisible();
  await shot(page, 'evid-07-pagamento', p);
  await page.getByRole('button', { name: 'Confirmar e pagar R$ 729,90' }).click();
  await expect(page.getByText(/Pagamento confirmado \(simulação\)/)).toBeVisible();
  await expect(page.getByText('Avaliação inicial')).toBeVisible();
  await expect(page.getByText('Avaliação final')).toBeVisible();
  await shot(page, 'evid-08-comprovante', p);
  if (p !== 'desktop') return;

  // Especialista: oferta com repasse integral, aceite e conclusão
  const sctx = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  const sp = await sctx.newPage();
  await login(sp, 'especialista.one.demo@exemplo.test');
  await sp.waitForURL(/academy/);
  await sp.goto('/especialista');
  await expect(sp.getByRole('heading', { name: 'Ofertas disponíveis' })).toBeVisible();
  await expect(sp.getByText('R$ 170,00').first()).toBeVisible();
  await expect(sp.getByText('R$ 50,00').first()).toBeVisible();
  await expect(sp.getByText('R$ 729,90')).toHaveCount(0); // preço ao paciente não aparece
  await shot(sp, 'evid-09-especialista-ofertas', p);
  // aceita e conclui as 4 ofertas deste pedido (identificadas pela região)
  const mineOffer = () => sp.locator('li', { hasText: `Vila Mariana ${p}` }).getByRole('button', { name: 'Aceitar atendimento' });
  for (let n = 4; n > 0; n--) {
    await mineOffer().first().click();
    await expect(mineOffer()).toHaveCount(n - 1);
  }
  for (let i = 0; i < 4; i++) {
    const n = await sp.getByRole('button', { name: 'Registrar conclusão' }).count();
    await sp.getByRole('button', { name: 'Registrar conclusão' }).first().click();
    await expect(sp.getByRole('button', { name: 'Registrar conclusão' })).toHaveCount(n - 1);
  }
  await expect(sp.getByText('Repasse a liquidar').first()).toBeVisible();
  await shot(sp, 'evid-10-especialista-atendimentos', p);
  await sctx.close();

  // Paciente avalia com estrelas
  await page.reload();
  await page.getByRole('radio', { name: '5 estrelas' }).first().click();
  await page.getByRole('button', { name: 'Enviar avaliação' }).first().click();
  await expect(page.getByLabel('Sua avaliação: 5 de 5 estrelas').first()).toBeVisible();

  // Central: Financeiro (MFA) — operação, precificação, conciliação e autoteste
  const cctx = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
  const c = await cctx.newPage();
  await loginAdmin(c, 'financeiro.demo@exemplo.test', secrets);
  await c.goto('/central');
  await expect(c.getByText('Pedidos pagos')).toBeVisible();
  await shot(c, 'evid-11-central-operacao', p);
  await c.getByRole('tab', { name: 'Precificação' }).click();
  await expect(c.getByText('PAC-03')).toBeVisible();
  await shot(c, 'evid-12-central-precificacao', p);
  await c.getByRole('tab', { name: 'Conciliação' }).click();
  await expect(c.getByText('Serviços recebidos')).toBeVisible();
  await shot(c, 'evid-13-central-conciliacao', p);
  await c.getByRole('tab', { name: /Autoteste/ }).click();
  await expect(c.getByText('PASS', { exact: true })).toHaveCount(4);
  await shot(c, 'evid-14-central-autoteste', p);
  await cctx.close();
});
