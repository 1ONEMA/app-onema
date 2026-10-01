import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { hashPassword } from '../lib/security.ts';
import { passwordSchema } from '../modules/auth/routes.ts';
import { ROLES, type Role } from '../lib/roles.ts';
import { nowIso, randomToken, uid } from '../lib/util.ts';
import { runBilling } from '../modules/prime/core.ts';
import { all, databaseUrl, getDriver, one, run, tx } from './db.ts';
import { migrate } from './migrate.ts';
import { seedDemo, seedOfficial } from './seed.ts';

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'migrate':
    console.log('Migrations aplicadas:', await migrate());
    break;
  case 'seed':
    await migrate();
    console.log('Seed oficial:', await seedOfficial());
    break;
  case 'seed-demo': {
    await migrate();
    const r = await seedDemo();
    console.log('Usuários de demonstração (fictícios):', r.users.join(', '));
    console.log('Senha de demonstração:', r.password);
    break;
  }
  case 'backup': {
    // Backup lógico compactado (mesmo formato do backup diário automático). Em Postgres gerenciado, use também pg_dump.
    const { compress, exportDatabase } = await import('../lib/backup.ts');
    const dir = path.resolve(args[0] ?? 'data/backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dump = await exportDatabase();
    const file = path.join(dir, `onema-${dump.exportedAt.replace(/[:.]/g, '-')}.json.gz`);
    fs.writeFileSync(file, compress(dump), { mode: 0o600 });
    console.log('Backup lógico gerado:', file, `(${Object.keys(dump.tables).length} tabelas).`);
    break;
  }
  case 'restore': {
    // Restauração destrutiva: substitui os dados atuais. Exige --confirmar e faz um backup de segurança antes.
    const { compress, decompress, exportDatabase, restoreDatabase } = await import('../lib/backup.ts');
    const file = args.find((a) => !a.startsWith('--'));
    if (!file || !args.includes('--confirmar')) {
      console.error('Uso: npm run db:restore -- <arquivo.json.gz> --confirmar   (substitui TODOS os dados atuais do banco)');
      process.exitCode = 1; break;
    }
    await migrate();
    const safety = path.resolve('data/backups', `antes-da-restauracao-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
    fs.mkdirSync(path.dirname(safety), { recursive: true, mode: 0o700 });
    fs.writeFileSync(safety, compress(await exportDatabase()), { mode: 0o600 });
    console.log('Backup de segurança do estado atual:', safety);
    const raw = fs.readFileSync(path.resolve(file));
    const r = await restoreDatabase(file.endsWith('.gz') ? decompress(raw) : JSON.parse(raw.toString('utf8')));
    console.log(`Restauração concluída: ${r.tables} tabelas, ${r.rows} linhas. Sessões foram encerradas; todos precisam entrar novamente.`);
    break;
  }
  case 'create-user': {
    // Uso: npm run user:create -- email@dominio "Nome" ROLE1,ROLE2
    await migrate();
    const [email, name, roles] = args;
    if (!email || !name || !roles) { console.error('Uso: npm run user:create -- <email> "<nome>" <ROLE1,ROLE2>'); process.exit(1); }
    const list = roles.split(',') as Role[];
    for (const r of list) if (!ROLES.includes(r)) { console.error('Perfil inválido:', r); process.exit(1); }
    // Senha definida pelo responsável via variável de ambiente (nunca versionada); sem ela, gera temporária.
    const chosen = process.env.NEW_USER_PASSWORD;
    if (chosen !== undefined) {
      const ok = passwordSchema.safeParse(chosen);
      if (!ok.success) { console.error('Senha inválida:', ok.error.issues.map((i) => i.message).join(' ')); process.exit(1); }
    }
    const password = chosen ?? `${randomToken(12)}7a`;
    await tx(async () => {
      if (await one('SELECT 1 FROM users WHERE email = ?', email.toLowerCase())) throw new Error('E-mail já cadastrado.');
      const id = uid(), now = nowIso();
      await run('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, email.toLowerCase(), name, hashPassword(password), now, now);
      for (const r of list) await run('INSERT INTO user_roles (user_id, role, granted_at) VALUES (?,?,?)', id, r, now);
    });
    console.log(chosen !== undefined ? 'Usuário criado com a senha informada em NEW_USER_PASSWORD.' : `Usuário criado. Senha temporária (exibida uma única vez): ${password}`);
    break;
  }
  case 'billing':
    await migrate();
    console.log('Motor de ciclos PRIME:', await tx(async () => await runBilling()));
    break;
  default:
    console.log('Comandos: migrate | seed | seed-demo | backup [dir] | restore <arquivo> --confirmar | create-user <email> "<nome>" <ROLES> | billing');
}

await (await getDriver()).close();
