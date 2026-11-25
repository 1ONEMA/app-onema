import { expect, test } from '@playwright/test';
import { login, loginAdmin, shot } from './helpers';

/** Validação de parceiros (fila do RT) e Carteira Digital (plano + central de alertas): telas carregam e operam. */
const secrets = new Map<string, string>();

test('validação de parceiros, plano de cuidados e central de alertas', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'executado no desktop');
  const p = info.project.name;
  const adm = await (await browser.newContext()).newPage();
  await loginAdmin(adm, 'credenciamento.demo@exemplo.test', secrets);
  await adm.goto('/admin/parceiros');
  await expect(adm.getByRole('heading', { name: 'Validação de parceiros' })).toBeVisible();
  await expect(adm.getByRole('link', { name: /COFEN/ })).toBeVisible();
  await shot(adm, 'parceiros-fila', p);

  const pt = await (await browser.newContext()).newPage();
  await login(pt, 'paciente.demo@exemplo.test');
  await pt.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  await pt.goto('/carteira');
  await expect(pt.getByRole('heading', { name: 'Plano de cuidados' })).toBeVisible();
  await expect(pt.getByText(/não substituem atendimento de urgência/)).toBeVisible();
  // A04: atendimentos, plano e evoluções em cards recolhidos; listagens em painel próprio
  await expect(pt.getByRole('button', { name: /Ver atendimentos/ })).toBeVisible();
  await pt.getByRole('button', { name: /Ver evoluções/ }).click();
  await expect(pt.getByRole('dialog', { name: 'Evoluções de enfermagem' })).toBeVisible();
  await pt.getByRole('button', { name: 'Fechar' }).click();
  await pt.getByRole('button', { name: /Ver histórico de lembretes/ }).click();
  await expect(pt.getByRole('dialog', { name: 'Histórico de lembretes' })).toBeVisible();
  await shot(pt, 'carteira-historico-lembretes', p);
  await pt.getByRole('button', { name: 'Fechar' }).click();
  await expect(pt.getByRole('heading', { name: 'Teleatendimentos' })).toBeVisible();
});
