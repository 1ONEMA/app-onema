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
      {slug === 'lgpd' ? <LgpdContent /> : text.loading && !text.data ? <Loading /> : text.error ? <ErrorState error={text.error} onRetry={text.reload} /> : (
        <div className="inst-body">
          <p className="small muted">Versão {text.data.version} · aprovada pelo Responsável Técnico{text.data.legalReview === 'APROVADO' ? ' e pela revisão jurídica' : ' · revisão jurídica em andamento'}.</p>
          <LegalText body={text.data.body} />
          {slug === 'termos' && <p className="pending-box">Estes são os termos do ONEMA PRIME. Os termos gerais de uso da plataforma serão publicados após aprovação jurídica.</p>}
        </div>
      )}
    </article>
  );
}

/** Conteúdo LGPD (usado na página e na janela flutuante do rodapé). */
export function LgpdContent() {
  return (
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
          <h2>Com quem compartilhamos (operadores)</h2>
          <p>Somente o necessário para cada finalidade, com contrato e medidas de segurança. Não vendemos dados.</p>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Fornecedores que tratam dados"><table>
            <thead><tr><th>Fornecedor</th><th>Para quê</th><th>Quais dados</th></tr></thead>
            <tbody>
              <tr><td>Anthropic (IA Claude)</td><td>Kary: organizar o ditado da especialista em evolução de enfermagem (revisada e assinada por ela) e responder dúvidas no chat</td><td>Texto do ditado do atendimento e mensagens do chat. Sem nome, CPF ou contato do paciente. A IA não decide nada clínico</td></tr>
              <tr><td>Asaas</td><td>Cobranças (Pix, boleto, cartão), estornos e repasse por Pix às especialistas</td><td>Nome, CPF e e-mail de quem paga; chave Pix da especialista. Dados do cartão ficam só no Asaas</td></tr>
              <tr><td>Supabase (banco de dados)</td><td>Armazenamento da plataforma</td><td>Cadastro, pedidos, prontuário (evoluções) e registros de auditoria, com campos sensíveis criptografados</td></tr>
              <tr><td>Netlify</td><td>Hospedagem do site e dos documentos enviados</td><td>Tráfego técnico (endereço IP) e arquivos da candidatura em armazenamento privado</td></tr>
              <tr><td>Resend</td><td>E-mails da conta (recuperar senha, convites)</td><td>E-mail do destinatário. Nenhuma informação de saúde no e-mail</td></tr>
              <tr><td>Google ou Apple (no aparelho da especialista)</td><td>Ditado por voz, quando usado</td><td>O áudio é transcrito pelo serviço de voz do navegador do celular. Quem preferir pode digitar</td></tr>
            </tbody>
          </table></div>
          <h2>Por quanto tempo guardamos</h2>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Prazos de retenção"><table>
            <thead><tr><th>Dado</th><th>Prazo</th></tr></thead>
            <tbody>
              <tr><td>Prontuário: evoluções de enfermagem assinadas e registros do atendimento</td><td>20 anos a partir do último registro</td></tr>
              <tr><td>Registros de acesso à aplicação (IP, data e hora)</td><td>Mínimo de 6 meses (Marco Civil da Internet)</td></tr>
              <tr><td>Pedidos, pagamentos, reembolsos e repasses</td><td>Prazo legal fiscal e contábil (a confirmar com o contador da ONEMA)</td></tr>
              <tr><td>Documentos da candidatura de especialistas</td><td>Enquanto durar o credenciamento e pelo prazo legal posterior (a confirmar)</td></tr>
              <tr><td>Links de relatório compartilhados</td><td>Expiram em 7 dias e podem ser revogados a qualquer momento</td></tr>
            </tbody>
          </table></div>
          <p className="pending-box">Encarregado de dados (DPO): nome e contato serão publicados aqui assim que definidos pela ONEMA SAÚDE. Até lá, use o e-mail acima.</p>
        </div>
  );
}
