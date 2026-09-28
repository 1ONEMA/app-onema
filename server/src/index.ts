/** Servidor local/VM: API + PWA compilado. Na Netlify a API roda como Function (netlify/functions/api.ts). */
import { buildApp } from './app.ts';
import { assertProductionConfig, config } from './config.ts';
import { ensureReady } from './bootstrap.ts';

const applied = await ensureReady();
assertProductionConfig();
const app = await buildApp({ serveWeb: true });
await app.listen({ port: config.port, host: config.host });
app.log.info(`ONEMA SAÚDE API em http://${config.host}:${config.port} (${config.appEnv}); migrations aplicadas: ${applied.join(', ') || 'nenhuma nova'}`);
