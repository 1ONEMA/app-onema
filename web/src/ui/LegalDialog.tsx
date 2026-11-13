import { useState, type ReactNode } from 'react';
import { useApi } from '../lib/hooks';
import { Dialog, ErrorState, LegalText, Loading } from './ui';
import { LgpdContent } from '../pages/public/InstitutionalPage';

export type LegalKind = 'lgpd' | 'privacidade' | 'termos' | 'termo-especialista';
const META: Record<LegalKind, { title: string; code?: string }> = {
  lgpd: { title: 'LGPD e seus direitos' },
  privacidade: { title: 'Política de Privacidade', code: 'T2' },
  termos: { title: 'Termos de Uso', code: 'T1' },
  'termo-especialista': { title: 'Termo de Proteção de Dados, Sigilo e Responsabilidades do Especialista ONEMA ONE', code: 'TERMO_ESPECIALISTA' },
};

function LegalBody({ kind }: { kind: LegalKind }) {
  const code = META[kind].code;
  const t = useApi<any>(code ? `/api/public/legal/${code}` : null);
  if (!code) return <LgpdContent />;
  if (t.loading && !t.data) return <Loading lines={4} />;
  if (t.error) return <ErrorState error={t.error} onRetry={t.reload} />;
  return <div className="inst-body"><p className="muted">Versão {t.data.version}.</p><LegalText body={t.data.body} /></div>;
}

/** Link que abre o documento em janela flutuante, com letra menor (sem sair da tela). */
export function LegalLink({ kind, children, className = 'linklike' }: { kind: LegalKind; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{children}</button>
      <Dialog open={open} title={META[kind].title} onClose={() => setOpen(false)}>
        <div className="legal-dialog">{open && <LegalBody kind={kind} />}</div>
      </Dialog>
    </>
  );
}
