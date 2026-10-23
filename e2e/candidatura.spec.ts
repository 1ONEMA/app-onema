import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { shot } from './helpers';

/** CPF fictício válido e único por execução (o banco de e2e é compartilhado entre dispositivos). */
function fakeCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const n of [10, 11]) { const s = d.reduce((acc, x, i) => acc + x * (n - i), 0); const r = (s * 10) % 11; d.push(r === 10 ? 0 : r); }
  return d.join('');
}

/** Candidatura ONEMA ONE: cadastro → dados com CPF/COREN → documentos → envio para análise. */
test('candidatura de especialista', async ({ page }, info) => {
  const p = info.project.name;
  const email = `candidata.${p}.${Date.now()}@exemplo.test`;
  await page.goto('/especialista');
  await page.getByRole('link', { name: /Quero ser ONEMA ONE/ }).first().click();
  await expect(page).toHaveURL(/perfil=especialista/);
  await page.getByLabel('Nome completo').fill('Ana Enfermeira Fictícia');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill('SenhaFicticia2026');
  await page.getByLabel('Confirme a senha').fill('SenhaFicticia2026');
  await page.getByRole('button', { name: 'Criar cadastro' }).click();
  await expect(page).toHaveURL(/\/especialista\/candidatura/);
  await expect(page.getByRole('heading', { name: 'Candidatura de especialista' })).toBeVisible();

  await page.getByLabel('Nome completo').fill('Ana Enfermeira Fictícia');
  await page.getByLabel('CPF').fill(fakeCpf());
  await page.getByLabel('Número do COREN').fill('123456');
  await page.getByLabel('Telefone (WhatsApp)').fill('(11) 98888-0000');
  await page.getByLabel('Regiões e bairros em que pode atender').fill('Zona Sul');
  await page.locator('.checks-grid input[type=checkbox]').first().check();
  await page.getByText(/Declaro que as informações são verdadeiras/).click();
  await page.getByRole('button', { name: 'Salvar dados' }).click();
  await expect(page.getByText('Rascunho')).toBeVisible();

  const pdf = { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 documento fictício') };
  const inputs = page.locator('input[type=file]');
  await inputs.nth(0).setInputFiles(pdf);
  await expect(page.getByText('Enviado').first()).toBeVisible();
  await inputs.nth(1).setInputFiles(pdf);
  await expect(page.getByText('Enviado')).toHaveCount(2);
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await page.getByRole('button', { name: 'Enviar para análise' }).click();
  await expect(page.getByText('Em análise')).toBeVisible();
  await shot(page, 'evid-candidatura', p);
});
