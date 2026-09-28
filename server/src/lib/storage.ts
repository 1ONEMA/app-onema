/**
 * Armazenamento privado de mídia da Academy.
 *  - Netlify: Netlify Blobs (store "academy-media"), nunca público; servido pela API com URL assinada.
 *  - Local/testes: diretório MEDIA_DIR.
 * Limite prático na Netlify: ~6 MB por requisição de Function (vídeos maiores exigem storage externo com URL assinada — ver docs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

const onNetlify = () => !!(process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY || process.env.SITE_ID);

async function blobStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'academy-media', consistency: 'strong' });
}

export async function putObject(key: string, data: Buffer) {
  if (onNetlify()) {
    const s = await blobStore();
    await s.set(key, new Uint8Array(data).buffer as ArrayBuffer);
    return;
  }
  fs.mkdirSync(config.mediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.mediaDir, key), data, { mode: 0o600 });
}

export async function getObject(key: string): Promise<Buffer | null> {
  if (onNetlify()) {
    const s = await blobStore();
    const v = await s.get(key, { type: 'arrayBuffer' });
    return v ? Buffer.from(v) : null;
  }
  const f = path.join(config.mediaDir, key);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}

/** Apenas para testes: altera o conteúdo armazenado (simula adulteração). */
export async function overwriteObjectForTest(key: string, data: Buffer) { await putObject(key, data); }
