import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import { hashPassword } from '../lib/security.ts';
import { ROLES, type Role } from '../lib/roles.ts';
import { nowIso, randomToken, uid } from '../lib/util.ts';
import { runBilling } from '../modules/prime/core.ts';
import { getDb, one, run, tx } from './db.ts';
import { migrate } from './migrate.ts';
import { seedDemo, seedOfficial } from './seed.ts';

const [cmd, ...args] = process.argv.slice(2);
const db = getDb();

switch (cmd) {
  case 'migrate':
    console.log('Migrations aplicadas:', migrate(db));
    break;
  case 'seed':
    migrate(db);
    console.log('Seed oficial:', seedOfficial());
    break;
  case 'seed-demo': {
    migrate(db);
    const r = seedDemo();
    console.log('Usuários de demonstração (fictícios):', r.users.join(', '));
    console.log('Senha de demonstração:', r.password);
    break;
  }
  case 'backup': {
    // Cópia consistente do SQLite (VACUUM INTO) - inclui auditoria, versões, tentativas e certificados.
    const dir = path.resolve(args[0] ?? 'data/backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `onema-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log('Backup gerado:', file, '| Mídia privada em', config.mediaDir, '(copiar junto).');
    break;
  }
  case 'create-user': {
    // Uso: npm run user:create -- email@dominio "Nome" ROLE1,ROLE2
    migrate(db);
    const [email, name, roles] = args;
    if (!email || !name || !roles) { console.error('Uso: npm run user:create -- <email> "<nome>" <ROLE1,ROLE2>'); process.exit(1); }
    const list = roles.split(',') as Role[];
    for (const r of list) if (!ROLES.includes(r)) { console.error('Perfil inválido:', r); process.exit(1); }
    const password = `${randomToken(12)}7a`;
    tx(() => {
      if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new Error('E-mail já cadastrado.');
      const id = uid(), now = nowIso();
      run('INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?)', id, email.toLowerCase(), name, hashPassword(password), now, now);
      for (const r of list) run('INSERT INTO user_roles (user_id, role, granted_at) VALUES (?,?,?)', id, r, now);
    });
    console.log(`Usuário criado. Senha temporária (exibida uma única vez): ${password}`);
    break;
  }
  case 'billing':
    migrate(db);
    console.log('Motor de ciclos PRIME:', tx(() => runBilling()));
    break;
  default:
    console.log('Comandos: migrate | seed | seed-demo | backup [dir] | create-user <email> "<nome>" <ROLES> | billing');
}
