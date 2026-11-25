import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useApi, useSubmit } from '../../lib/hooks';
import { money } from '../../lib/format';
import { Alert, Button, ErrorState, Field, Loading, fieldError } from '../../ui/ui';
import { IconArrowLeft, IconArrowRight, IconCheck, IconShield } from '../../ui/icons';
import { NEED_ICONS } from '../public/HomePage';
import { DocLink } from '../../ui/DocViewer';
import { prepareUpload } from '../../lib/files';
import { AsaasNotice, openPayment } from '../../ui/AsaasPay';
import { inServiceArea } from '../../lib/coverage';
import './request-flow.css';

const STEPS = ['Necessidade', 'Atendimento', 'Materiais', 'Valores', 'Onde e quando', 'Revisão', 'Pagamento'] as const;
const DRAFT_KEY = 'onema.solicitacao.rascunho';

interface Draft {
  step: number; need: string; itemCode: string; infoText: string;
  materials: '' | 'SIM' | 'NAO' | 'NAO_SEI'; materialsDetail: string; materialsSupplyRequested: boolean;
  patientName: string; phone: string; location: string; whenPref: 'AGORA' | 'HOJE' | 'PROXIMOS_DIAS' | 'AGENDAR'; whenDate: string; notes: string;
  forSelf: boolean; responsibleAuthorized: boolean; requestId: string | null;
  address: Address; patientBirthDate: string; timeWindow: '' | 'MANHA' | 'TARDE' | 'NOITE' | 'QUALQUER'; relationship: string;
  /** A01: o pré-preenchimento com o cadastro próprio já foi feito nesta solicitação (não refaz depois de o usuário apagar). */
  selfPrefilled: boolean;
}
interface Address { cep: string; street: string; number: string; noNumber: boolean; complement: string; district: string; city: string; uf: string; reference: string }
interface SelfProfile { name: string; phone: string; birthDate: string; address: Partial<Address> | null }
const EMPTY_ADDRESS: Address = { cep: '', street: '', number: '', noNumber: false, complement: '', district: '', city: 'São Paulo', uf: 'SP', reference: '' };
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
/** Endereço salvo (rascunho, solicitação ou cadastro) completado com os campos novos (UF, sem número). */
const toAddress = (a: any): Address => {
  if (!a) return EMPTY_ADDRESS;
  const noNumber = !!a.noNumber;
  return { ...EMPTY_ADDRESS, ...a, noNumber, number: noNumber ? '' : (a.number ?? ''), uf: a.uf || (a.city ? '' : EMPTY_ADDRESS.uf) };
};
const addressEmpty = (a: Address) => !a.cep.trim() && !a.street.trim() && !a.number.trim() && !a.noNumber && !a.district.trim();
const addressComplete = (a: Address) => /^\d{5}-?\d{3}$/.test(a.cep.trim()) && inServiceArea(a.cep) && a.street.trim().length >= 3
  && (a.noNumber || a.number.trim().length > 0) && a.district.trim().length >= 2 && a.city.trim().length >= 2;
/** Campos do paciente (A01): trocar entre "para mim" e "outra pessoa" nunca leva dados de um para o outro. */
type PatientFields = Pick<Draft, 'patientName' | 'phone' | 'patientBirthDate' | 'address' | 'location'>;
const EMPTY_PATIENT: PatientFields = { patientName: '', phone: '', patientBirthDate: '', address: EMPTY_ADDRESS, location: '' };
const fromProfile = (p: SelfProfile): PatientFields => {
  const address = p.address ? toAddress(p.address) : EMPTY_ADDRESS;
  return { patientName: p.name ?? '', phone: p.phone ?? '', patientBirthDate: p.birthDate ?? '', address, location: address.district || '' };
};
const patientOf = (d: Draft): PatientFields => ({ patientName: d.patientName, phone: d.phone, patientBirthDate: d.patientBirthDate, address: d.address, location: d.location });
/** Data de nascimento digitada como dd/mm/aaaa (o campo nativo de data mostra "hoje" no Chrome Android quando vazio). */
const maskBirth = (v: string) => {
  const n = v.replace(/\D/g, '').slice(0, 8);
  return [n.slice(0, 2), n.slice(2, 4), n.slice(4, 8)].filter(Boolean).join('/');
};
const brToIso = (v: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (!m) return '';
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return '';
  if (iso > new Date().toISOString().slice(0, 10) || Number(m[3]) < 1900) return '';
  return iso;
};
const isoToBr = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.split('-').reverse().join('/') : '');
const EMPTY: Draft = {
  step: 0, need: '', itemCode: '', infoText: '', materials: '', materialsDetail: '', materialsSupplyRequested: false,
  patientName: '', phone: '', location: '', whenPref: 'PROXIMOS_DIAS', whenDate: '', notes: '', forSelf: true, responsibleAuthorized: false, requestId: null,
  address: EMPTY_ADDRESS, patientBirthDate: '', timeWindow: '', relationship: '', selfPrefilled: false,
};
/** Campos do serviço escolhido: trocar de serviço começa do zero (dados pessoais continuam). */
const SERVICE_RESET: Partial<Draft> = { itemCode: '', infoText: '', materials: '', materialsDetail: '', materialsSupplyRequested: false, requestId: null };
/** "Limpar" de cada etapa apaga só os campos daquela etapa. */
const STEP_FIELDS: Record<number, Partial<Draft>> = {
  1: { itemCode: '', infoText: '' },
  2: { materials: '', materialsDetail: '', materialsSupplyRequested: false },
  4: { patientName: '', phone: '', location: '', whenPref: 'PROXIMOS_DIAS', whenDate: '', notes: '', forSelf: true, responsibleAuthorized: false,
    address: EMPTY_ADDRESS, patientBirthDate: '', timeWindow: '', relationship: '' },
};
const TIME_WINDOW: Record<string, string> = { MANHA: 'Manhã (8h–12h)', TARDE: 'Tarde (12h–18h)', NOITE: 'Noite (18h–21h)', QUALQUER: 'Qualquer horário' };
const loadDraft = (): Draft => {
  try { const x = { ...EMPTY, ...JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}') }; return { ...x, address: toAddress(x.address) }; } catch { return EMPTY; }
};
const saveDraft = (d: Draft) => { try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* sem armazenamento */ } };
export const clearDraft = () => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* sem armazenamento */ } };

