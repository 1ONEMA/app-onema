import { expect, test } from '@playwright/test';
import { login, loginAdmin, shot } from './helpers';

/** Telenfermagem (homologação): Central/RT cria e triagem → paciente consente → enfermeira aceita, agenda, atende, registra e conclui → Carteira. */
const secrets = new Map<string, string>();

test('telenfermagem: jornada completa em homologação', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'fluxo executado no desktop');
  test.setTimeout(180_000);
  const p = info.project.name;

  const rt = await (await browser.newContext()).newPage();
  await loginAdmin(rt, 'operador.demo@exemplo.test', secrets);
  await rt.goto('/admin/telenfermagem');
  await expect(rt.getByText('Telenfermagem em homologação.')).toBeVisible();
  await rt.getByLabel('E-mail do paciente').fill('paciente.demo@exemplo.test');
  await rt.getByLabel('Justificativa').fill('Consulta remota de teste para homologação do fluxo.');
  await rt.getByRole('button', { name: 'Criar' }).click();
  await rt.getByRole('button', { name: /Consulta de Enfermagem remota · Paciente Demonstração/ }).first().click();
  await rt.getByLabel('Decisão de elegibilidade (motivo)').fill('Elegível pelo protocolo de homologação.');
  await rt.getByRole('button', { name: 'Elegível', exact: true }).click();
  await expect(rt.getByText('Aguardando consentimento').first()).toBeVisible();

  const pt = await (await browser.newContext()).newPage();
  await login(pt, 'paciente.demo@exemplo.test');
  await pt.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  await pt.goto('/telenfermagem');
  await pt.getByRole('link', { name: 'Consulta de Enfermagem remota' }).first().click();
  await expect(pt.getByText(/Valor: R\$/)).toBeVisible();
  await pt.getByLabel(/Li e concordo com o atendimento remoto/).check();
  await pt.getByRole('button', { name: 'Confirmar' }).click();
  await expect(pt.getByText('Procurando enfermeira')).toBeVisible();
  await shot(pt, 'tele-01-paciente-consentimento', p);

  const sp = await (await browser.newContext()).newPage();
  await login(sp, 'especialista.one.demo@exemplo.test');
  await sp.waitForURL((u) => !u.pathname.startsWith('/entrar'));
  await sp.goto('/especialista/telenfermagem');
  await sp.getByRole('button', { name: 'Aceitar' }).first().click();
  await sp.getByRole('link', { name: /Consulta de Enfermagem remota · Paciente Demonstração/ }).first().click();
  // Horário local do navegador (America/Sao_Paulo), 5 minutos à frente.
  const soon = new Date(Date.now() + 5 * 60_000).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16).replace(' ', 'T');
  await sp.getByLabel('Data e hora').fill(soon);
  await sp.getByRole('button', { name: 'Salvar horário' }).click();
  await sp.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(sp.getByText(/Sala simulada/)).toBeVisible();
  await expect(sp.getByText('Em atendimento')).toBeVisible();
  await shot(sp, 'tele-02-sala', p);
  await sp.getByRole('button', { name: 'Encerrar chamada' }).click();
  await expect(sp.getByText('Aguardando registro')).toBeVisible();
  await sp.getByLabel('Relato', { exact: true }).fill('Paciente refere boa adaptação ao curativo, sem dor.');
  await sp.getByLabel('Orientações', { exact: true }).fill('Manter curativo seco; procurar a Central se houver febre.');
  await sp.getByLabel(/Revisei o registro/).check();
  await sp.getByRole('button', { name: 'Assinar registro' }).click();
  await sp.getByRole('button', { name: 'Concluir teleatendimento' }).click();
  await expect(sp.getByText('Concluído')).toBeVisible();
  await shot(sp, 'tele-03-concluido', p);

  await pt.goto('/carteira');
  await expect(pt.getByRole('heading', { name: /Teleatendimentos/ })).toBeVisible();
  await pt.getByText('Consulta de Enfermagem remota').first().click();
  await expect(pt.getByText('Paciente refere boa adaptação ao curativo, sem dor.')).toBeVisible();
  await shot(pt, 'tele-04-carteira', p);
});
