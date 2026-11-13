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
});
