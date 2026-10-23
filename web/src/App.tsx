import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './Layout';
import { useAuth, type Role } from './lib/auth';
import { Loading } from './ui/ui';
import { ForgotPage, LoginPage, RegisterPage, ResetPage } from './pages/auth/AuthPages';
import { MfaPage } from './pages/auth/MfaPage';
import { AccountPage } from './pages/common/AccountPage';
import { NotificationsPage } from './pages/common/NotificationsPage';
import { NotFound, OfflineAware } from './pages/common/Misc';
import { VerifyCertificatePage } from './pages/common/VerifyCertificatePage';
import { AcademyHome } from './pages/academy/AcademyHome';
import { CoursePage } from './pages/academy/CoursePage';
import { LessonPage } from './pages/academy/LessonPage';
import { ActivityPage } from './pages/academy/ActivityPage';
import { AssessmentPage } from './pages/academy/AssessmentPage';
import { HistoryPage } from './pages/academy/HistoryPage';
import { CertificatesPage } from './pages/academy/CertificatesPage';
import { HubPage } from './pages/prime/HubPage';
import { PrimeOfferPage } from './pages/prime/PrimeOfferPage';
import { PrimeSubscribePage } from './pages/prime/PrimeSubscribePage';
import { PrimeCenterPage } from './pages/prime/PrimeCenterPage';
import { PreferencesPage } from './pages/prime/PreferencesPage';
import { SharePage } from './pages/prime/SharePage';
import { InvitesPage, SupportViewPage } from './pages/prime/InvitesPage';
import { AdminRoutes } from './pages/admin/AdminRoutes';
import { HomePage } from './pages/public/HomePage';
import { PlatformPage } from './pages/public/PlatformPage';
import { SpecialistPage } from './pages/public/SpecialistPage';
import { ApplicationPage } from './pages/public/ApplicationPage';
import { RequestFlow } from './pages/care/RequestFlow';
import { MyOrdersPage, RequestDetailPage } from './pages/care/OrdersPages';
import { CentralPage } from './pages/central/CentralPage';
import { Splash } from './ui/Splash';
import { InstitutionalPage } from './pages/public/InstitutionalPage';
import { WalletPage } from './pages/care/WalletPage';

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { me, loading, error, has } = useAuth();
  const loc = useLocation();
  if (loading) return <main className="page"><Loading /></main>;
  if (error && !me) return <main className="page"><OfflineAware message={error} /></main>;
  if (!me?.user) return <Navigate to={`/entrar?voltar=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (roles && !has(...roles)) {
    return <Layout><div className="surface state"><h2>Acesso não permitido</h2><p>Seu perfil não tem acesso a esta área.</p></div></Layout>;
  }
  return <Layout>{children}</Layout>;
}

/** Destino após o login: área principal do perfil. */
function RoleHome() {
  const { me, loading, has, isAdmin } = useAuth();
  if (loading) return <main className="page"><Loading /></main>;
  if (!me?.user) return <Navigate to="/entrar" replace />;
  if (has('PACIENTE')) return <Navigate to="/minha-onema" replace />;
  if (has('ESPECIALISTA')) return <Navigate to="/academy" replace />;
  if (has('OPERADOR_CENTRAL', 'ADMIN_PRIME', 'FINANCEIRO', 'AVALIADOR_RT', 'AUDITOR')) return <Navigate to="/central" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;
  return <Navigate to="/conta" replace />;
}

export default function App() {
  return (
    <>
    <Splash />
    <Routes>
      <Route path="/" element={<Layout><HomePage /></Layout>} />
      <Route path="/inicio" element={<RoleHome />} />
      <Route path="/plataforma" element={<Layout><PlatformPage /></Layout>} />
      <Route path="/especialista" element={<Layout><SpecialistPage /></Layout>} />
      <Route path="/especialista/candidatura" element={<RequireAuth><Layout><ApplicationPage /></Layout></RequireAuth>} />
      <Route path="/solicitar" element={<Layout><RequestFlow /></Layout>} />
      <Route path="/solicitacoes/:id" element={<RequireAuth roles={['PACIENTE']}><RequestDetailPage /></RequireAuth>} />
      <Route path="/central" element={<RequireAuth roles={['OPERADOR_CENTRAL', 'ADMIN_PRIME', 'FINANCEIRO', 'AVALIADOR_RT', 'AUDITOR']}><CentralPage /></RequireAuth>} />
      <Route path="/entrar" element={<LoginPage />} />
      <Route path="/cadastro" element={<RegisterPage />} />
      <Route path="/esqueci-senha" element={<ForgotPage />} />
      <Route path="/redefinir-senha" element={<ResetPage />} />
      <Route path="/verificar/:code" element={<VerifyCertificatePage />} />
      <Route path="/verificar" element={<VerifyCertificatePage />} />
      <Route path="/mfa" element={<RequireAuth><MfaPage /></RequireAuth>} />

      <Route path="/avisos" element={<RequireAuth><NotificationsPage /></RequireAuth>} />
      <Route path="/conta" element={<RequireAuth><AccountPage /></RequireAuth>} />

      <Route path="/minha-onema" element={<RequireAuth roles={['PACIENTE']}><HubPage /></RequireAuth>} />
      <Route path="/prime" element={<RequireAuth roles={['PACIENTE']}><PrimeOfferPage /></RequireAuth>} />
      <Route path="/prime/adesao" element={<RequireAuth roles={['PACIENTE']}><PrimeSubscribePage /></RequireAuth>} />
      <Route path="/prime/assinatura" element={<RequireAuth roles={['PACIENTE']}><PrimeCenterPage /></RequireAuth>} />
      <Route path="/prime/preferencias" element={<RequireAuth roles={['PACIENTE']}><PreferencesPage /></RequireAuth>} />
      <Route path="/prime/responsavel" element={<RequireAuth roles={['PACIENTE']}><SharePage /></RequireAuth>} />
      <Route path="/servicos" element={<RequireAuth roles={['PACIENTE']}><MyOrdersPage /></RequireAuth>} />
      <Route path="/convites" element={<RequireAuth><InvitesPage /></RequireAuth>} />
      <Route path="/apoio/:grantId" element={<RequireAuth><SupportViewPage /></RequireAuth>} />

      <Route path="/academy" element={<RequireAuth roles={['ESPECIALISTA']}><AcademyHome /></RequireAuth>} />
      <Route path="/academy/cursos/:code" element={<RequireAuth roles={['ESPECIALISTA']}><CoursePage /></RequireAuth>} />
      <Route path="/academy/cursos/:code/atividade" element={<RequireAuth roles={['ESPECIALISTA']}><ActivityPage /></RequireAuth>} />
      <Route path="/academy/aulas/:code" element={<RequireAuth roles={['ESPECIALISTA']}><LessonPage /></RequireAuth>} />
      <Route path="/academy/avaliacoes/:attemptId" element={<RequireAuth roles={['ESPECIALISTA']}><AssessmentPage /></RequireAuth>} />
      <Route path="/academy/historico" element={<RequireAuth roles={['ESPECIALISTA']}><HistoryPage /></RequireAuth>} />
      <Route path="/academy/certificados" element={<RequireAuth roles={['ESPECIALISTA']}><CertificatesPage /></RequireAuth>} />

      <Route path="/admin/*" element={<RequireAuth roles={['SUPORTE_ACADEMY', 'GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'CREDENCIAMENTO', 'FINANCEIRO', 'AUDITOR', 'OPERADOR_CENTRAL', 'ADMIN_PRIME']}><AdminRoutes /></RequireAuth>} />
      <Route path="/institucional/:slug" element={<Layout><InstitutionalPage /></Layout>} />
      <Route path="/carteira" element={<RequireAuth roles={['PACIENTE']}><WalletPage /></RequireAuth>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
    </>
  );
}
