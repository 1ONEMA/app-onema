import { api } from './api';

const MIME_BY_EXT: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', vtt: 'text/vtt', txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** Envio em partes: SHA-256 calculado no navegador de forma incremental; partes enviadas em paralelo com novas tentativas. */
export async function uploadInParts(file: File, meta: { kind: string; title: string; expectedChecksum: string }, onProgress: (label: string, pct: number) => void) {
  const { createSHA256 } = await import('hash-wasm');
  const hasher = await createSHA256(); hasher.init();
  const step = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += step) {
    hasher.update(new Uint8Array(await file.slice(off, off + step).arrayBuffer()));
    onProgress('Calculando verificação de integridade', Math.round((Math.min(off + step, file.size) / file.size) * 100));
  }
  const checksum = hasher.digest('hex');
  const mime = file.type || MIME_BY_EXT[file.name.split('.').pop()?.toLowerCase() ?? ''] || '';
  const up = await api<any>('POST', '/api/admin/academy/media/uploads', { kind: meta.kind, title: meta.title, filename: file.name, mime, size: file.size, checksum, expectedChecksum: meta.expectedChecksum });
  let done = 0;
  const queue = Array.from({ length: up.chunkCount }, (_, n) => n);
  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      const part = file.slice(n * up.chunkSize, (n + 1) * up.chunkSize);
      for (let attempt = 1; ; attempt++) {
        try { await api('PUT', `/api/admin/academy/media/uploads/${up.id}/chunks/${n}`, part); break; } catch (e: any) {
          if (attempt >= 4 || (e.status >= 400 && e.status < 500)) throw e;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      done++;
      onProgress(`Enviando (${done}/${up.chunkCount} partes)`, Math.round((done / up.chunkCount) * 100));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return api<any>('POST', `/api/admin/academy/media/uploads/${up.id}/complete`, { expectedChecksum: meta.expectedChecksum });
}

