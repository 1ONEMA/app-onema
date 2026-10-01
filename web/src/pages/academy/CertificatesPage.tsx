import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Button, Empty, ErrorState, Loading, PageHeader, Pending } from '../../ui/ui';

/** ACA-009 Certificados: emissão única, impressão A4 paisagem (frente e verso) e verificação por QR. */
export function CertificatesPage() {
  const { status } = useAuth();
  const { data, error, loading, reload } = useApi<any>('/api/academy/certificates');
  const journey = useApi<any>('/api/academy/journey');
  const issue = useSubmit<any>();
  const eligible = journey.data?.certificate?.state === 'ELEGIVEL';
  const hml = status?.environment !== 'production';
  return (
    <>
      <PageHeader kicker="ONEMA Academy" title="Certificados" back={{ to: '/academy', label: 'Minha Jornada' }}>
        <p>O certificado comprova a conclusão educacional da Jornada de Integração. Não autoriza atendimento nem credenciamento automático.</p>
      </PageHeader>
      {loading || journey.loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <>
          {!data.certificates.length && (
            <section className="surface">
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
              <div className="certificate">
                {(hml || c.revokedAt) && <div className="watermark">{c.revokedAt ? 'REVOGADO' : 'HOMOLOGAÇÃO — SEM VALIDADE'}</div>}
                <div className="seal">ONEMA<br />Academy</div>
                <img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" style={{ height: 54, width: 'auto', alignSelf: 'flex-start' }} />
                <div style={{ marginTop: 'auto', marginBottom: 'auto' }}>
                  <div className="eyebrow">{c.template.heading}</div>
                  <h2 style={{ fontSize: 30, margin: '8px 0' }}>{c.snapshot.holderName}</h2>
                  <p>concluiu a <strong>{c.snapshot.journeyTitle}</strong> ({c.snapshot.journeyVersion}) em {date(c.snapshot.completedAt)}.</p>
                  <p className="small">{c.template.declaration}</p>
                </div>
                <div className="row between" style={{ alignItems: 'flex-end' }}>
                  <div className="row" style={{ gap: 28 }}>{c.template.signatories.map((s: any) => <div key={s.name} className="small" style={{ borderTop: '1px solid var(--ink)', paddingTop: 4, minWidth: 160 }}><strong>{s.name}</strong><br />{s.role}</div>)}</div>
                  <div className="row"><img src={c.qrDataUrl} alt={`QR code de verificação ${c.publicCode}`} width={96} height={96} /><div className="small">Código<br /><strong>{c.publicCode}</strong></div></div>
                </div>
              </div>
              <div className="certificate">
                <h2>Conteúdo programático</h2>
                <div className="table-wrap" tabIndex={0}><table><thead><tr><th>Curso</th><th>Versão</th><th>Carga horária</th></tr></thead>
                  <tbody>{c.snapshot.courses.map((x: any) => <tr key={x.code}><td>{x.code} · {x.title}</td><td>v{x.version}</td><td>{x.workload}</td></tr>)}</tbody></table></div>
                <p className="small mt">Hash SHA-256 do conteúdo: <span className="mono">{c.contentHash}</span></p>
                <p className="small">Verificação: {c.verifyUrl}</p>
                <p className="small muted" style={{ marginTop: 'auto' }}>{c.snapshot.statement}</p>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
