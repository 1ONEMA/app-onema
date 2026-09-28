import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrf, setUnauthorizedHandler } from './api';

export type Role = 'PACIENTE' | 'ESPECIALISTA' | 'SUPORTE_ACADEMY' | 'GESTOR_CONTEUDO' | 'AVALIADOR_RT' | 'ADMIN_ACADEMY'
  | 'CREDENCIAMENTO' | 'FINANCEIRO' | 'AUDITOR' | 'OPERADOR_CENTRAL' | 'ADMIN_PRIME';
export const ADMIN_ROLES: Role[] = ['SUPORTE_ACADEMY', 'GESTOR_CONTEUDO', 'AVALIADOR_RT', 'ADMIN_ACADEMY', 'CREDENCIAMENTO', 'FINANCEIRO', 'AUDITOR', 'OPERADOR_CENTRAL', 'ADMIN_PRIME'];

export interface Me {
  user: { id: string; name: string; email: string; roles: Role[]; academyEligible: boolean } | null;
  csrfToken?: string;
  mfa?: { required: boolean; enabled: boolean; verified: boolean; pending: boolean };
}
export interface SystemStatus {
  environment: string; paymentProvider: string; emailDeliveryConfigured: boolean; whatsappEnabled: boolean;
  requireAdminMfa: boolean; productionReady: boolean; roleLabels: Record<string, string>;
}

interface Ctx {
  me: Me | null; status: SystemStatus | null; loading: boolean; error: string | null;
  setMe: (m: Me) => void; refresh: () => Promise<void>; logout: () => Promise<void>;
  has: (...roles: Role[]) => boolean; isAdmin: boolean;
}
const AuthContext = createContext<Ctx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setMe = useCallback((m: Me) => { setCsrf(m.csrfToken ?? ''); setMeState(m); }, []);
  const refresh = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api<Me>('GET', '/api/auth/me'), api<SystemStatus>('GET', '/api/system/status')]);
      setMe(m); setStatus(s); setError(null);
    } catch (e: any) {
      setError(e?.code === 'API_UNAVAILABLE' ? `API_UNAVAILABLE:${e.message}` : e?.message ?? 'Falha ao conectar.');
    } finally { setLoading(false); }
  }, [setMe]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setUnauthorizedHandler(() => setMe({ user: null })); }, [setMe]);
  const logout = useCallback(async () => {
    try { await api('POST', '/api/auth/logout', {}); } catch { /* sessão já encerrada */ }
    setMe({ user: null });
  }, [setMe]);
  const value = useMemo<Ctx>(() => {
    const roles = me?.user?.roles ?? [];
    return {
      me, status, loading, error, setMe, refresh, logout,
      has: (...r: Role[]) => r.some((x) => roles.includes(x)),
      isAdmin: roles.some((r) => ADMIN_ROLES.includes(r)),
    };
  }, [me, status, loading, error, setMe, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
