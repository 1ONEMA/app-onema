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
import { ServicesPage } from './pages/prime/ServicesPage';
import { InvitesPage, SupportViewPage } from './pages/prime/InvitesPage';
import { AdminRoutes } from './pages/admin/AdminRoutes';

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

function Home() {
  const { me, loading, has, isAdmin } = useAuth();
  if (loading) return <main className="page"><Loading /></main>;
  if (!me?.user) return <Navigate to="/entrar" replace />;
  if (has('PACIENTE')) return <Navigate to="/minha-onema" replace />;
  if (has('ESPECIALISTA')) return <Navigate to="/academy" replace />;
  if (isAdmin) return <Navigate to="/admin" replace />;
  return <Navigate to="/conta" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
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
      <Route path="/servicos" element={<RequireAuth roles={['PACIENTE']}><ServicesPage /></RequireAuth>} />
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
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
