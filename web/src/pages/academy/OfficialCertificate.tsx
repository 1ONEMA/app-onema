import type { CSSProperties, ReactNode } from 'react';
import { date } from '../../lib/format';
import './official-certificate.css';

/**
 * Certificado oficial ONEMA ACADEMY (ONEMA-ACAD-AJT-CERT-001) — reprodução fiel do modelo assinado pelo RT
 * (tmp-cert/cert-ref.pdf, págs. 2–3). Cada página é uma folha A4 paisagem desenhada no sistema de coordenadas do
 * PDF (841,89 × 595,28 pt): formas vetoriais copiadas do PDF em SVG e textos posicionados pela linha de base em pt.
 */

const PAGE_W = 841.8898;
const PAGE_H = 595.2756;
/** Distância topo→linha de base com line-height 1 (DejaVu Sans / Helvetica: ≈ 0,846 em). */
const BASE = 0.846;

/** Declaração oficial, com as quebras de linha do PDF. */
const OFFICIAL_DECLARATION = [
  'concluiu, com aproveitamento, a Jornada de Integração ONEMA ONE, promovida pela ONEMA ACADEMY,',
  'cumprindo os quatro cursos e os critérios de avaliação estabelecidos no programa educacional.',
  'Este certificado comprova a conclusão da integração institucional, na modalidade de curso livre.',
];
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Conteúdo programático oficial (pág. 3 do modelo). */
const PROGRAM = [
  { n: '01', tone: 'navy', title: 'EXCELÊNCIA DE ATENDIMENTO', workload: '45 minutos', items: ['Cultura ONEMA e experiência do paciente', 'Comunicação e relacionamento', 'Atendimento domiciliar e postura profissional', 'Ética, segurança e qualidade no cuidado'] },
  { n: '02', tone: 'teal', title: 'SEGURANÇA DO PACIENTE', workload: '1 hora', items: ['Práticas seguras e prevenção de incidentes', 'Medicação, infecção e higienização das mãos', 'Identificação correta e checagens', 'Gestão de riscos no atendimento domiciliar'] },
  { n: '03', tone: 'navy', title: 'CARTEIRA DIGITAL E DOCUMENTAÇÃO', workload: '45 minutos', items: ['Registro assistencial e evolução de enfermagem', 'Uso da Carteira Digital ONEMA', 'Documentação, imagens e anexos', 'LGPD, privacidade e segurança da informação'] },
  { n: '04', tone: 'teal', title: 'OPERAÇÃO E PROTOCOLOS ONEMA', workload: '50 minutos', items: ['Fluxos operacionais da plataforma', 'Protocolos assistenciais e POPs', 'Monitoramento e continuidade do cuidado', 'Condutas, escalonamentos e interface com a Central'] },
] as const;

type Align = 'left' | 'right' | 'center';
/** Texto posicionado como no PDF: `x` = início (left), fim (right) ou centro (center); `y` = linha de base (pt, a partir do topo). */
function T({ x, y, size, align = 'left', className = '', style, children }: { x: number; y: number; size: number; align?: Align; className?: string; style?: CSSProperties; children: ReactNode }) {
  const pos: CSSProperties = align === 'left' ? { left: `${x}pt` } : align === 'right' ? { right: `${PAGE_W - x}pt` } : { left: `${x - 320}pt`, width: '640pt', textAlign: 'center' };
  return <div className={`oc-t ${className}`} style={{ ...pos, top: `${y - BASE * size}pt`, fontSize: `${size}pt`, ...style }}>{children}</div>;
}

/** Matriz que o PDF aplica aos traços (moldura, sublinhados, linhas de assinatura). */
const M = 'matrix(0.998785,0,0,-0.998785,0.456599,594.55208)';

export type OfficialCertificateProps = {
  /** Certificado como devolvido por GET /api/academy/certificates. */
  c: any;
  /** Marca d'água (homologação ou revogado); null = documento limpo. */
  watermark?: string | null;
  /** Envolve cada folha (p.ex. o redimensionador da tela). */
  sheet?: (page: ReactNode, key: string) => ReactNode;
};

