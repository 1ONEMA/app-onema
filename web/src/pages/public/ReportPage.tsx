import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { EVO_SECTIONS } from '../care/WalletPage';
import './report-page.css';

interface SharedReport {
  patient: string; patientName: string; sharedBy: string; recordId: string; careAt: string | null;
  label: string; serviceName: string; signedAt: string; specialist: string; coren: string | null;
  content: Record<string, string | undefined>; expiresAt: string;
}

const LOGO = '/icons/logo-onema-saude.png';

/** Marca d'água diagonal repetida (camada fixa: cobre a tela inteira e se repete em cada página impressa). */
function Watermark({ text }: { text: string }) {
  // Nomes longos: fonte menor para a frase caber na faixa diagonal.
  const size = text.length > 90 ? 11 : text.length > 75 ? 13 : text.length > 60 ? 15 : 17;
  const rows = Array.from({ length: 16 });
  return (
    <div className="rp-watermark" aria-hidden="true" style={{ ['--rp-wm-size' as any]: `${size}px` }}>
      <div className="rp-watermark-grid">
        {rows.map((_, i) => (
          <div key={i} className="rp-watermark-row">
            <span>{text}</span><span>{text}</span><span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className="rp-header">
      <Link to="/" className="rp-logo-link" aria-label="ONEMA SAÚDE — página inicial">
        <img src={LOGO} alt="ONEMA SAÚDE" className="rp-logo" />
      </Link>
      <div className="rp-title">
        <h1>RELATÓRIO DE ATENDIMENTO</h1>
        <p>Carteira Digital ONEMA</p>
      </div>
    </header>
  );
}

/** Relatório de atendimento compartilhado pelo titular PRIME (link com validade, revogável). */
export function ReportPage() {
  const { token } = useParams();
  const { status } = useAuth();
  const { data, error, loading, reload } = useApi<SharedReport>(token ? `/api/public/reports/${encodeURIComponent(token)}` : null);
  useEffect(() => {
    document.title = 'Relatório de atendimento · ONEMA SAÚDE';
    const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);

  const homolog = !!status && status.environment !== 'production';
  const shareLine = data ? `Compartilhado por Paciente ${data.sharedBy || data.patientName} pela Carteira Digital ONEMA` : '';
  const service = data ? [data.serviceName, data.label && data.label !== data.serviceName ? data.label : null].filter(Boolean).join(' — ') : '';

  return (
    <div className="rp-page">
      {homolog && (
        <div className="rp-env" role="note">Versão de homologação · dados e pagamentos simulados. Use apenas dados fictícios.</div>
      )}
      {data && <Watermark text={shareLine} />}
      <main className="rp-main" id="conteudo">
        {loading && !data ? (
          <article className="rp-doc"><Header /><p className="rp-muted" role="status" aria-live="polite">Carregando relatório…</p></article>
        ) : error ? (
          <article className="rp-doc rp-message" role="alert">
            <Header />
            {error.isNetwork ? (
              <>
                <h2>Sem conexão</h2>
                <p>Não foi possível carregar o relatório. Verifique a internet e tente novamente.</p>
                <button type="button" className="rp-btn" onClick={reload}>Tentar novamente</button>
              </>
            ) : error.status === 404 ? (
              <>
                <h2>Link indisponível</h2>
                <p>Este link expirou, foi revogado pelo paciente ou não existe. Peça um novo link ao paciente pela Carteira Digital ONEMA.</p>
              </>
            ) : (
              <>
                <h2>Não foi possível carregar</h2>
                <p>{error.message}</p>
                <button type="button" className="rp-btn" onClick={reload}>Tentar novamente</button>
              </>
            )}
            <p className="rp-notice">Documento informativo; não substitui avaliação médica.</p>
          </article>
        ) : data && (
          <table className="rp-print-frame">
            <tbody><tr><td>
              <article className="rp-doc">
                <Header />
                <section className="rp-ident" aria-label="Identificação">
                  <div className="rp-ident-row">
                    <span><b>Paciente:</b> {data.patientName}</span>
                    <span><b>Registro:</b> {data.recordId}</span>
                  </div>
                  {(data.careAt || service) && (
                    <div className="rp-ident-row">
                      {data.careAt && <span><b>Atendimento:</b> {dateTime(data.careAt)}</span>}
                      {service && <span><b>Serviço:</b> {service}</span>}
                    </div>
                  )}
                  <p className="rp-share">{shareLine}</p>
                  <p className="rp-share">Link válido até {dateTime(data.expiresAt)}.</p>
                </section>

                <div className="rp-body">
                  {EVO_SECTIONS.map(([k, l]) => {
                    const v = data.content[k];
                    if (typeof v !== 'string' || !v.trim()) return null;
                    return (
                      <section key={k} className="rp-section">
                        <h2>{l}</h2>
                        <p className="rp-text">{v}</p>
                      </section>
                    );
                  })}
                </div>

                <footer className="rp-sign">
                  <p>Registro de enfermagem assinado por <b>{data.specialist}</b></p>
                  <p>{data.coren ? `COREN ${data.coren} • ` : ''}Assinado em {dateTime(data.signedAt)}</p>
                </footer>
                <p className="rp-notice">Documento informativo; não substitui avaliação médica. Conteúdo registrado e assinado pelo profissional responsável pelo atendimento; o compartilhamento é feito pelo próprio paciente.</p>
              </article>
            </td></tr></tbody>
            {/* Rodapé que se repete em cada página impressa (alternativa à numeração por @page). */}
            <tfoot className="rp-print-foot" aria-hidden="true">
              <tr><td>ONEMA SAÚDE · Relatório de atendimento · Registro {data.recordId}</td></tr>
            </tfoot>
          </table>
        )}
      </main>
    </div>
  );
}
