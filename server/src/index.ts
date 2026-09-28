import { buildApp } from './app.ts';
import { assertProductionConfig, config } from './config.ts';
import { getDb } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { seedOfficial } from './db/seed.ts';

assertProductionConfig();
const db = getDb();
const applied = migrate(db);
seedOfficial();
const app = await buildApp({ serveWeb: true });
await app.listen({ port: config.port, host: config.host });
app.log.info(`ONEMA SAÚDE API em http://${config.host}:${config.port} (${config.env}); migrations aplicadas: ${applied.join(', ') || 'nenhuma nova'}`);
