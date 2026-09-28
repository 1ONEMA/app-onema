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
    // Exportação lógica (JSON por tabela). Em Postgres gerenciado, prefira também os backups/branches do provedor ou pg_dump.
    const dir = path.resolve(args[0] ?? 'data/backups');
    fs.mkdirSync(dir, { recursive: true });
    const tables = (await all<any>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`)).map((t) => t.table_name);
    const dump: Record<string, unknown[]> = {};
    for (const t of tables) dump[t] = await all(`SELECT * FROM "${t}"`);
    const file = path.join(dir, `onema-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ exportedAt: new Date().toISOString(), database: databaseUrl() ? 'postgres' : 'pglite', tables: dump }), { mode: 0o600 });
    console.log('Backup lógico gerado:', file, `(${tables.length} tabelas). Use pg_dump para backup físico do Postgres.`);
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
    console.log('Comandos: migrate | seed | seed-demo | backup [dir] | create-user <email> "<nome>" <ROLES> | billing');
}

await (await getDriver()).close();