const WHEN: Record<Draft['whenPref'], string> = { AGORA: 'Agora', HOJE: 'Hoje', PROXIMOS_DIAS: 'Nos próximos dias', AGENDAR: 'Escolher uma data' };
/** Ajuste A02 (22/11/2026): textos exatos; mesmos valores do servidor (SIM → sem orientação; NAO/NAO_SEI → orientação solicitada). */
const MATERIALS: Record<string, string> = { SIM: 'Já tenho os materiais.', NAO: 'Preciso da lista de materiais.', NAO_SEI: 'Quero conferir se os materiais que tenho são adequados.' };
/**
 * A02: atendimento sem materiais decidido pela configuração do catálogo (modalidade da oferta), nunca pelo título:
 * oferta somente REMOTO (monitoramento CAT-08/PAC-05, orientação on-line CONT-01, telenfermagem) não usa materiais.
 * Pacotes MISTO e serviços PRESENCIAL mantêm a etapa.
 */
const usesMaterials = (offer: any) => !!offer && offer.modality !== 'REMOTO';
/** Rota de etapas efetivamente percorrida (a etapa "Materiais" sai quando não se aplica). */
const routeFor = (offer: any) => STEPS.map((_, i) => i).filter((i) => i !== 2 || !offer || usesMaterials(offer));
const MODALITY: Record<string, string> = { PRESENCIAL: 'Presencial', REMOTO: 'Remoto', MISTO: 'Presencial + remoto' };

export function UrgentNote() {
  return (
    <div className="urgent-note" role="note">
      <span className="nav-shield" aria-hidden><IconShield size={18} /></span>
      <p><strong>Este fluxo não atende urgências.</strong> Em risco imediato, dor intensa, falta de ar ou perda de consciência, ligue <a href="tel:192">SAMU 192</a>.</p>
    </div>
  );
}

function StepHeader({ step, route, onBack, onClear }: { step: number; route: number[]; onBack: () => void; onClear?: () => void }) {
  const pos = Math.max(route.indexOf(step), 0) + 1;
  return (
    <>
    <div className="flow-head">
      <button className="back-btn" onClick={onBack} aria-label="Voltar"><IconArrowLeft /></button>
      <div className="flow-progress">
        <div className="row between"><strong>Solicitar cuidado</strong><span className="small muted">Etapa {pos} de {route.length} · {STEPS[step]}</span></div>
        <div className="flow-bar" role="progressbar" aria-label="Progresso da solicitação" aria-valuemin={1} aria-valuemax={route.length} aria-valuenow={pos}>
          <span style={{ width: `${(pos / route.length) * 100}%` }} />
        </div>
      </div>
    </div>
    <div className="flow-tools">
      <button type="button" className="btn sm secondary" onClick={onBack}>Voltar</button>
      {onClear && <button type="button" className="btn sm ghost" onClick={onClear}>Limpar</button>}
    </div>
    </>
  );
}

