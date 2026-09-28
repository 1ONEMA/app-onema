import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, type Role } from '../../lib/auth';
import { PageHeader } from '../../ui/ui';
import { ContentPage, VersionEditor, AssessmentEditor } from './Content';
import { MediaPage, CertAdminPage } from './Media';
import { CredentialingPage, SupportPage, ReportsPage } from './AcademyOps';
import { FinancePage, SharesAdminPage, PrimeAdminPage } from './PrimeOps';
import { UsersPage, AuditPage } from './System';

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
      <div className="grid">{mine.map((s) => <Link key={s.to} to={`/admin/${s.to}`} className="tile link"><h3>{s.label}</h3><p className="small muted mb0">{s.desc}</p></Link>)}</div>
    </>
  );
}