/** As duas folhas do certificado: frente (certificado) e conteúdo programático. */
export function OfficialCertificate({ c, watermark, sheet = (p, k) => <div key={k}>{p}</div> }: OfficialCertificateProps) {
  return <>{sheet(<CertificateFront c={c} watermark={watermark} />, 'front')}{sheet(<CertificateProgram c={c} watermark={watermark} />, 'program')}</>;
}

function Watermark({ text }: { text?: string | null }) {
  return text ? <div className="watermark oc-watermark">{text}</div> : null;
}

export function CertificateFront({ c, watermark }: { c: any; watermark?: string | null }) {
  const name: string = c.snapshot?.holderName ?? '';
  const coren: string | null = c.snapshot?.holderCoren ?? null;
  const decl: string = c.template?.declaration ?? '';
  const official = !decl || norm(decl) === norm(OFFICIAL_DECLARATION.join(' '));
  // Nome em serifada itálica 21 pt; reduz para nomes longos (largura útil ≈ 560 pt).
  const nameSize = Math.min(21, 560 / (Math.max(name.length, 1) * 0.56));
  const partnerSize = Math.min(8, 300 / (Math.max(name.length + 5, 1) * 0.6));
  return (
    <div className="ocert ocert-front" role="document" aria-label={`Certificado de conclusão — ${name}`}>
      <svg className="oc-art" viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} aria-hidden focusable="false">
        <rect width={PAGE_W} height={PAGE_H} fill="#fff" />
        {/* Faixas curvas: superior esquerda e inferior direita */}
        <path fill="#103763" d="M 0.457031 0 L 155.269531 0 C 100.335938 35.957031 54.390625 74.910156 0.457031 129.84375 Z" />
        <path fill="#0cb9af" d="M 75.367188 0 L 177.242188 0 C 117.3125 31.960938 65.378906 71.914062 0.457031 159.804688 L 0.457031 114.859375 C 38.410156 64.921875 69.371094 31.960938 75.367188 0 Z" />
        <path fill="#103763" d="M 841.324219 594.550781 L 841.324219 459.714844 C 787.390625 517.644531 736.449219 564.589844 663.539062 594.550781 Z" />
        <path fill="#0cb9af" d="M 841.324219 557.597656 L 841.324219 482.6875 C 799.375 536.621094 758.425781 564.589844 704.488281 594.550781 L 651.554688 594.550781 C 729.460938 565.585938 786.390625 529.632812 841.324219 557.597656 Z" />
        {/* Moldura dourada */}
        <path fill="none" stroke="#c9a54a" strokeWidth="0.85" d="M 13.000609 13.001477 L 828.890709 13.001477 L 828.890709 582.275424 L 13.000609 582.275424 Z" transform={M} />
        {/* Anel azul-claro ao fundo */}
        <path fillRule="evenodd" fill="#edf8fc" d="M 708.59375 286.925781 A 102.875 102.875 0 1 0 502.84375 286.925781 A 102.875 102.875 0 1 0 708.59375 286.925781 Z M 674.636719 286.925781 A 68.918 68.918 0 1 1 536.804688 286.925781 A 68.918 68.918 0 1 1 674.636719 286.925781 Z" />
        {/* Sublinhados verde-água: DE CONCLUSÃO, lateral esquerda, lema, JUNTOS… */}
        <g fill="none" stroke="#0cb9af" strokeWidth="2">
          <path d="M 400.944787 419.276528 L 440.946531 419.276528" transform={M} />
          <path d="M 50.99992 361.276345 L 80.000011 361.276345" transform={M} />
          <path d="M 776.890005 509.276542 L 804.88888 509.276542" transform={M} />
          <path d="M 401.946004 236.27676 L 439.945314 236.27676" transform={M} />
        </g>
        {/* Caixa do QR */}
        <path fill="none" stroke="#15548c" strokeWidth="0.8" d="M 751.890871 426.277224 L 798.8894 426.277224 C 801.65448 426.277224 803.891574 428.510408 803.891574 431.275487 L 803.891574 478.274017 C 803.891574 481.039097 801.65448 483.276191 798.8894 483.276191 L 751.890871 483.276191 C 749.125791 483.276191 746.888697 481.039097 746.888697 478.274017 L 746.888697 431.275487 C 746.888697 428.510408 749.125791 426.277224 751.890871 426.277224 Z" transform={M} />
        {/* Linhas de assinatura */}
        <g fill="none" stroke="#103763" strokeWidth="0.65">
          <path d="M 110.00132 100.001751 L 329.001876 100.001751" transform={M} />
          <path d="M 509.99921 100.001751 L 728.999767 100.001751" transform={M} />
        </g>
      </svg>

      <img className="oc-img" src="/certificado/logo-onema-academy.png" alt="ONEMA ACADEMY" style={{ left: '395.92pt', top: '42.25pt', width: '49.94pt', height: '49.33pt' }} />
      <img className="oc-img" src="/certificado/selo-onema-academy.png" alt="" aria-hidden style={{ left: '679.52pt', top: '294.92pt', width: '108.87pt', height: '108.87pt' }} />
      <img className="oc-img" src="/certificado/assinatura-rt.png" alt="Assinatura de Enf. Marcos Roberto Alves" style={{ left: '166.25pt', top: '452.91pt', width: '106.87pt', height: '31.05pt' }} />
      {c.qrDataUrl && <img className="oc-img oc-qr" src={c.qrDataUrl} alt={`QR code de verificação: ${c.verifyUrl ?? c.publicCode}`} style={{ left: '750.4pt', top: '115.3pt', width: '50pt', height: '50pt' }} />}

      {/* Lema (superior direito) */}
      <T x={804.9} y={45} size={8} align="right" className="b">CUIDAR HOJE</T>
      <T x={804.9} y={58} size={8} align="right" className="b">TRANSFORMA</T>
      <T x={804.9} y={71} size={8} align="right" className="b">AMANHÃ</T>
      {/* Verificação */}
      <T x={775.4} y={184} size={7} align="center" className="b">VERIFICAÇÃO</T>
      <T x={775.4} y={195} size={6} align="center">Código: {c.publicCode}</T>
      {/* Lateral esquerda */}
      <T x={51} y={177} size={8} className="b">PESSOAS</T>
      <T x={51} y={191} size={8} className="b">TECNOLOGIA</T>
      <T x={51} y={205} size={8} className="b">CONHECIMENTO</T>
      <T x={51} y={219} size={8} className="b">SAÚDE REAL</T>

      {/* Bloco central */}
      <T x={420.95} y={103} size={13} align="center" className="b">ONEMA ACADEMY</T>
      <T x={420.95} y={147} size={31} align="center">CERTIFICADO</T>
      <T x={420.95} y={168} size={12} align="center" className="b oc-spaced">DE CONCLUSÃO</T>
      <T x={420.95} y={202} size={10} align="center">A ONEMA SAÚDE certifica que</T>
      <T x={420.95} y={238} size={nameSize} align="center" className="oc-name">{name}</T>
      {coren && <T x={420.95} y={258} size={9} align="center" className="b">{coren}</T>}
      {official
        ? OFFICIAL_DECLARATION.map((l, i) => <T key={i} x={420.95} y={286 + i * 16} size={8.3} align="center">{l}</T>)
        : <p className="oc-decl" style={{ fontSize: '8.3pt' }}>{decl}</p>}
      <T x={420.95} y={350} size={9} align="center" className="b">JUNTOS POR UMA SAÚDE MAIS PRÓXIMA</T>

      {/* Assinaturas */}
      <T x={219} y={509.3} size={9} align="center" className="b">Enf. Marcos Roberto Alves</T>
      <T x={219} y={522.3} size={8} align="center">Responsável Técnico</T>
      <T x={216.2} y={535.7} size={7.6} align="center" className="b">COREN-SP nº 983558</T>
      <T x={619} y={509.3} size={9} align="center" className="b">Parceiro(a)</T>
      <T x={619} y={522.3} size={partnerSize} align="center">Enf. {name}</T>
      {coren && <T x={619} y={535.3} size={7.5} align="center">{coren}</T>}

      <T x={420.95} y={560.3} size={6.7} align="center">{c.snapshot?.statement || 'Certificado institucional de curso livre. Não confere título de especialista ou autorização automática para atendimento.'}</T>
      <Watermark text={watermark} />
    </div>
  );
}

