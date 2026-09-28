import { useEffect } from 'react';
import { api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Badge, Empty, ErrorState, Loading, PageHeader } from '../../ui/ui';

const PURPOSE: Record<string, string> = { ESSENCIAL: 'Aviso essencial', LEMBRETE: 'Lembrete', RESUMO: 'Resumo', OFERTA: 'Oferta' };

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
              {data.items.map((n: any) => (
                <li key={n.id}>
                  <div className="row between"><strong>{n.title}</strong><Badge tone={n.read_at ? 'dark' : 'blue'}>{n.read_at ? PURPOSE[n.purpose] : 'Novo'}</Badge></div>
                  <p className="mb0">{n.body}</p>
                  <span className="small muted">{dateTime(n.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