export function RequestFlow() {
  const { me, has } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const catalog = useApi<any>('/api/care/needs');
  const [d, setD] = useState<Draft>(loadDraft);
  const set = (p: Partial<Draft>) => setD((x) => { const n = { ...x, ...p }; saveDraft(n); return n; });
  const [request, setRequest] = useState<any>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submit = useSubmit<any>();
  const isPatient = has('PACIENTE');

  useEffect(() => { document.title = 'Solicitar cuidado · ONEMA SAÚDE'; }, []);
  // Entrada direta por necessidade (?necessidade=CURATIVOS) ou retomada de solicitação (?id=...)
  useEffect(() => {
    const need = params.get('necessidade');
    if (need && need !== d.need) { set({ ...SERVICE_RESET, need, step: 1 }); setRequest(null); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = params.get('id') ?? d.requestId;
    if (!id || !isPatient) return;
    api<any>('GET', `/api/care/requests/${id}`).then((r) => {
      const q = r.request;
      if (['PEDIDO_GERADO', 'DESISTENCIA'].includes(q.status)) { if (params.get('id')) nav(`/solicitacoes/${id}`, { replace: true }); else { clearDraft(); setD(EMPTY); } return; }
      setRequest(q);
      if (params.get('id')) {
        set({ need: q.need, itemCode: q.itemCode, infoText: q.infoText ?? '', materials: q.materials, materialsDetail: q.materialsDetail ?? '', materialsSupplyRequested: q.materialsSupplyRequested,
          patientName: q.patientName, phone: q.phone, location: q.location, whenPref: q.whenPref, whenDate: q.whenDate ?? '', notes: q.notes ?? '',
          forSelf: q.forSelf, responsibleAuthorized: q.responsibleAuthorized, requestId: q.id, step: 5,
          address: toAddress(q.address), patientBirthDate: q.patientBirthDate ?? '', timeWindow: q.timeWindow ?? '', relationship: q.relationship ?? '', selfPrefilled: true });
      }
    }).catch(() => set({ requestId: null }));
  }, [isPatient]); // eslint-disable-line react-hooks/exhaustive-deps

  const needs: any[] = catalog.data?.needs ?? [];
  const need = needs.find((n) => n.key === d.need);
  const offer = need?.offers.find((o: any) => o.code === d.itemCode || o.alsoCodes?.includes(d.itemCode));
  const price = useApi<any>(d.step >= 3 && d.itemCode ? `/api/care/price?itemCode=${d.itemCode}` : null);
  const route = routeFor(offer);
  const skipMaterials = !!offer && !usesMaterials(offer);

  const go = (step: number) => { set({ step }); setNotice(null); submit.setError(null); window.scrollTo(0, 0); };
  /** Próxima/anterior etapa aplicável ("Voltar" retorna à última etapa realmente percorrida). */
  const next = (from: number) => route.find((s) => s > from) ?? from + 1;
  const back = () => { if (d.step === 0) return nav('/'); const prev = [...route].reverse().find((s) => s < d.step); go(prev ?? d.step - 1); };

  // ---------- A01: "O cuidado é para mim" pré-preenche com o cadastro do próprio usuário ----------
  const [profile, setProfile] = useState<SelfProfile | null>(null);
  const [selfStash, setSelfStash] = useState<PatientFields | null>(null);
  const [otherStash, setOtherStash] = useState<PatientFields | null>(null);
  const [birthText, setBirthText] = useState(() => isoToBr(d.patientBirthDate));
  const [birthError, setBirthError] = useState<string | null>(null);
  useEffect(() => {
    if (!isPatient || d.step !== 4 || profile) return;
    api<SelfProfile>('GET', '/api/care/self-profile').then(setProfile).catch(() => { /* sem pré-preenchimento: campos ficam para completar */ });
  }, [isPatient, d.step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Só em solicitação NOVA, "para mim", e só nos campos ainda vazios (nada digitado é sobrescrito).
    if (!profile || d.step !== 4 || !d.forSelf || d.requestId || d.selfPrefilled) return;
    const p = fromProfile(profile);
    set({
      selfPrefilled: true,
      patientName: d.patientName || p.patientName, phone: d.phone || p.phone, patientBirthDate: d.patientBirthDate || p.patientBirthDate,
      ...(addressEmpty(d.address) ? { address: p.address, location: d.location || p.location } : {}),
    });
  }, [profile, d.step, d.forSelf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (brToIso(birthText) !== d.patientBirthDate) setBirthText(isoToBr(d.patientBirthDate)); }, [d.patientBirthDate]); // eslint-disable-line react-hooks/exhaustive-deps
  function chooseFor(self: boolean) {
    if (self === d.forSelf) return;
    setBirthError(null);
    if (!self) {
      // Para outra pessoa: os dados do próprio usuário saem do formulário (guardados só nesta tela para voltar).
      setSelfStash(patientOf(d));
      set({ forSelf: false, ...(otherStash ?? EMPTY_PATIENT) });
    } else {
      setOtherStash(patientOf(d));
      set({ forSelf: true, selfPrefilled: true, ...(selfStash ?? (profile ? fromProfile(profile) : EMPTY_PATIENT)) });
    }
  }
  const setAddress = (a: Partial<Address>) => {
    const address = { ...d.address, ...a };
    set({ address, location: address.district.trim() || address.city.trim() || d.location });
  };
  const clearStep = () => {
    if (!window.confirm(d.step === 0 ? 'Apagar toda a solicitação em andamento e começar de novo?' : 'Apagar o que foi preenchido nesta etapa?')) return;
    if (d.step === 0) { clearDraft(); setD(EMPTY); setRequest(null); setFiles([]); return; }
    set(STEP_FIELDS[d.step] ?? {}); if (d.step === 4) { setFiles([]); setSelfStash(null); setOtherStash(null); setBirthError(null); }
    submit.setError(null); setNotice(null);
  };
  const [files, setFiles] = useState<{ file: File; kind: string }[]>([]);

  /**
   * A02: sem etapa de materiais, envia o valor neutro que o servidor já trata como "não se aplica"
   * (materials SIM → orientação NAO_APLICAVEL, sem pendência, sem alterar preço). Edição de solicitação
   * do mesmo atendimento mantém o que já estava gravado (não reemite orçamento à toa).
   */
  const materialsBody = () => {
    if (!skipMaterials) return { materials: d.materials, materialsDetail: d.materialsDetail, materialsSupplyRequested: d.materials !== 'SIM' && d.materialsSupplyRequested };
    if (request && request.itemCode === d.itemCode) return { materials: request.materials, materialsDetail: request.materialsDetail ?? '', materialsSupplyRequested: !!request.materialsSupplyRequested };
    return { materials: 'SIM' as const, materialsDetail: '', materialsSupplyRequested: false };
  };
  const remote = offer?.modality === 'REMOTO';
  const addressBody = () => {
    const a = { ...d.address, number: d.address.noNumber ? '' : d.address.number, uf: d.address.uf.trim().toUpperCase() };
    // Remoto: endereço opcional — só vai quando completo e na área de atendimento (sem nova exigência de deslocamento).
    if (remote) return addressComplete(a) ? a : null;
    return a;
  };
  const body = () => ({
    need: d.need, itemCode: d.itemCode, infoText: d.infoText, ...materialsBody(), patientName: d.patientName, phone: d.phone,
    location: (d.address.district.trim() || d.address.city.trim() || d.location).slice(0, 120),
    whenPref: d.whenPref, whenDate: d.whenPref === 'AGENDAR' ? d.whenDate : null, notes: d.notes, forSelf: d.forSelf, responsibleAuthorized: d.forSelf ? false : d.responsibleAuthorized,
    address: addressBody(), patientBirthDate: d.patientBirthDate || null, timeWindow: d.timeWindow || null,
    relationship: d.forSelf ? null : d.relationship || null,
  });

  async function toReview(e: FormEvent) {
    e.preventDefault();
    if (birthText && !brToIso(birthText)) { setBirthError('Data de nascimento inválida. Use dd/mm/aaaa.'); return; }
    setBirthError(null);
    const r = d.requestId
      ? await submit.run('PUT', `/api/care/requests/${d.requestId}`, body())
      : await submit.run('POST', '/api/care/requests', body(), { idempotent: true });
    if (!r) return;
    // Cada anexo só é dado como enviado depois de gravado no servidor; falhas ficam visíveis para nova tentativa.
    const failed: string[] = [];
    for (const f of files) {
      const fd = new FormData(); fd.append('kind', f.kind); fd.append('file', await prepareUpload(f.file));
      try { await api('POST', `/api/care/requests/${r.request.id}/documents`, fd); } catch (e: any) { failed.push(`"${f.file.name}" (${e?.message ?? 'erro'})`); }
    }
    setFiles([]);
    setRequest(r.request);
    set({ requestId: r.request.id, step: 5 });
    const notes = [r.acceptanceInvalidated ? 'Você alterou dados que afetam o orçamento: os valores foram recalculados e é preciso confirmar novamente.' : '',
      failed.length ? `Não foi possível anexar ${failed.join(', ')}. Anexe de novo logo abaixo, em "Pedido médico e exames".` : ''].filter(Boolean);
    setNotice(notes.length ? notes.join(' ') : null);
    window.scrollTo(0, 0);
  }

  if (catalog.loading && !catalog.data) return <Loading />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={catalog.reload} />;
  // Ordem aprovada: cadastro/autenticação → necessidade → materiais → orçamento → pagamento.
  if (!me?.user) {
    const voltar = encodeURIComponent(`/solicitar${params.get('necessidade') ? `?necessidade=${params.get('necessidade')}` : ''}`);
    const chosen = needs.find((n) => n.key === params.get('necessidade'));
    return (
      <div className="flow">
        <div className="flow-card">
          <div className="eyebrow-blue">Solicitar cuidado{chosen ? ` · ${chosen.title}` : ''}</div>
          <h1 className="display">Entre ou crie sua conta para começar</h1>
          <p className="muted">Com o cadastro, você informa a necessidade e os materiais e recebe o orçamento completo antes de qualquer pagamento. Criar a conta não gera cobrança nem obriga a contratar.</p>
          <div className="row">
            <Link className="btn deep" to={`/entrar?voltar=${voltar}`}>Entrar</Link>
            <Link className="btn secondary" to={`/cadastro?voltar=${voltar}`}>Criar conta</Link>
          </div>
          <UrgentNote />
        </div>
      </div>
    );
  }
  if (!isPatient) return <div className="flow"><div className="caution">Esta conta não é de paciente/titular. Use uma conta de paciente para solicitar cuidado.</div></div>;

  return (
    <div className="flow">
      <StepHeader step={d.step} route={route} onBack={back} onClear={[0, 1, 2, 4].includes(d.step) ? clearStep : undefined} />

      {d.step === 0 && (
        <>
          <div className="eyebrow-blue">Primeiro, escolha uma necessidade</div>
          <h1 className="display">Como podemos cuidar de você?</h1>
          <p className="muted">{catalog.data.intro}</p>
          <div className="need-grid">
            {needs.map((n) => (
              <button key={n.key} className={`need-card ${d.need === n.key ? 'selected' : ''}`} onClick={() => { set({ ...(n.key !== d.need || d.requestId ? SERVICE_RESET : {}), need: n.key, itemCode: n.key !== d.need || !d.itemCode ? (n.offers.length === 1 ? n.offers[0].code : '') : d.itemCode, step: 1 }); if (n.key !== d.need) { setRequest(null); setFiles([]); } window.scrollTo(0, 0); }}>
                <span className="need-icon">{NEED_ICONS[n.icon]}</span>
                <span className="need-text"><strong>{n.title}</strong><span>{n.subtitle}</span></span>
                <IconArrowRight size={20} />
              </button>
            ))}
          </div>
          <UrgentNote />
        </>
      )}

      {d.step === 1 && need && (
        <div className="flow-card">
          <div className="eyebrow-blue">{need.title}</div>
          <h1 className="display">Qual atendimento você procura?</h1>
          <p className="muted">Escolher aqui é preencher a solicitação, não contratar.</p>
          <fieldset className="offer-list">
            <legend className="sr-only">Atendimentos disponíveis</legend>
            {need.offers.map((o: any) => (
              <label key={o.code} className={`offer ${d.itemCode === o.code ? 'selected' : ''}`}>
                <input type="radio" name="offer" checked={d.itemCode === o.code} onChange={() => set({ itemCode: o.code, ...(usesMaterials(o) ? {} : STEP_FIELDS[2]) })} />
                <span className="offer-main">
                  <strong>{o.name}</strong>
                  <span className="small muted">{o.summary}</span>
                  <span className="offer-tags"><span className="badge dark">{o.kind === 'PACOTE' ? 'Pacote' : 'Serviço'}</span><span className="badge blue">{MODALITY[o.modality]}</span><span className="badge">{o.actsLabel}</span>{o.periodDays && <span className="badge dark">{o.periodDays} dias</span>}</span>
                  {o.alsoCodes?.length > 0 && <span className="small muted">Mesma oferta mensal nos códigos {[o.code, ...o.alsoCodes].join(' e ')} — uma única cobrança.</span>}
                </span>
              </label>
            ))}
          </fieldset>
          <Field label="Conte brevemente o que é importante (opcional)" hint="Não é necessário enviar exames ou dados detalhados agora.">
            <textarea value={d.infoText} maxLength={600} onChange={(e) => set({ infoText: e.target.value })} placeholder="Ex.: ferida na perna há duas semanas" />
          </Field>
          <div className="flow-actions"><Button className="deep" disabled={!d.itemCode} onClick={() => go(next(1))}>Continuar <IconArrowRight size={18} /></Button></div>
        </div>
      )}

      {d.step === 2 && skipMaterials && (
        <div className="flow-card">
          <p>Este atendimento não usa materiais.</p>
          <Button className="deep" onClick={() => go(next(2))}>Continuar <IconArrowRight size={18} /></Button>
        </div>
      )}

      {d.step === 2 && !skipMaterials && (
        <div className="flow-card">
          <div className="eyebrow-blue">Materiais</div>
          <h1 className="display">Precisa de ajuda com os materiais?</h1>
          <p className="muted">O especialista informa quais materiais você precisa providenciar e, quando necessário, envia links para compra. A compra é feita por você ou pelo responsável. Pedir essa orientação não altera o valor do serviço nem impede continuar a solicitação.</p>
          <div className="radio-list" role="radiogroup" aria-label="Materiais disponíveis">
            {Object.entries(MATERIALS).map(([k, l]) => (
              <label key={k} className={d.materials === k ? 'selected' : ''}>
                <input type="radio" name="materials" checked={d.materials === k} onChange={() => set({ materials: k as Draft['materials'], materialsSupplyRequested: false })} /> {l}
              </label>
            ))}
          </div>
          {(d.materials === 'SIM' || d.materials === 'NAO_SEI') && (
            <Field label="Quais materiais você já tem?" hint="Opcional."><input type="text" value={d.materialsDetail} maxLength={400} onChange={(e) => set({ materialsDetail: e.target.value })} placeholder="Ex.: gazes, soro fisiológico, luvas" /></Field>
          )}
          {(d.materials === 'NAO' || d.materials === 'NAO_SEI') && <p className="small success">Combinado: você receberá a orientação de materiais no app, antes da visita.</p>}
          <div className="flow-actions"><Button className="deep" disabled={!d.materials} onClick={() => go(next(2))}>Ver valores do atendimento <IconArrowRight size={18} /></Button></div>
        </div>
      )}

      {d.step === 3 && (
        <div className="flow-card">
          <div className="eyebrow-blue">Valores do atendimento</div>
          <h1 className="display">{offer?.name ?? 'Valores'}</h1>
          {price.loading && !price.data ? <Loading lines={2} /> : price.error ? <ErrorState error={price.error} onRetry={price.reload} /> : price.data && (
            <>
              <div className="price-box">
                <div className="price-line"><span>Preço aprovado ({price.data.offer.actsLabel})</span><strong>{money(price.data.offer.priceCents)}</strong></div>
                <div className="price-line"><span>Desconto ONEMA PRIME</span><strong>{price.data.personal.discountCents ? `− ${money(price.data.personal.discountCents)}` : money(0)}</strong></div>
                {!price.data.personal.discountCents && <p className="small muted mb0">{price.data.personal.noDiscountReason ?? `Disponível para assinantes PRIME ativos (adesão separada de ${money(price.data.prime.monthlyPriceCents)}/mês).`}</p>}
                <div className="price-line total"><span>Valor do atendimento</span><strong>{money(price.data.personal.totalCents)}</strong></div>
              </div>
              <p className="small muted">O PRIME é opcional e contratado separadamente ({money(price.data.prime.monthlyPriceCents)} por ciclo mensal): {price.data.prime.discountBps / 100}% de desconto, limitado a {money(price.data.prime.capCents)}, em um pedido elegível por ciclo mensal (pacotes: uma vez). Ele não é incluído automaticamente. <Link to="/prime">Conhecer o PRIME</Link></p>
              <p className="small muted">Não pedimos cartão para mostrar preços. O total final aparece na revisão, antes de qualquer autorização de pagamento.</p>
            </>
          )}
          <div className="flow-actions"><Button className="deep" disabled={!price.data} onClick={() => go(4)}>Continuar <IconArrowRight size={18} /></Button></div>
        </div>
      )}

      {d.step === 4 && (
        <div className="flow-card">
          <div className="eyebrow-blue">Informações essenciais</div>
          <h1 className="display">Onde e quando?</h1>
          {!me?.user ? (
            <div className="stack">
              <p>Para continuar, entre ou crie sua conta. Suas escolhas ficam guardadas nesta aba.</p>
              <div className="row">
                <Link className="btn deep" to={`/entrar?voltar=${encodeURIComponent('/solicitar')}`}>Entrar</Link>
                <Link className="btn secondary" to={`/cadastro?voltar=${encodeURIComponent('/solicitar')}`}>Criar conta</Link>
              </div>
            </div>
          ) : !isPatient ? (
            <div className="caution">Esta conta não é de paciente/titular. Use uma conta de paciente para solicitar cuidado.</div>
          ) : (
            <form onSubmit={toReview} noValidate>
              <p className="muted">Os dados ficam protegidos e são usados somente para organizar o atendimento.</p>
              <div className="radio-list" role="radiogroup" aria-label="Para quem é o cuidado">
                <label className={d.forSelf ? 'selected' : ''}><input type="radio" checked={d.forSelf} onChange={() => chooseFor(true)} /> O cuidado é para mim</label>
                <label className={!d.forSelf ? 'selected' : ''}><input type="radio" checked={!d.forSelf} onChange={() => chooseFor(false)} /> É para outra pessoa</label>
              </div>
              <h2 className="h-sub">Paciente</h2>
              {d.forSelf && <p className="self-check-note" role="note">Confira seus dados. Você pode alterar as informações antes de continuar.</p>}
              <div className="form-grid">
                <Field label="Nome completo do paciente" error={fieldError(submit.error, 'patientName')}><input type="text" value={d.patientName} autoComplete={d.forSelf ? 'name' : 'off'} onChange={(e) => set({ patientName: e.target.value })} placeholder="Ex.: Maria Oliveira Santos" required /></Field>
                <Field label="Data de nascimento" hint="dd/mm/aaaa" error={birthError ?? fieldError(submit.error, 'patientBirthDate')}>
                  <input type="text" inputMode="numeric" autoComplete={d.forSelf ? 'bday' : 'off'} placeholder="dd/mm/aaaa" maxLength={10} value={birthText}
                    onChange={(e) => { const t = maskBirth(e.target.value); setBirthText(t); setBirthError(null); set({ patientBirthDate: brToIso(t) }); }} /></Field>
                <Field label="Telefone de contato no domicílio" error={fieldError(submit.error, 'phone')}><input type="tel" value={d.phone} autoComplete="tel" onChange={(e) => set({ phone: e.target.value })} placeholder="(11) 99999-9999" required /></Field>
                {!d.forSelf && <Field label="Seu vínculo com o paciente"><input type="text" value={d.relationship} maxLength={60} onChange={(e) => set({ relationship: e.target.value })} placeholder="Ex.: filha, cuidador, cônjuge" /></Field>}
              </div>
              <AddressFields address={d.address} onChange={setAddress} error={submit.error} remote={remote} />
              <h2 className="h-sub">Quando</h2>
              <div className="form-grid">
                <Field label="Quando precisa?">
                  <select value={d.whenPref} onChange={(e) => set({ whenPref: e.target.value as Draft['whenPref'] })}>
                    {Object.entries(WHEN).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
                {d.whenPref === 'AGENDAR' && <Field label="Data desejada" error={fieldError(submit.error, 'whenDate')}><input type="date" value={d.whenDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ whenDate: e.target.value })} /></Field>}
                <Field label="Janela de horário preferida"><select value={d.timeWindow} onChange={(e) => set({ timeWindow: e.target.value as Draft['timeWindow'] })}>
                  <option value="">Selecione</option>{Object.entries(TIME_WINDOW).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              </div>
              <p className="small muted">É uma preferência: a Central confirma o horário com a especialista e avisa você.</p>
              <Field label="Observação breve (opcional)"><textarea value={d.notes} maxLength={600} onChange={(e) => set({ notes: e.target.value })} placeholder="Conte o que é importante" /></Field>
              {!d.forSelf && (
                <label className={`choice ${fieldError(submit.error, 'responsibleAuthorized') ? 'mandatory' : ''}`}>
                  <input type="checkbox" checked={d.responsibleAuthorized} onChange={(e) => set({ responsibleAuthorized: e.target.checked })} />
                  <span>Declaro que sou responsável autorizado pelo paciente para solicitar este cuidado. <span className="small muted">O acesso a registros clínicos continua dependendo da autorização do titular.</span></span>
                </label>
              )}
              {fieldError(submit.error, 'responsibleAuthorized') && <p className="small err" role="alert">{fieldError(submit.error, 'responsibleAuthorized')}</p>}
              <h2 className="h-sub">Pedido médico ou exame {d.need === 'MEDICAMENTOS' ? '(recomendado)' : '(opcional)'}</h2>
              <p className="small muted">{d.need === 'MEDICAMENTOS' ? 'A administração de medicamentos depende de prescrição válida: anexe a receita ou o pedido médico. ' : ''}Foto ou PDF, até 5 MB. Só a especialista que aceitar o atendimento consegue ver, sem poder alterar.</p>
              {files.map((f, i) => <div key={i} className="row small">{f.file.name} · {f.kind === 'EXAME' ? 'exame' : 'pedido médico'} <button type="button" className="linklike" onClick={() => setFiles(files.filter((_, k) => k !== i))}>Remover</button></div>)}
              <div className="row">
                <label className="btn sm secondary upload-btn">Anexar pedido médico<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFiles([...files, { file: f, kind: 'PEDIDO_MEDICO' }]); e.target.value = ''; }} /></label>
                <label className="btn sm secondary upload-btn">Anexar exame<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) setFiles([...files, { file: f, kind: 'EXAME' }]); e.target.value = ''; }} /></label>
              </div>
              <UrgentNote />
              <Alert error={submit.error && !Array.isArray(submit.error.details) ? submit.error : null} />
              <div className="flow-actions"><Button className="deep" busy={submit.busy}>Revisar solicitação <IconArrowRight size={18} /></Button></div>
            </form>
          )}
        </div>
      )}

      {d.step === 5 && request && <Review key={`${request.id}-${request.quoteVersion}`} request={request} notice={notice} onEdit={(s) => go(s)} onChange={setRequest} onPay={() => go(6)} />}
      {d.step === 5 && !request && <div className="flow-card"><p>Preencha “Onde e quando” para gerar o orçamento.</p><Button className="deep" onClick={() => go(4)}>Voltar</Button></div>}
      {d.step === 6 && request && <Pay request={request} onChange={(r) => { setRequest(r); go(5); }} />}
    </div>
  );
}

