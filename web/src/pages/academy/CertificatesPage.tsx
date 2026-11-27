import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import './certificate.css';
import { OfficialCertificate } from './OfficialCertificate';
import { date } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Button, Empty, ErrorState, Loading, PageHeader, Pending } from '../../ui/ui';

/** ACA-009 Certificados: emissão única, modelo oficial (OfficialCertificate) em duas folhas A4 paisagem e verificação por QR. */
export function CertificatesPage() {
  const { status } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/academy/certificates');
  const journey = useApi<any>('/api/academy/journey');
  const issue = useSubmit<any>();
  const eligible = journey.data?.certificate?.state === 'ELEGIVEL';
  const hml = status?.environment !== 'production';
  return (
    <>
      <div className="no-print">
        <PageHeader kicker="ONEMA Academy" title="Certificados" back={{ to: '/academy', label: 'Minha Jornada' }}>
          <p>O certificado comprova a conclusão educacional da Jornada de Integração. Não autoriza atendimento nem credenciamento automático.</p>
        </PageHeader>
      </div>
      {loading || journey.loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <>
          {!data.certificates.length && (
            <section className="surface no-print">
              {eligible ? (
                <>
                  <h2>Você concluiu a jornada</h2>
                  {!data.templateApproved && <Pending>O modelo oficial do certificado (layout, signatários e dados do QR) ainda não foi aprovado (P-008). A emissão será liberada após a aprovação.</Pending>}
                  <Alert error={issue.error} />
                  <Button className="deep mt" busy={issue.busy} disabled={!data.templateApproved}
                    onClick={async () => { const r = await issue.run('POST', '/api/academy/certificates', {}, { idempotent: true }); if (r) { reload(); journey.reload(); } }}>Emitir certificado</Button>
                </>
              ) : <Empty title="Nenhum certificado emitido.">Conclua os quatro cursos da jornada para se tornar elegível.</Empty>}
            </section>
          )}
          {data.certificates.map((c: any) => (
            <section key={c.id} className="stack">
              <div className="row between no-print">
                <div><strong>{c.publicCode}</strong> · emitido em {date(c.issuedAt)} {c.revokedAt && <span className="badge red">Revogado</span>}</div>
                <div className="row"><a className="btn ghost sm" href={`/verificar/${c.publicCode}`}>Verificar</a><Button className="sm deep" onClick={() => window.print()}>Imprimir / salvar PDF</Button></div>
              </div>
              <OfficialCertificate c={c} watermark={c.revokedAt ? 'REVOGADO' : hml ? 'HOMOLOGAÇÃO — SEM VALIDADE' : null}
                sheet={(page, key) => <CertSheet key={key}>{page}</CertSheet>} />
            </section>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Folha do certificado em tamanho fixo de A4 paisagem (1123 × 794 px). Na tela é reduzida proporcionalmente à largura
 * disponível — o desenho nunca se sobrepõe no celular; na impressão sai em tamanho real (uma folha por página).
 */
const SHEET_W = 1123, SHEET_H = 794;
function CertSheet({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = outer.current; if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / SHEET_W));
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="cert-sheet-outer" ref={outer} style={{ height: SHEET_H * scale }}>
      <div className="cert-sheet" style={{ width: SHEET_W, height: SHEET_H, transform: `scale(${scale})` }}>{children}</div>
    </div>
  );
}
