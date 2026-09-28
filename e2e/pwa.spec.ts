import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('PWA: manifest, service worker sem cache de API e comportamento offline', async ({ page, context }, info) => {
  test.skip(info.project.name !== 'desktop');
  const m = await (await page.request.get('/manifest.webmanifest')).json();
  expect(m.name).toBe('ONEMA SAÚDE');
  expect(m.display).toBe('standalone');
  expect(m.icons.some((i: any) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
  for (const i of m.icons) expect((await page.request.get(i.src)).status()).toBe(200);

  await login(page, 'paciente.demo@exemplo.test');
  await expect(page).toHaveURL(/minha-onema/);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 15000 });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached: string[] = await page.evaluate(async () => {
    const out: string[] = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
    return out;
  });
  expect(cached.length).toBeGreaterThan(3);
  expect(cached.some((p) => p.startsWith('/api/'))).toBe(false);

  await context.setOffline(true);
  await page.goto('/minha-onema').catch(() => {});
  await expect(page.getByText(/sem conexão/i).first()).toBeVisible();
  await context.setOffline(false);
});
