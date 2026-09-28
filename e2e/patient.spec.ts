import { expect, test } from '@playwright/test';
import { PASS, shot } from './helpers';

test('paciente: cadastro, adesão PRIME, checkout com desconto, preferências, responsável e cancelamento', async ({ page }, info) => {
  const email = `e2e.${info.project.name}.${Date.now()}@exemplo.test`;
  await page.goto('/cadastro');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Nome completo').fill('Paciente E2E Fictício');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill('SenhaE2E2026x');
  await page.getByLabel('Confirme a senha').fill('SenhaE2E2026x');
  await page.getByRole('button', { name: 'Criar cadastro' }).click();
  await expect(page).toHaveURL(/minha-onema/);
  await expect(page.getByText('Nenhum evento registrado ainda.')).toBeVisible();
  await shot(page, 'minha-onema-vazio', info.project.name);

  await page.goto('/prime');
  await expect(page.getByText('R$ 34,90')).toBeVisible();
  await shot(page, 'prime-oferta', info.project.name);
  await page.getByRole('link', { name: 'Conhecer e assinar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira antes de assinar' })).toBeVisible();
  // nada pré-marcado; confirmação bloqueada sem aceite
  const boxes = page.locator('input[type=checkbox]');
  for (const b of await boxes.all()) expect(await b.isChecked()).toBe(false);
  const confirm = page.getByRole('button', { name: 'Confirmar assinatura' });
  await expect(confirm).toBeDisabled();
  await page.getByText(/Li os Termos ONEMA PRIME/).click();
  await page.getByText('pagamento aprovado').click();
  await shot(page, 'prime-adesao', info.project.name);
  await confirm.click();
  await expect(page.getByText(/Seu ONEMA PRIME foi ativado/)).toBeVisible();
  await page.getByRole('link', { name: 'Ir para a Central PRIME' }).click();
  await expect(page.getByText('PRIME ativo')).toBeVisible();
  await page.reload(); // persistência
  await expect(page.getByText('PRIME ativo')).toBeVisible();
  await shot(page, 'prime-central', info.project.name);

  await page.goto('/servicos');
  await page.locator('li', { hasText: 'Pacote de demonstração' }).getByRole('button', { name: 'Selecionar' }).click();
  await expect(page.getByText('− R$ 20,00')).toBeVisible();
  await expect(page.getByText('R$ 709,90').first()).toBeVisible();
  await page.getByLabel('Meio de pagamento').selectOption('SANDBOX_APROVADO');
  await page.getByRole('button', { name: /Confirmar e pagar/ }).click();
  await expect(page.getByText(/pagamento confirmado \(simulação\)/)).toBeVisible();
  await page.locator('li', { hasText: 'Serviço de demonstração A' }).getByRole('button', { name: 'Selecionar' }).click();
  await expect(page.getByText('O desconto PRIME já foi usado neste ciclo')).toBeVisible();
  await shot(page, 'servicos', info.project.name);

  await page.goto('/prime/preferencias');
  await page.getByText('Resumo mensal', { exact: true }).click();
  await page.getByRole('button', { name: 'Salvar preferências' }).click();
  await expect(page.getByText(/Preferências salvas/)).toBeVisible();
  await expect(page.locator('#RESUMO_MENSAL-wa')).toBeDisabled();

  await page.goto('/prime/responsavel');
  await page.getByLabel('Nome da pessoa').fill('Responsável Fictício');
  await page.getByLabel('E-mail da pessoa').fill('responsavel.demo@exemplo.test');
  await page.getByText('Pode ver agenda').click();
  await expect(page.getByRole('button', { name: 'Enviar convite' })).toBeDisabled();
  await page.getByText(/Quero convidar esta pessoa/).click();
  await page.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(page.getByText(/Convite registrado/)).toBeVisible();
  await shot(page, 'responsavel', info.project.name);

  await page.goto('/prime/assinatura');
  await page.getByRole('button', { name: 'Cancelar assinatura' }).click();
  await page.getByRole('button', { name: 'Confirmar cancelamento' }).click();
  await expect(page.getByText(/Recebemos seu cancelamento do ONEMA PRIME/).first()).toBeVisible();
  await expect(page.getByText('Cancelamento agendado')).toBeVisible();

  await page.goto('/minha-onema');
  await expect(page.getByText('ONEMA PRIME ativado')).toBeVisible();
  await shot(page, 'minha-onema', info.project.name);
  expect(PASS).toBeTruthy();
});
