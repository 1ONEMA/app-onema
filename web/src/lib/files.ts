/**
 * Prepara foto para envio: converte imagens (inclusive HEIC do iPhone, quando o navegador consegue abrir) em JPEG
 * e reduz para caber no limite de 5 MB. PDF e arquivos que o navegador não decodifica seguem como estão.
 */
export async function prepareUpload(file: File, maxBytes = 5 * 1024 * 1024): Promise<File> {
  const isImage = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name);
  if (!isImage || (file.size <= maxBytes && /^image\/(jpeg|png|webp)$/.test(file.type))) return file;
  try {
    const bmp = await createImageBitmap(file);
    for (const max of [2400, 1800, 1400]) {
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      if (blob && blob.size <= maxBytes) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
  } catch { /* formato que o navegador não abre: envia o original e o servidor explica */ }
  return file;
}
