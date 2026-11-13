import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { useApi, useSubmit } from '../../lib/hooks';
import { Alert, Button, Empty, ErrorState, Loading, PageHeader, Pending } from '../../ui/ui';

/** Conteúdo programático (certificado oficial assinado pelo RT, 01/11/2026). */
const PROGRAM: Record<string, string[]> = {
  C01: ['Cultura ONEMA e experiência do paciente', 'Comunicação e relacionamento', 'Atendimento domiciliar e postura profissional', 'Ética, segurança e qualidade no cuidado'],
  C02: ['Práticas seguras e prevenção de incidentes', 'Medicação, infecção e higienização das mãos', 'Identificação correta e checagens', 'Gestão de riscos no atendimento domiciliar'],
  C03: ['Registro assistencial e evolução de enfermagem', 'Uso da Carteira Digital ONEMA', 'Documentação, imagens e anexos', 'LGPD, privacidade e segurança da informação'],
  C04: ['Fluxos operacionais da plataforma', 'Protocolos assistenciais e POPs', 'Monitoramento e continuidade do cuidado', 'Condutas, escalonamentos e interface com a Central'],
};

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
              <div className="certificate cert-official">
                {(hml || c.revokedAt) && <div className="watermark">{c.revokedAt ? 'REVOGADO' : 'HOMOLOGAÇÃO — SEM VALIDADE'}</div>}
                <div className="cert-side small">PESSOAS<br />TECNOLOGIA<br />CONHECIMENTO<br />SAÚDE REAL</div>
                <div className="cert-motto small">CUIDAR HOJE<br />TRANSFORMA<br />AMANHÃ</div>
                <div className="cert-center">
                  <img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE" className="cert-logo" />
                  <div className="cert-brand">ONEMA ACADEMY</div>
                  <div className="cert-title">CERTIFICADO</div>
                  <div className="cert-sub">DE CONCLUSÃO</div>
                  <p className="small">A ONEMA SAÚDE certifica que</p>
                  <div className="cert-name">{c.snapshot.holderName}</div>
                  {c.snapshot.holderCoren && <div className="small"><strong>{c.snapshot.holderCoren}</strong></div>}
                  <p className="small cert-decl">{c.template.declaration}</p>
                  <div className="small"><strong>JUNTOS POR UMA SAÚDE MAIS PRÓXIMA</strong></div>
                </div>
                <div className="cert-qr"><img src={c.qrDataUrl} alt={`QR code de verificação ${c.publicCode}`} width={92} height={92} /><div className="small">VERIFICAÇÃO<br />Código: <strong>{c.publicCode}</strong></div></div>
                <div className="cert-seal" aria-hidden>ONEMA<br />SAÚDE<br /><small>ACADEMY</small></div>
                <div className="cert-signs">
                  {c.template.signatories.map((sg: any) => (
                    <div key={sg.name} className="cert-sign">{sg.signature && <img src={sg.signature} alt={`Assinatura de ${sg.name}`} />}<div className="line" /><strong>{sg.name}</strong><br />{sg.role.split(' · ').map((x: string) => <span key={x}>{x}<br /></span>)}</div>
                  ))}
                  <div className="cert-sign"><div className="line" /><strong>Parceiro(a)</strong><br />Enf. {c.snapshot.holderName}<br />{c.snapshot.holderCoren ?? ''}</div>
                </div>
                <p className="cert-foot small">{c.snapshot.statement}</p>
              </div>
              <div className="certificate cert-official">
                <div className="cert-center" style={{ width: '100%' }}>
                  <div className="cert-brand">ONEMA ACADEMY</div>
                  <h2 className="mb0">JORNADA DE INTEGRAÇÃO ONEMA ONE</h2>
                  <div className="cert-sub">CONTEÚDO PROGRAMÁTICO</div>
                </div>
                <div className="cert-program">
                  {c.snapshot.courses.map((x: any, i: number) => (
                    <div key={x.code}><strong>{String(i + 1).padStart(2, '0')} · {x.title.toUpperCase()}</strong>
                      <ul className="small">{(PROGRAM[x.code] ?? []).map((t) => <li key={t}>{t}</li>)}</ul>
                      <div className="small">Carga horária: {x.workload}</div></div>
                  ))}
                </div>
                <p className="small" style={{ textAlign: 'center' }}><strong>Carga horária total: 3h20min | Conclusão: {date(c.snapshot.completedAt)} | Código: {c.publicCode}</strong></p>
                <p className="small muted" style={{ textAlign: 'center' }}>Carga horária e conteúdo vinculados à trilha concluída e registrada na ONEMA ACADEMY. Autenticidade verificável pelo código individual em {c.verifyUrl}. Hash: <span className="mono">{c.contentHash.slice(0, 16)}…</span></p>
                <p className="small muted" style={{ textAlign: 'center' }}>Documento integrante do Certificado de Conclusão e do Dossiê Digital do Parceiro.</p>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