function Review({ request: r, notice, onEdit, onChange, onPay }: { request: any; notice: string | null; onEdit: (step: number) => void; onChange: (r: any) => void; onPay: () => void }) {
  const q = r.quote;
  const [agree, setAgree] = useState(r.acceptanceValid);
  const accept = useSubmit<any>();
  const cancel = useSubmit<any>();
  const nav = useNavigate();
  async function confirm() {
    if (r.acceptanceValid) return onPay();
    const res = await accept.run('POST', `/api/care/requests/${r.id}/accept`, { quoteVersion: r.quoteVersion });
    if (res) { onChange(res.request); onPay(); return; }
    // Orçamento vencido (3 dias) ou atualizado: recarrega a nova versão para revisão.
    try { const fresh = await api<any>('GET', `/api/care/requests/${r.id}`); if (fresh.request.quoteVersion !== r.quoteVersion) { setAgree(false); onChange(fresh.request); } } catch { /* mantém a tela */ }
  }
  async function withdraw() {
    if (!confirm_('Desistir desta solicitação? Nada foi cobrado.')) return;
    if (await cancel.run('POST', `/api/care/requests/${r.id}/cancel`, {})) { clearDraft(); nav('/servicos'); }
  }
  return (
    <div className="flow-card">
      <div className="eyebrow-blue">Escopo, logística e orçamento completo</div>
      <h1 className="display">Revise antes de confirmar</h1>
      {notice && <div className="caution" role="status">{notice}</div>}
      <p className="small muted">Orçamento <span className="mono">{r.protocol}</span> · versão {r.quoteVersion} · emitido em {new Date(r.quoteIssuedAt).toLocaleString('pt-BR')} · válido até {new Date(r.quoteExpiresAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} (3 dias)</p>
      <div className="two">
        <section className="review-block">
          <div className="row between"><h2>Atendimento</h2><button className="linklike" onClick={() => onEdit(1)}>Editar</button></div>
          <dl className="kv">
            <dt>Código e versão</dt><dd>{q.offer.code} · v{q.offer.versionNo}</dd>
            <dt>Atendimento</dt><dd>{q.offer.name}</dd>
            <dt>Modalidade</dt><dd>{MODALITY[q.offer.modality] ?? q.offer.modality}</dd>
            <dt>Atos incluídos</dt><dd>{q.offer.actsLabel}</dd>
            {q.offer.periodDays && <><dt>Período</dt><dd>{q.offer.periodDays} dias{q.offer.recurring === 'MENSAL' ? ' (ciclo mensal)' : ''}</dd></>}
            <dt>Materiais</dt><dd>{q.offer.modality === 'REMOTO' && r.guidance?.status === 'NAO_APLICAVEL' ? 'Não se aplica a este atendimento' : MATERIALS[r.materials]}{r.guidance?.status === 'SOLICITADA' ? ' · orientação solicitada (não altera o preço)' : ''}</dd>
          </dl>
          <h3>Inclui</h3>
          <ul className="check-list">{q.offer.inclusions.map((x: string) => <li key={x}><IconCheck size={18} />{x}</li>)}</ul>
          <h3>Não inclui</h3>
          <ul className="small muted">{q.offer.exclusions.map((x: string) => <li key={x}>{x}</li>)}</ul>
        </section>
        <section className="review-block">
          <div className="row between"><h2>Onde e quando</h2><button className="linklike" onClick={() => onEdit(4)}>Editar</button></div>
          <dl className="kv">
            <dt>Paciente</dt><dd>{r.patientName}{r.patientBirthDate ? ` · nasc. ${r.patientBirthDate.split('-').reverse().join('/')}` : ''}{r.forSelf ? '' : ` · solicitado por responsável autorizado${r.relationship ? ` (${r.relationship})` : ''}`}</dd>
            <dt>Telefone</dt><dd>{r.phone}</dd>
            <dt>Endereço</dt><dd>{r.address ? `${r.address.street}, ${r.address.noNumber ? 's/nº' : r.address.number}${r.address.complement ? ` – ${r.address.complement}` : ''} · ${r.address.district} · ${r.address.city}${r.address.uf ? `/${r.address.uf}` : ''} · CEP ${r.address.cep}${r.address.reference ? ` · Ref.: ${r.address.reference}` : ''}` : r.location}</dd>
            <dt>Quando</dt><dd>{WHEN[r.whenPref as Draft['whenPref']]}{r.whenDate ? ` · ${r.whenDate.split('-').reverse().join('/')}` : ''}{r.timeWindow ? ` · ${TIME_WINDOW[r.timeWindow]}` : ''} · <em>horário solicitado, a confirmar</em></dd>
            {r.notes && <><dt>Observação</dt><dd>{r.notes}</dd></>}
          </dl>
          <ReviewDocuments requestId={r.id} />
          <h2 className="mt">Orçamento</h2>
          <div className="price-box">
            <div className="price-line"><span>Preço base</span><strong>{money(q.basePriceCents)}</strong></div>
            <div className="price-line"><span>Adicionais aprovados</span><strong>{q.additions.length ? q.additions.map((a: any) => money(a.cents)).join(' + ') : 'Nenhum'}</strong></div>
            <div className="price-line"><span>Desconto ONEMA PRIME</span><strong>{q.discountCents ? `− ${money(q.discountCents)}` : money(0)}</strong></div>
            {q.noDiscountReason && <p className="small muted mb0">{q.noDiscountReason}</p>}
            <div className="price-line total"><span>Total final</span><strong>{q.pending ? 'Orçamento pendente' : money(q.totalCents)}</strong></div>
          </div>
        </section>
      </div>
      {q.pending ? (
        <div className="caution" role="alert"><strong>Orçamento pendente.</strong> {q.pendingReasons.join(' ')} <button className="linklike" onClick={() => onEdit(2)}>Alterar a resposta sobre materiais</button></div>
      ) : (
        <label className="choice mandatory">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>Li o escopo, as inclusões e exclusões e aceito este orçamento (versão {r.quoteVersion}), no total de <strong>{money(q.totalCents)}</strong>. <span className="small muted">Aceitar não cobra nada: o pagamento só acontece no próximo passo.</span></span>
        </label>
      )}
      <Alert error={accept.error ?? cancel.error} />
      <div className="flow-actions between">
        <Button className="ghost" busy={cancel.busy} onClick={withdraw}>Desistir</Button>
        <Button className="deep" disabled={q.pending || !agree} busy={accept.busy} onClick={confirm}>Ir para o pagamento <IconArrowRight size={18} /></Button>
      </div>
    </div>
  );
}
const confirm_ = (m: string) => (typeof window === 'undefined' ? true : window.confirm(m));

function Pay({ request: r, onChange }: { request: any; onChange: (r: any) => void }) {
  const nav = useNavigate();
  const { status } = useAuth();
  const asaasMode = status?.paymentProvider === 'ASAAS';
  const [method, setMethod] = useState(asaasMode ? 'ASAAS' : 'SANDBOX_APROVADO');
  const [cpf, setCpf] = useState('');
  const pay = useSubmit<any>();
  const [result, setResult] = useState<any>(null);
  const total = r.quote.totalCents;
  const changed = useMemo(() => pay.error?.code === 'PRICE_CHANGED' ? pay.error.details?.quote : null, [pay.error]);
  async function go() {
    const res = await pay.run('POST', `/api/care/requests/${r.id}/checkout`,
      { quoteVersion: r.quoteVersion, paymentMethod: asaasMode ? 'ASAAS' : method, expectedTotalCents: total, ...(cpf ? { payerCpf: cpf } : {}) }, { idempotent: true });
    if (!res) return;
    setResult(res);
    if (res.pending) { openPayment(res.paymentUrl); clearDraft(); nav(`/solicitacoes/${r.id}?pagamento=1`); return; }
    if (res.paid) { clearDraft(); nav(`/solicitacoes/${r.id}?confirmado=1`); }
  }
  async function refresh() {
    // Recalcula o orçamento com os mesmos dados (nova versão) e volta à revisão.
    try {
      const fresh = await api<any>('PUT', `/api/care/requests/${r.id}`, {
        need: r.need, itemCode: r.itemCode, infoText: r.infoText ?? '', materials: r.materials, materialsDetail: r.materialsDetail ?? '', materialsSupplyRequested: r.materialsSupplyRequested,
        patientName: r.patientName, phone: r.phone, location: r.location, whenPref: r.whenPref, whenDate: r.whenDate, notes: r.notes ?? '', forSelf: r.forSelf, responsibleAuthorized: r.responsibleAuthorized,
        address: r.address ?? null, patientBirthDate: r.patientBirthDate ?? null, timeWindow: r.timeWindow ?? null, relationship: r.relationship ?? null,
      });
      onChange(fresh.request);
    } catch (e) { pay.setError(e as ApiError); }
  }
  return (
    <div className="flow-card">
      <div className="eyebrow-blue">Confirmar e pagar</div>
      <h1 className="display">{money(total)}</h1>
      <p className="muted">{r.quote.offer.name} · orçamento {r.protocol} v{r.quoteVersion}. Você ainda pode voltar, editar ou desistir.</p>
      {asaasMode ? <AsaasNotice error={pay.error} cpf={cpf} setCpf={setCpf} /> : <fieldset className="radio-list">
        <legend className="small muted">Meio de pagamento (homologação: simulado, sem cobrança real)</legend>
        <label className={method === 'SANDBOX_APROVADO' ? 'selected' : ''}><input type="radio" checked={method === 'SANDBOX_APROVADO'} onChange={() => setMethod('SANDBOX_APROVADO')} /> Cartão de teste — pagamento aprovado</label>
        <label className={method === 'SANDBOX_RECUSADO' ? 'selected' : ''}><input type="radio" checked={method === 'SANDBOX_RECUSADO'} onChange={() => setMethod('SANDBOX_RECUSADO')} /> Cartão de teste — pagamento recusado</label>
      </fieldset>}
      {result && !result.paid && <div className="danger" role="alert">{result.message}</div>}
      {changed ? (
        <div className="caution" role="alert">
          <strong>O valor mudou desde o orçamento.</strong> {pay.error!.message} Novo total: <strong>{money(changed.finalPriceCents)}</strong>.
          <div className="mt"><Button className="deep sm" onClick={refresh}>Atualizar orçamento e revisar</Button></div>
        </div>
      ) : <Alert error={pay.error} />}
      <div className="flow-actions">
        <Button className="green lg" busy={pay.busy} onClick={go}>Confirmar e pagar {money(total)}</Button>
      </div>
      <p className="small muted">Ao confirmar, o desconto PRIME (se houver) é reservado e consumido somente após a confirmação do pagamento. Falha no pagamento não consome o benefício.</p>
    </div>
  );
}

/** Anexos (pedido médico, exame) na revisão: incluir ou remover antes do pagamento. */
function ReviewDocuments({ requestId }: { requestId: string }) {
  const { data, reload } = useApi<any>(`/api/care/requests/${requestId}/documents`);
  const [err, setErr] = useState<string | null>(null);
  async function add(file: File | undefined, kind: string) {
    if (!file) return; setErr(null);
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', await prepareUpload(file));
    try { await api('POST', `/api/care/requests/${requestId}/documents`, fd); reload(); } catch (e: any) { setErr(e?.message ?? 'Falha ao anexar.'); }
  }
  async function remove(id: string) { try { await api('DELETE', `/api/care/requests/${requestId}/documents/${id}`); reload(); } catch (e: any) { setErr(e?.message ?? 'Falha ao remover.'); } }
  const docs = data?.documents ?? [];
  return (
    <div className="mt">
      <h3>Pedido médico e exames</h3>
      {!docs.length ? <p className="small muted mb0">Nenhum anexo.</p> : <ul className="small list">{docs.map((d: any) => (
        <li key={d.id}><DocLink url={`/api/care/requests/${requestId}/documents/${d.id}`} name={d.filename} /> · {d.kind === 'EXAME' ? 'exame' : 'pedido médico'} <button type="button" className="linklike" onClick={() => remove(d.id)}>Remover</button></li>
      ))}</ul>}
      <div className="row small">
        <label className="linklike upload-btn">+ Anexar pedido médico<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { add(e.target.files?.[0], 'PEDIDO_MEDICO'); e.target.value = ''; }} /></label>
        <label className="linklike upload-btn">+ Anexar exame<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { add(e.target.files?.[0], 'EXAME'); e.target.value = ''; }} /></label>
      </div>
      {err && <p className="small err" role="alert">{err}</p>}
    </div>
  );
}

