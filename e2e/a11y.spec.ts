import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login, loginAdmin } from './helpers.ts';

/** Acessibilidade automatizada (axe-core, WCAG 2.0/2.1 A e AA) nas telas principais. Não substitui auditoria manual. */
const secrets = new Map<string, string>();

async function check(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const issues = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(issues, `${url}\n${issues.join('\n')}`).toEqual([]);
}

test('telas públicas', async ({ page }) => {
  for (const u of ['/entrar', '/cadastro', '/esqueci-senha', '/verificar']) await check(page, u);
});

test('paciente', async ({ page }) => {
  await login(page, 'paciente.demo@exemplo.test');
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  for (const u of ['/minha-onema', '/prime', '/prime/adesao', '/servicos', '/avisos', '/conta', '/convites']) await check(page, u);
});

test('especialista', async ({ page }) => {
  await login(page, 'especialista.demo@exemplo.test');
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  for (const u of ['/academy', '/academy/cursos/C01', '/academy/historico', '/academy/certificados']) await check(page, u);
});

// Uma conta administrativa por dispositivo (o MFA de cada conta é ativado uma única vez nesta execução).
const ADMIN_BY_PROJECT: Record<string, [string, string[]]> = {
  mobile: ['admin.academy.demo@exemplo.test', ['/admin', '/admin/conteudo', '/admin/midia', '/admin/usuarios', '/admin/backups', '/admin/relatorios']],
  desktop: ['admin.prime.demo@exemplo.test', ['/admin', '/admin/prime', '/admin/usuarios', '/admin/backups', '/admin/auditoria', '/admin/financeiro']],
  tablet: ['auditor.demo@exemplo.test', ['/admin', '/admin/conteudo', '/admin/certificados', '/admin/credenciamento', '/admin/auditoria', '/admin/relatorios']],
};

test('gestão', async ({ page }, info) => {
  const [email, pages] = ADMIN_BY_PROJECT[info.project.name];
  await loginAdmin(page, email, secrets);
  for (const u of pages) await check(page, u);
});
