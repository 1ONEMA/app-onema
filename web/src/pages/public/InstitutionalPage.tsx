import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../../lib/hooks';
import { ErrorState, LegalText, Loading } from '../../ui/ui';
import { openKary } from '../../ui/Kary';

const PAGES: Record<string, { title: string; kicker: string; text?: 'T1' | 'T2' }> = {
  privacidade: { title: 'Política de Privacidade', kicker: 'Institucional', text: 'T2' },
  termos: { title: 'Termos de Uso', kicker: 'Institucional', text: 'T1' },
  lgpd: { title: 'LGPD e seus direitos', kicker: 'Proteção de dados' },
};

/** Páginas institucionais. Publica os textos oficiais aprovados pelo RT; o que ainda depende de aprovação é sinalizado. */
export function InstitutionalPage() {
  const { slug = '' } = useParams();
  const page = PAGES[slug];
  const text = useApi<any>(page?.text ? `/api/public/legal/${page.text}` : null);
  useEffect(() => { document.title = `${page?.title ?? 'Institucional'} · ONEMA SAÚDE`; }, [page]);
  if (!page) return <div className="surface state"><h2>Página não encontrada</h2><Link to="/">Voltar ao início</Link></div>;
  return (
    <article className="inst">
      <div className="eyebrow-teal">{page.kicker}</div>
      <h1 className="display-light">{page.title}</h1>
      {slug === 'lgpd' ? (
        <div className="inst-body">
          <p>A ONEMA SAÚDE trata dados pessoais e de saúde somente para organizar e prestar o cuidado contratado, cumprir obrigações legais e manter a segurança da plataforma, conforme a Lei Geral de Proteção de Dados (Lei 13.709/2018).</p>
          <h2>Seus direitos como titular</h2>
          <ul>
            <li>Confirmar se tratamos seus dados e acessar uma cópia.</li>
            <li>Corrigir dados incompletos, inexatos ou desatualizados.</li>
            <li>Pedir anonimização, bloqueio ou eliminação de dados desnecessários.</li>
            <li>Revogar consentimentos e mudar preferências de comunicação a qualquer momento.</li>
            <li>Saber com quem seus dados são compartilhados e revisar autorizações dadas a responsáveis.</li>
          </ul>
          <h2>Como exercer</h2>
          <p>Escreva para <a href="mailto:atendimento@onemasaude.com.br">atendimento@onemasaude.com.br</a> ou fale com a <button className="linklike" onClick={openKary}>Kary</button>. Na sua conta você já pode exportar o histórico, ajustar preferências e revogar o acesso de responsáveis.</p>
          <p className="pending-box">Dados do encarregado (DPO) e prazos de retenção: aguardando definição oficial da ONEMA SAÚDE.</p>
        </div>
      ) : text.loading && !text.data ? <Loading /> : text.error ? <ErrorState error={text.error} onRetry={text.reload} /> : (
        <div className="inst-body">
          <p className="small muted">Versão {text.data.version} · aprovada pelo Responsável Técnico{text.data.legalReview === 'APROVADO' ? ' e pela revisão jurídica' : ' · revisão jurídica em andamento'}.</p>
          <LegalText body={text.data.body} />
          {slug === 'termos' && <p className="pending-box">Estes são os termos do ONEMA PRIME. Os termos gerais de uso da plataforma serão publicados após aprovação jurídica.</p>}
        </div>
      )}
    </article>
  );
}
