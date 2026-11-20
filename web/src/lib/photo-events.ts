/** Barramento mínimo para avisar o cabeçalho que a foto do perfil mudou (sem recarregar a página). */
export const PHOTO_CHANGED_EVENT = 'onema:photo-changed';

export function emitPhotoChanged() {
  try { window.dispatchEvent(new CustomEvent(PHOTO_CHANGED_EVENT, { detail: { at: Date.now() } })); } catch { /* ambiente sem window */ }
}

export function onPhotoChanged(fn: () => void): () => void {
  const h = () => fn();
  window.addEventListener(PHOTO_CHANGED_EVENT, h);
  return () => window.removeEventListener(PHOTO_CHANGED_EVENT, h);
}

/** Proteção contra exportação casual (arrastar/menu "salvar imagem"); não é proteção absoluta. */
export const noExportImgProps = {
  draggable: false,
  onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
  onDragStart: (e: { preventDefault(): void }) => e.preventDefault(),
} as const;
