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

/** Admin: ativa/verifica TOTP pela própria interface. */
export async function loginAdmin(page: Page, email: string, secrets: Map<string, string>) {
  await login(page, email);
  await page.waitForURL(/\/mfa/);
  if (!secrets.has(email)) {
    await page.getByRole('button', { name: 'Gerar código de configuração' }).click();
    const secret = (await page.locator('p.mono').textContent())!.trim();
    secrets.set(email, secret);
  }
  await page.getByLabel('Código de 6 dígitos').fill(totp(secrets.get(email)!));
  await page.getByRole('button', { name: /Ativar e continuar|Verificar/ }).click();
  await expect(page).toHaveURL(/\/admin/);
}

export async function shot(page: Page, name: string, project: string) {
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}
