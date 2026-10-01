import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../../lib/auth';
import { PageHeader } from '../../ui/ui';
import { ContentPage, VersionEditor, AssessmentEditor } from './Content';
import { MediaPage, CertAdminPage } from './Media';
import { CredentialingPage, SupportPage, ReportsPage } from './AcademyOps';
import { FinancePage, SharesAdminPage, PrimeAdminPage } from './PrimeOps';
import { UsersPage, AuditPage, BackupsPage } from './System';
import { useApi } from '../../lib/hooks';
import { dateTime } from '../../lib/format';

export const SECTIONS: { to: string; label: string; roles: Role[]; desc: string }[] = [
  { to: 'conteudo', label: 'Conteúdo Academy', roles: ['GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR'], desc: 'Versões de curso, aulas, atividades, avaliações e aprovação RT.' },
  { to: 'midia', label: 'Mídia', roles: ['GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR'], desc: 'Vídeos, legendas, transcrições e integridade (checksum).' },
  { to: 'certificados', label: 'Certificados', roles: ['GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR'], desc: 'Modelo oficial, emitidos e revogação.' },
  { to: 'credenciamento', label: 'Credenciamento', roles: ['CREDENCIAMENTO', 'ADMIN_ACADEMY', 'AUDITOR'], desc: 'Projeção de capacitação e decisão humana.' },
  { to: 'suporte', label: 'Suporte Academy', roles: ['SUPORTE_ACADEMY', 'ADMIN_ACADEMY'], desc: 'Estado técnico do parceiro e chamados.' },
  { to: 'relatorios', label: 'Relatórios Academy', roles: ['ADMIN_ACADEMY', 'AUDITOR'], desc: 'Indicadores calculados a partir do banco.' },
  { to: 'financeiro', label: 'Financeiro', roles: ['FINANCEIRO', 'ADMIN_ACADEMY', 'AUDITOR'], desc: 'Pedidos, cobranças, estornos (sandbox).' },
  { to: 'responsaveis', label: 'Verificação de responsáveis', roles: ['OPERADOR_CENTRAL', 'AUDITOR'], desc: 'Verificar autorização antes de liberar acesso.' },
  { to: 'prime', label: 'PRIME', roles: ['ADMIN_PRIME', 'FINANCEIRO', 'AUDITOR'], desc: 'Parâmetros, catálogo, fornecedor, textos e gates.' },
  { to: 'usuarios', label: 'Usuários e perfis', roles: ['ADMIN_ACADEMY', 'ADMIN_PRIME', 'AUDITOR'], desc: 'Contas administrativas, especialistas e elegibilidade.' },
  { to: 'backups', label: 'Backups', roles: ['ADMIN_ACADEMY', 'ADMIN_PRIME'], desc: 'Cópias diárias do banco, backup manual e download.' },
  { to: 'auditoria', label: 'Auditoria', roles: ['AUDITOR', 'ADMIN_ACADEMY', 'ADMIN_PRIME'], desc: 'Trilha append-only de eventos.' },
];

export function AdminRoutes() {
  const { me, has } = useAuth();
  const loc = useLocation();
  if (me?.mfa?.pending) return <Navigate to={`/mfa?voltar=${encodeURIComponent(loc.pathname)}`} replace />;
  const mine = SECTIONS.filter((s) => has(...s.roles));
  return (
    <>
      <nav className="pills" aria-label="Seções de gestão">
        <NavLink to="/admin" end>Painel</NavLink>
        {mine.map((s) => <NavLink key={s.to} to={`/admin/${s.to}`}>{s.label}</NavLink>)}
      </nav>
      <Routes>
        <Route index element={<AdminHome />} />
        <Route path="conteudo" element={<ContentPage />} />
        <Route path="conteudo/versoes/:id" element={<VersionEditor />} />
        <Route path="conteudo/avaliacoes/:id" element={<AssessmentEditor />} />
        <Route path="midia" element={<MediaPage />} />
        <Route path="certificados" element={<CertAdminPage />} />
        <Route path="credenciamento" element={<CredentialingPage />} />
        <Route path="suporte" element={<SupportPage />} />
        <Route path="relatorios" element={<ReportsPage />} />
        <Route path="financeiro" element={<FinancePage />} />
        <Route path="responsaveis" element={<SharesAdminPage />} />
        <Route path="prime" element={<PrimeAdminPage />} />
        <Route path="usuarios" element={<UsersPage />} />
        <Route path="auditoria" element={<AuditPage />} />
        <Route path="backups" element={<BackupsPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </>
  );
}

function AdminHome() {
  const { has, me, status } = useAuth();
  const mine = SECTIONS.filter((s) => has(...s.roles));
  return (
    <>
      <PageHeader kicker="Gestão ONEMA SAÚDE" title="Painel administrativo">
        <p>Perfis: {me?.user?.roles.map((r) => status?.roleLabels[r] ?? r).join(' · ')}. Toda ação é registrada na trilha de auditoria.</p>
      </PageHeader>
      <Overview />
      <div className="grid">{mine.map((s) => <Link key={s.to} to={`/admin/${s.to}`} className="tile link"><h3>{s.label}</h3><p className="small muted mb0">{s.desc}</p></Link>)}</div>
    </>
  );
}

function Overview() {
  const { has } = useAuth();
  const { data } = useApi<any>('/api/admin/overview');
  if (!data) return null;
  const n = (k: string) => Number(data[k] ?? 0);
  const items: [string, number, string | null][] = [
    ['Usuários ativos', n('users_active'), has('ADMIN_ACADEMY', 'ADMIN_PRIME', 'AUDITOR') ? '/admin/usuarios' : null],
    ['Especialistas', n('specialists'), null],
    ['Pacientes', n('patients'), null],
    ['Matrículas Academy', n('enrollments'), null],
    ['Certificados válidos', n('certificates'), has('GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR') ? '/admin/certificados' : null],
    ['Mídias aguardando RT', n('media_pending'), has('GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR') ? '/admin/midia' : null],
    ['Versões em revisão', n('versions_in_review'), has('GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'AUDITOR') ? '/admin/conteudo' : null],
    ['Assinaturas PRIME', n('subscriptions_active'), null],
    ['Chamados abertos', n('tickets_open'), has('SUPORTE_ACADEMY', 'ADMIN_ACADEMY') ? '/admin/suporte' : null],
  ];
  return (
    <section className="surface" aria-label="Indicadores">
      <div className="stats">{items.map(([label, value, to]) => {
        const body = <><strong>{value}</strong><span>{label}</span></>;
        return to ? <Link key={label} to={to} className="stat">{body}</Link> : <div key={label} className="stat">{body}</div>;
      })}</div>
      {has('ADMIN_ACADEMY', 'ADMIN_PRIME') && <p className="small muted mb0 mt">Último backup: {data.lastBackupAt ? dateTime(data.lastBackupAt) : <Link to="/admin/backups">nenhum ainda — gerar agora</Link>}</p>}
    </section>
  );
}
