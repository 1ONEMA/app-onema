import { test, expect } from '@playwright/test';
import { loginAdmin } from './helpers';
import fs from 'node:fs';

/** Envio em lote dos vídeos das aulas: arquivos sem extensão (baixados do Drive) e nomes sem número de aula. */
test('envio em lote dos vídeos das aulas', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop');
  await loginAdmin(page, 'gestor.demo@exemplo.test', new Map());
  await page.goto('/admin/conteudo/videos');
  await expect(page.getByRole('heading', { name: /C01 · / })).toBeVisible();
  const dir = `test-results/academy-videos-${Date.now()}`; fs.mkdirSync(dir, { recursive: true });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200)]);
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(200)]);
  fs.writeFileSync(`${dir}/1`, mp4); fs.writeFileSync(`${dir}/PMG INTRO.mp4`, mp4); fs.writeFileSync(`${dir}/AULA 2.mov`, mov);
  await page.locator('input[type=file]').first().setInputFiles([`${dir}/1`, `${dir}/PMG INTRO.mp4`, `${dir}/AULA 2.mov`]);
  const sec = page.locator('section.surface').first();
  await expect(sec.getByLabel('Aula do vídeo 1.mp4')).toHaveValue(/.+/);
  await expect(sec).toContainText(/PMG INTRO\.mp4 \(0 MB\) →.*sem aula escolhida/);
  // escolher a aula manualmente e remover um vídeo antes de enviar
  await sec.getByLabel('Aula do vídeo PMG INTRO.mp4').selectOption({ index: 2 });
  await expect(sec.getByRole('button', { name: /Enviar e mandar para o RT \(2 vídeos\)/ })).toBeEnabled();
  await sec.getByRole('button', { name: 'Remover PMG INTRO.mp4' }).click();
  await expect(sec.getByRole('button', { name: /Enviar e mandar para o RT \(1 vídeo\)/ })).toBeEnabled();
  await expect(sec).toContainText(/AULA 2\.mov: vídeo \.MOV/);
  await sec.getByRole('button', { name: /Enviar e mandar para o RT/ }).click();
  await expect(sec.getByText(/Vídeos enviados e versão enviada para o RT/)).toBeVisible({ timeout: 30_000 });
  await expect(sec.getByText('Em revisão do RT')).toBeVisible();
});
