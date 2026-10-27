import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconAward, IconBook, IconChat, IconDoc, IconHeart, IconNurse, IconShield, IconSpark, IconStar, IconWallet } from '../../ui/icons';

interface Mod { icon: ReactNode; title: string; text: string; status: 'DISPONIVEL' | 'HOMOLOGACAO' | 'VALIDACAO' | 'AGUARDANDO'; note: string; to?: string }

const STATUS: Record<Mod['status'], { label: string; tone: string }> = {
  DISPONIVEL: { label: 'Disponível na homologação', tone: '' },
  HOMOLOGACAO: { label: 'Em homologação', tone: 'blue' },
  VALIDACAO: { label: 'Em validação clínica', tone: 'orange' },
  AGUARDANDO: { label: 'Aguardando integração', tone: 'dark' },
};

const MODULES: Mod[] = [
  { icon: <IconHeart />, title: 'Solicitar cuidado', status: 'DISPONIVEL', to: '/solicitar', text: 'Necessidade, atendimento, materiais, valores na hora, orçamento completo e pagamento.', note: 'Preços oficiais aprovados pelo RT (versão 1, 30/09/2026).' },
  { icon: <IconWallet />, title: 'ONEMA PRIME', status: 'DISPONIVEL', to: '/prime', text: 'Assinatura opcional com desconto em um pedido elegível por ciclo, sem reduzir o repasse do especialista.', note: 'Valores e condições após o cadastro, com adesão separada.' },
  { icon: <IconNurse />, title: 'Área do especialista', status: 'DISPONIVEL', to: '/especialista', text: 'Ofertas com repasse integral, aceite livre e registro dos atendimentos.', note: 'Repasses e margens só aparecem para perfis autorizados.' },
  { icon: <IconBook />, title: 'ONEMA Academy', status: 'DISPONIVEL', to: '/academy', text: 'Aulas dinâmicas, atividades, avaliações, notas e certificado.', note: 'Notas da Academy são separadas das estrelas dos atendimentos.' },
  { icon: <IconStar />, title: 'Avaliações dos especialistas', status: 'DISPONIVEL', text: 'Estrelas e quantidade de avaliações por especialista, após cada atendimento concluído.', note: 'Visível ao especialista e à Central.' },
  { icon: <IconShield />, title: 'Central Operacional / RT', status: 'DISPONIVEL', to: '/central', text: 'Pedidos, eventos, precificação versionada, conciliação e autoteste.', note: 'Acesso com perfil administrativo e segundo fator (MFA).' },
  { icon: <IconSpark />, title: 'Kary IA', status: 'HOMOLOGACAO', text: 'Assistente de orientação da plataforma. Em urgência, orienta ligar 192.', note: 'Sem diagnóstico ou conduta clínica. Base de respostas a aprovar pela ONEMA.' },
  { icon: <IconAward />, title: 'Life Score', status: 'VALIDACAO', text: 'Indicador de acompanhamento de saúde.', note: 'Só será liberado para uso clínico após as etapas de validação previstas.' },
  { icon: <IconDoc />, title: 'Carteira Digital de Saúde', status: 'AGUARDANDO', text: 'Registros, planos de cuidado e relatórios do período em um só lugar.', note: 'Integração com registros assinados do profissional pendente.' },
  { icon: <IconDoc />, title: 'POPs oficiais', status: 'AGUARDANDO', text: 'Procedimentos operacionais padrão ONEMA.', note: 'Aguardando envio dos documentos oficiais aprovados.' },
  { icon: <IconChat />, title: 'Pagamentos (Asaas)', status: 'AGUARDANDO', text: 'Cobrança real, split e conciliação com o provedor.', note: 'Aguardando CNPJ e credenciais; hoje os pagamentos são simulados.' },
];

export function PlatformPage() {
  useEffect(() => { document.title = 'Plataforma · ONEMA SAÚDE'; }, []);
  return (
    <>
      <div className="eyebrow-blue">Plataforma ONEMA SAÚDE</div>
      <h1 className="display">Tudo o que organiza o seu cuidado</h1>
      <p className="muted">Paciente, especialista e Central Operacional na mesma plataforma, com regras auditáveis e dados protegidos.</p>
      <div className="module-grid">
        {MODULES.map((m) => {
          const st = STATUS[m.status];
          const inner = (
            <>
              <span className="need-icon">{m.icon}</span>
              <div>
                <div className="row"><strong>{m.title}</strong><span className={`badge ${st.tone}`}>{st.label}</span></div>
                <p className="mb0">{m.text}</p>
                <p className="small muted mb0">{m.note}</p>
              </div>
            </>
          );
          return m.to ? <Link key={m.title} to={m.to} className="module link">{inner}</Link> : <div key={m.title} className="module">{inner}</div>;
        })}
      </div>
    </>
  );
}
