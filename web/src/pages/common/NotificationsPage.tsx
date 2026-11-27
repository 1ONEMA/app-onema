import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Badge, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';

const PURPOSE: Record<string, string> = { ESSENCIAL: 'Aviso essencial', LEMBRETE: 'Lembrete', RESUMO: 'Resumo', OFERTA: 'Oferta' };

/**
 * Destino do aviso: a tabela de avisos não tem coluna de link; o servidor anexa ao texto um marcador final "[[/rota]]"
 * (só rotas internas, abertas já autenticado). Avisos antigos sem marcador usam o destino conhecido pelo título.
 */
const LINK_RE = /\s*\[\[(\/[^\]\s]*)\]\]\s*$/;
const BY_TITLE: Record<string, string> = { 'Nova pendência na Carteira': '/especialista', 'Lembretes do seu plano de cuidados': '/carteira', 'Cuidado programado': '/carteira' };
function target(n: any): { body: string; to: string | null } {
  const m = LINK_RE.exec(n.body ?? '');
  if (m && !m[1].startsWith('//')) return { body: n.body.slice(0, m.index), to: m[1] };
  return { body: n.body, to: BY_TITLE[n.title] ?? null };
}

export function NotificationsPage() {
  const { data, error, loading, reload } = useApi<any>('/api/notifications');
  useEffect(() => { if (data?.items?.some((n: any) => !n.read_at)) api('POST', '/api/notifications/read', {}).catch(() => {}); }, [data]);
  return (
    <>
      <PageHeader kicker="Aplicativo" title="Avisos"><p>Avisos gerados por eventos reais da sua conta. Nenhum aviso é criado a partir de inferências sobre sua saúde.</p></PageHeader>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <div className="surface">
          {!data.items.length ? <Empty title="Nenhum aviso por enquanto." /> : (
            <ul className="list">
              {data.items.map((n: any) => { const t = target(n); return (
                <li key={n.id}>
                  <div className="row between"><strong>{n.title}</strong><Badge tone={n.read_at ? 'dark' : 'blue'}>{n.read_at ? PURPOSE[n.purpose] : 'Novo'}</Badge></div>
                  <p className="mb0">{t.body}</p>
                  <span className="small muted">{dateTime(n.created_at)}</span>
                  {t.to && <div><Link to={t.to} className="btn sm secondary mt">Abrir</Link></div>}
                </li>
              ); })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
