import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { date } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { AuthLayout } from '../auth/AuthPages';
import { Button, ErrorState, Field, Loading } from '../../ui/ui';

/** ACA-009: verificação pública mínima (QR/identificador). */
export function VerifyCertificatePage() {
  const { code } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(code ?? '');
  const { data, error, loading, reload } = useApi<any>(code ? `/api/public/certificates/${encodeURIComponent(code)}/verify` : null);
  const submit = (e: FormEvent) => { e.preventDefault(); if (input.trim()) nav(`/verificar/${input.trim().toUpperCase()}`); };
  return (
    <AuthLayout title="Verificar certificado ONEMA Academy">
      <form onSubmit={submit} className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}><Field label="Código do certificado"><input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder="ONM-XXXX-XXXX" /></Field></div>
        <Button type="submit" className="deep" style={{ marginBottom: 14 }}>Verificar</Button>
      </form>
      {code && (loading ? <Loading lines={2} /> : error ? <ErrorState error={error} onRetry={reload} /> : data && (
        <div role="status">
          {data.result === 'VALIDO' && <div className="success"><strong>Certificado válido.</strong></div>}
          {data.result === 'REVOGADO' && <div className="danger"><strong>Certificado revogado</strong> em {date(data.revokedAt)}.</div>}
          {data.result === 'NAO_ENCONTRADO' && <div className="caution">Nenhum certificado encontrado com este código.</div>}
          {data.result !== 'NAO_ENCONTRADO' && (
            <ul className="list small">
              <li><strong>Código:</strong> {data.publicCode}</li>
              <li><strong>Titular:</strong> {data.holder}</li>
              <li><strong>Formação:</strong> {data.journeyTitle}</li>
              <li><strong>Emissão:</strong> {date(data.issuedAt)}</li>
              <li><strong>Hash do conteúdo (SHA-256):</strong> <span className="mono">{data.contentHash}</span></li>
            </ul>
          )}
          {data.notice && <p className="small muted">{data.notice}</p>}
        </div>
      ))}
    </AuthLayout>
  );
}