/**
 * "Endereço do atendimento" (A01): mesmo padrão do endereço do cadastro do especialista (logradouro, número com
 * "sem número", UF). Presencial: obrigatório (validação e área de cobertura no servidor). Remoto: opcional.
 */
function AddressFields({ address: a, onChange, error, remote }: { address: Address; onChange: (a: Partial<Address>) => void; error: ApiError | null; remote: boolean }) {
  const cepDigits = a.cep.replace(/\D/g, '');
  return (
    <fieldset className="address-grid">
      <legend className="h-sub">Endereço do atendimento</legend>
      {remote && <p className="small muted">Atendimento on-line: o endereço é opcional e serve apenas para o cadastro do atendimento. Informe ao menos o bairro ou a cidade.</p>}
      <div className="form-grid">
        <Field label={remote ? 'CEP (opcional)' : 'CEP'} error={fieldError(error, 'address.cep')}><input type="text" inputMode="numeric" autoComplete="postal-code" value={a.cep} maxLength={9} onChange={(e) => onChange({ cep: e.target.value })} placeholder="00000-000" /></Field>
        <Field label="Logradouro (rua, avenida)" error={fieldError(error, 'address.street')}><input type="text" autoComplete="address-line1" value={a.street} onChange={(e) => onChange({ street: e.target.value })} /></Field>
        <Field label="Número" error={fieldError(error, 'address.number')}><input type="text" disabled={a.noNumber} value={a.noNumber ? '' : a.number} maxLength={20} onChange={(e) => onChange({ number: e.target.value })} /></Field>
        <Field label="Complemento (opcional)"><input type="text" autoComplete="address-line2" value={a.complement} maxLength={80} onChange={(e) => onChange({ complement: e.target.value })} placeholder="Apto, bloco" /></Field>
        <Field label="Bairro" error={fieldError(error, 'address.district') ?? fieldError(error, 'location')}><input type="text" value={a.district} onChange={(e) => onChange({ district: e.target.value })} /></Field>
        <Field label="Cidade" error={fieldError(error, 'address.city')}><input type="text" autoComplete="address-level2" value={a.city} onChange={(e) => onChange({ city: e.target.value })} /></Field>
        <Field label="UF" error={fieldError(error, 'address.uf')}><select value={a.uf} onChange={(e) => onChange({ uf: e.target.value })}><option value="">Selecione</option>{UFS.map((u) => <option key={u}>{u}</option>)}</select></Field>
      </div>
      <label className="choice"><input type="checkbox" checked={a.noNumber} onChange={(e) => onChange({ noNumber: e.target.checked, number: e.target.checked ? '' : a.number })} /><span>Sem número</span></label>
      <Field label="Ponto de referência (opcional)"><input type="text" value={a.reference} maxLength={160} onChange={(e) => onChange({ reference: e.target.value })} /></Field>
      {remote && cepDigits.length === 8 && !inServiceArea(a.cep) && <p className="small muted">CEP fora da área de atendimento presencial: para o atendimento on-line o endereço não é salvo, e você pode continuar normalmente.</p>}
      {!remote && <p className="small muted">O endereço completo só é mostrado à especialista depois que ela aceita o atendimento.</p>}
    </fieldset>
  );
}
