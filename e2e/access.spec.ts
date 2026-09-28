import { expect, test } from '@playwright/test';
import { login, loginAdmin, shot } from './helpers';

const secrets = new Map<string, string>();

test('rotas protegidas, acesso direto e perfis', async ({ page }, info) => {
  await page.goto('/prime/assinatura');
  await expect(page).toHaveURL(/\/entrar\?voltar=%2Fprime%2Fassinatura/);
  await shot(page, 'login', info.project.name);
  await page.getByLabel('E-mail').fill('paciente.demo@exemplo.test');
  await page.getByLabel('Senha').fill('Onema-Demo-2026');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/prime\/assinatura/);
  await page.goto('/academy');
  await expect(page.getByText('Acesso não permitido')).toBeVisible();
  await page.goto('/rota-inexistente');
  await expect(page.getByText('Página não encontrada')).toBeVisible();
  const r = await page.request.get('/api/admin/users');
  expect(r.status()).toBe(403);
});

test('admin: MFA obrigatório e gestão de conteúdo com pendências explícitas', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'MFA configurado uma única vez');
  await loginAdmin(page, 'rt.demo@exemplo.test', secrets);
  await shot(page, 'admin-painel', info.project.name);
  await page.goto('/admin/conteudo');
  await expect(page.getByRole('heading', { name: /C02 · Segurança do Paciente/ })).toBeVisible();
  await page.getByRole('link', { name: 'Abrir' }).nth(3).click();
  await expect(page.getByText(/Avaliação v1/).or(page.getByText('Avaliações'))).toBeVisible();
  await shot(page, 'admin-versao', info.project.name);
  await page.goto('/admin/auditoria');
  await expect(page.getByText(/eventos/)).toBeVisible();
  await shot(page, 'admin-auditoria', info.project.name);
  const logout = await page.request.post('/api/auth/logout', { headers: { origin: 'https://malicioso.example' } });
  expect(logout.status()).toBe(403);
});

test('verificação pública de certificado inexistente', async ({ page }, info) => {
  await page.goto('/verificar/ONM-0000-0000');
  await expect(page.getByText('Nenhum certificado encontrado com este código.')).toBeVisible();
  await shot(page, 'verificar', info.project.name);
});
