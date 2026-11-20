import type { ImgHTMLAttributes } from 'react';

/** Aviso de conexão perdida; ao reconectar, a tela se reconcilia sozinha com o estado do servidor. */
export function OfflineNotice({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return <div className="caution small" role="status">Sem conexão. Os dados desta tela serão atualizados automaticamente quando a internet voltar.</div>;
}

/**
 * Foto exibida só dentro da interface: sem menu de salvar/copiar, sem arrastar e sem abrir em outra aba.
 * (Não impede captura de tela; não prometemos bloqueio absoluto.)
 */
export function ProtectedImg(props: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img {...props} draggable={false} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}
      style={{ ...props.style, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', pointerEvents: 'none' } as any} />
  );
}

/** Data/hora local para <input type="datetime-local"> no fuso de São Paulo. */
export function toLocalInput(iso: string) {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T').slice(0, 16);
}
/** Valor de <input type="datetime-local"> (horário de Brasília) → ISO. */
export function fromLocalInput(v: string) {
  return new Date(`${v}:00-03:00`).toISOString();
}
