import { useEffect, useState } from 'react';
import { onPhotoChanged, noExportImgProps } from '../lib/photo-events';
import { IconUser } from './icons';
import './header-avatar.css';

type Source = 'specialist' | 'me' | null;
/** Estado compartilhado entre navegações (o Layout remonta a cada página): mesma URL até a foto mudar. */
const cache = { key: '', v: Date.now(), missing: false };
if (typeof window !== 'undefined') onPhotoChanged(() => { cache.v = Date.now(); cache.missing = false; });

/**
 * Ícone de conta no cabeçalho: mostra a mesma foto do perfil (especialista: /api/specialist/photo;
 * paciente/responsável: a foto opcional que ela mesma enviou em /api/me/photo). Sem foto → ícone neutro.
 */
export function HeaderAvatar({ userId, source }: { userId: string; source: Source }) {
  const key = `${source}:${userId}`;
  if (cache.key !== key) { cache.key = key; cache.v = Date.now(); cache.missing = false; } // novo login → busca a foto atual
  const [, force] = useState(0);
  useEffect(() => onPhotoChanged(() => force((n) => n + 1)), []);
  if (!source || cache.missing) return <IconUser />;
  const src = `${source === 'specialist' ? '/api/specialist/photo' : '/api/me/photo'}?v=${cache.v}`;
  return <img key={src} className="header-avatar" src={src} alt="" aria-hidden="true" width={42} height={42}
    onError={() => { cache.missing = true; force((n) => n + 1); }} {...noExportImgProps} />;
}

/** Ao sair da conta: o próximo login busca a foto atual. */
export function resetHeaderAvatar() { cache.key = ''; }
