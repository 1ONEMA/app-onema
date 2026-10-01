import { expect, test, type Page } from '@playwright/test';
import { login, shot } from './helpers.ts';

/** ACA-T033: sem rolagem horizontal da página e navegação visível em celular, tablet e desktop. */
async function noHorizontalScroll(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${url} rola na horizontal (${over}px)`).toBeLessThanOrEqual(1);
}

test('paciente e especialista sem rolagem horizontal', async ({ page }, info) => {
  await login(page, 'paciente.demo@exemplo.test');
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  for (const u of ['/minha-onema', '/prime', '/prime/adesao', '/servicos', '/conta']) await noHorizontalScroll(page, u);
  await shot(page, 'responsivo-paciente', info.project.name);
  await page.context().clearCookies();
  await login(page, 'especialista.demo@exemplo.test');
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  for (const u of ['/academy', '/academy/cursos/C01', '/academy/historico']) await noHorizontalScroll(page, u);
  await shot(page, 'responsivo-academy', info.project.name);
});
