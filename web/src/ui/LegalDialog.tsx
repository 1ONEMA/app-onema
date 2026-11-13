import { useState, type ReactNode } from 'react';
import { useApi } from '../lib/hooks';
import { Dialog, ErrorState, LegalText, Loading } from './ui';
import { LgpdContent } from '../pages/public/InstitutionalPage';

export type LegalKind = 'lgpd' | 'privacidade' | 'termos' | 'termo-especialista' | 'cancelamento';
const META: Record<LegalKind, { title: string; code?: string }> = {
  lgpd: { title: 'LGPD e seus direitos' },
  privacidade: { title: 'Política de Privacidade', code: 'PRIV' },
  termos: { title: 'Termos de Uso', code: 'TERMOS_PACIENTE' },
  cancelamento: { title: 'Política de cancelamento e reembolso', code: 'CANCELAMENTO' },
  'termo-especialista': { title: 'Termo de Proteção de Dados, Sigilo e Responsabilidades do Especialista ONEMA ONE', code: 'TERMO_ESPECIALISTA' },
};
/** Termos de Uso: um documento por perfil + cancelamento (navegação entre eles). */
const TERMS_TABS = [['TERMOS_PACIENTE', 'Paciente'], ['TERMOS_ESPECIALISTA', 'Especialista'], ['TERMOS_ACADEMY', 'Academy'], ['TERMOS_PRIME', 'PRIME'], ['CANCELAMENTO', 'Cancelamento']] as const;

function LegalBody({ kind }: { kind: LegalKind }) {
  const [tab, setTab] = useState<string>(META[kind].code ?? '');
  const code = kind === 'termos' ? tab : META[kind].code;
  const t = useApi<any>(code ? `/api/public/legal/${code}` : null);
  const tabs = kind === 'termos' && <div className="pills">{TERMS_TABS.map(([c, l]) => <button key={c} type="button" className={tab === c ? 'active' : ''} aria-pressed={tab === c} onClick={() => setTab(c)}>{l}</button>)}</div>;
  if (!code) return <LgpdContent />;
  if (t.loading && !t.data) return <>{tabs}<Loading lines={4} /></>;
  if (t.error) return <>{tabs}<ErrorState error={t.error} onRetry={t.reload} /></>;
  return <div className="inst-body">{tabs}<p className="muted">Versão {t.data.version}. Consultar não é aceite.</p><LegalText body={t.data.body} /></div>;
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