export function CertificateProgram({ c, watermark }: { c: any; watermark?: string | null }) {
  return (
    <div className="ocert ocert-program" role="document" aria-label="Conteúdo programático — Jornada de Integração ONEMA ONE">
      <svg className="oc-art" viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} aria-hidden focusable="false">
        <rect width={PAGE_W} height={PAGE_H} fill="#fff" />
        {/* Faixas diagonais */}
        <path fill="#14365d" d="M 0.457031 0 L 175.242188 0 L 0.457031 124.847656 Z" />
        <path fill="#0daeab" d="M 120.3125 0 L 152.273438 0 L 0.457031 108.867188 L 0.457031 82.898438 Z" />
        <path fill="#14365d" d="M 841.324219 594.550781 L 676.523438 594.550781 L 841.324219 469.703125 Z" />
        <path fill="#0daeab" d="M 841.324219 520.640625 L 841.324219 502.664062 L 721.46875 594.550781 L 694.5 594.550781 Z" />
        <path fill="none" stroke="#c4a55c" strokeWidth="0.8" d="M 14.999132 15 L 826.888275 15 L 826.888275 580.276901 L 14.999132 580.276901 Z" transform={M} />
        <path fill="none" stroke="#0daeab" strokeWidth="2" d="M 386.943394 429.276964 L 454.944013 429.276964" transform={M} />
        <g fill="none" stroke="#d7e5ec" strokeWidth="2">
          <path d="M 80.000011 257.274938 L 397.999801 257.274938" transform={M} />
          <path d="M 457.001201 257.274938 L 775.000991 257.274938" transform={M} />
        </g>
        {[[78.363, 206.75], [454.902, 206.75], [78.363, 364.555], [454.902, 364.555]].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r={16.98} fill={i % 2 ? '#0daeab' : '#14365d'} />
        ))}
      </svg>

      <img className="oc-img" src="/certificado/logo-onema-academy.png" alt="ONEMA ACADEMY" style={{ left: '397.92pt', top: '38.95pt', width: '45.94pt', height: '45.94pt' }} />
      <T x={810.9} y={35} size={8} align="right" className="b n2">CUIDAR HOJE</T>
      <T x={810.9} y={47} size={8} align="right" className="b n2">TRANSFORMA AMANHÃ</T>
      <T x={420.95} y={101} size={15} align="center" className="b n2">ONEMA ACADEMY</T>
      <T x={420.95} y={134} size={17} align="center" className="b n2">JORNADA DE INTEGRAÇÃO ONEMA ONE</T>
      <T x={420.95} y={155} size={10} align="center" className="n2">CONTEÚDO PROGRAMÁTICO</T>

      {PROGRAM.map((b, i) => {
        const x = i % 2 ? 458 : 81;
        const top = i < 2 ? 0 : 158;
        const cx = i % 2 ? 454.902 : 78.363;
        return (
          <div key={b.n}>
            <T x={cx} y={210 + top} size={10} align="center" className="b oc-num">{b.n}</T>
            <T x={x + 23} y={211 + top} size={10.2} className="b n2">{b.title}</T>
            {b.items.map((it, k) => <T key={it} x={x} y={237 + top + k * 17} size={8.1} className="n2">• {it}</T>)}
            <T x={x} y={316 + top} size={8.8} className="hb n2">Carga horária: {b.workload}</T>
          </div>
        );
      })}

      <div className="oc-t hb n2 oc-total" style={{ left: '164.03pt', top: `${512.3 - BASE * 8.5}pt`, fontSize: '8.5pt' }}>
        <span>Carga horária total: 3h20min</span><span>|</span><span>Conclusão: {date(c.snapshot?.completedAt)}</span><span>|</span><span>Código: {c.publicCode}</span>
      </div>
      <T x={284.97} y={530.63} size={7} className="n2">Carga horária e conteúdo vinculados à trilha concluída e registrada na ONEMA ACADEMY.</T>
      <T x={288.28} y={543.63} size={7} className="n2">Autenticidade verificável pelo código individual registrado na plataforma ONEMA SAÚDE.</T>
      <T x={294.5} y={559.63} size={7} className="n2">Documento integrante do Certificado de Conclusão e do Dossiê Digital do Parceiro.</T>
      <Watermark text={watermark} />
    </div>
  );
}
