import { expect, test } from '@playwright/test';
import { login, shot } from './helpers';

test('especialista: pagamento sandbox, matrícula, aulas, atividade e avaliação C01', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'fluxo com dados compartilhados executado uma vez');
  await login(page, 'especialista.demo@exemplo.test');
  await expect(page).toHaveURL(/academy/);
  await shot(page, 'academy-entrada', info.project.name);
  await page.getByRole('button', { name: /Gerar pedido de R\$ 19,90/ }).click();
  await page.getByRole('button', { name: 'Simular pagamento aprovado' }).click();
  await page.getByRole('button', { name: 'Iniciar Jornada de Integração' }).click();
  await expect(page.getByText('0 de 4 cursos aprovados')).toBeVisible();
  await shot(page, 'academy-jornada', info.project.name);

  for (const code of ['C01-A01', 'C01-A02', 'C01-A03', 'C01-A04']) {
    await page.goto(`/academy/aulas/${code}`);
    await page.mouse.wheel(0, 3000);
    const btn = page.getByRole('button', { name: 'Marcar como concluída' });
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect(page.getByText('Aula concluída e registrada.')).toBeVisible();
  }
  await shot(page, 'academy-aula', info.project.name);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Aula concluída' })).toBeDisabled();

  await page.goto('/academy/cursos/C01/atividade');
  await page.getByRole('button', { name: 'Iniciar atividade' }).click();
  for (let i = 1; i <= 6; i++) {
    const step = page.locator('section', { hasText: `Decisão ${i}` }).first();
    await step.getByText('Opção incorreta (demonstração)', { exact: true }).click();
    await step.getByRole('button', { name: 'Confirmar decisão' }).click();
    await expect(step.getByText(/não é a opção esperada/)).toBeVisible();
    await step.getByText('Opção correta (demonstração)', { exact: true }).click();
    await step.getByRole('button', { name: 'Confirmar decisão' }).click();
    await expect(step.getByText('Correta', { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Atividade concluída')).toBeVisible();
  await shot(page, 'academy-atividade', info.project.name);

  await page.goto('/academy/cursos/C01');
  await expect(page.getByText('Aguardando avaliação')).toBeVisible();
  await shot(page, 'academy-curso', info.project.name);
  await page.getByRole('button', { name: 'Iniciar avaliação' }).click();
  await expect(page).toHaveURL(/avaliacoes/);
  const qs = page.locator('fieldset.surface');
  await expect(qs).toHaveCount(12);
  for (const q of await qs.all()) await q.getByRole('radio', { name: 'Resposta esperada (demonstração)' }).check();
  await shot(page, 'academy-avaliacao', info.project.name);
  // ACA-T034: a resposta do envio se perde na rede (o servidor processou). O aplicativo não declara aprovação
  // localmente; a nova tentativa reaproveita a mesma chave de operação e recebe o resultado já registrado.
  let dropped = false;
  await page.route('**/api/academy/assessment-attempts/*/submit', async (route) => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: 'Enviar respostas' }).click();
  await page.getByRole('button', { name: 'Confirmar envio' }).click();
  await expect(page.getByText(/Sem conexão com o servidor/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Aprovado' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Enviar respostas' }).click();
  await page.getByRole('button', { name: 'Confirmar envio' }).click();
  await expect(page.getByText('12/12 acertos')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Aprovado' })).toBeVisible();
  await shot(page, 'academy-resultado', info.project.name);
  await page.goto('/academy');
  await expect(page.getByText('1 de 4 cursos aprovados')).toBeVisible();
  await expect(page.getByText(/Avaliação pendente de definição institucional/).first()).toBeVisible();
  await page.goto('/academy/historico');
  await expect(page.getByText(/tentativa 1 — Aprovada/)).toBeVisible();
  await expect(page.getByText(/tentativa 2/)).toHaveCount(0);
});
