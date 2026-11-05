import { Fragment, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthPages';
import { ErrorState, Loading } from '../../ui/ui';
import { EVO_SECTIONS } from '../care/WalletPage';

/** Relatório de atendimento compartilhado pelo titular PRIME (link com validade, revogável). */
export function ReportPage() {
  const { token } = useParams();
  const { data, error, loading, reload } = useApi<any>(token ? `/api/public/reports/${encodeURIComponent(token)}` : null);
  useEffect(() => {
    document.title = 'Relatório de atendimento · ONEMA SAÚDE';
    const m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { m.remove(); };
  }, []);
  return (
    <AuthLayout title="Relatório de atendimento">
      {loading && !data ? <Loading lines={3} /> : error ? <ErrorState error={error} onRetry={reload} /> : data && (
        <>
          <p className="muted">Compartilhado por {data.patient} pela Carteira Digital ONEMA. Link válido até {dateTime(data.expiresAt)}.</p>
          <h2>{data.label}</h2>
          <p className="small muted">{data.itemName} · assinado em {dateTime(data.signedAt)}</p>
          <dl className="kv">
            {EVO_SECTIONS.map(([k, l]) => data.content[k] && <Fragment key={k}><dt>{l}</dt><dd>{data.content[k]}</dd></Fragment>)}
          </dl>
          <p className="small muted">Registro de enfermagem assinado por {data.specialist}{data.coren ? ` · COREN ${data.coren}` : ''}. Documento informativo; não substitui avaliação médica.</p>
        </>
      )}
    </AuthLayout>
  );
}
