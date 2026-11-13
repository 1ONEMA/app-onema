import { expect, type Page } from '@playwright/test';
import { totp } from '../server/src/lib/security.ts';

export const PASS = 'Onema-Demo-2026';
export const SHOTS = process.env.SHOTS_DIR ?? 'test-results/shots';

export async function login(page: Page, email: string, password = PASS) {
  await page.goto('/entrar');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

const lastUse = new Map<string, number>();

/** Admin: ativa/verifica TOTP pela própria interface. */
export async function loginAdmin(page: Page, email: string, secrets: Map<string, string>) {
  await login(page, email);
  await page.waitForURL(/\/mfa/);
  if (!secrets.has(email)) {
    await page.getByRole('button', { name: 'Gerar código de configuração' }).click();
    const secret = (await page.locator('p.mono').textContent())!.trim();
    secrets.set(email, secret);
  }
  // O servidor recusa reutilizar um código: cada login da mesma conta usa uma janela de 30 s nova.
  const t = Math.max(Date.now(), (lastUse.get(email) ?? 0) + 30_000);
  if (t - Date.now() > 30_000) await page.waitForTimeout(t - Date.now() - 25_000);
  lastUse.set(email, t);
  await page.getByLabel('Código de 6 dígitos').fill(totp(secrets.get(email)!, t));
  await page.getByRole('button', { name: /Ativar e continuar|Verificar/ }).click();
  await expect(page).toHaveURL(/\/(admin|central)/);
}

export async function shot(page: Page, name: string, project: string) {
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}

/** Área de atendimento: na primeira entrada em /solicitar, informa um CEP da cidade de São Paulo. */
export async function passCoverage(page: Page, cep = '04101-000') {
  const dlg = page.getByRole('dialog', { name: 'Onde será o atendimento?' });
  if (await dlg.isVisible().catch(() => false) || await dlg.waitFor({ timeout: 1500 }).then(() => true).catch(() => false)) {
    await dlg.getByLabel('CEP do atendimento').fill(cep);
    await dlg.getByRole('button', { name: 'Continuar' }).click();
    await expect(dlg).toBeHidden();
  }
}
