import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { inServiceArea } from '../lib/coverage';
import { Button, Dialog, Field } from './ui';

const KEY = 'onema.cobertura.cep';
const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

/**
 * Área de atendimento (RT, 13/11/2026): toda a cidade de São Paulo. Ao entrar na solicitação, a pessoa informa o CEP;
 * fora da área, explicamos antes de qualquer cadastro ou pagamento. O servidor confere de novo o CEP do endereço.
 */
export function CoverageGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => { const c = saved(); return !!c && inServiceArea(c); });
  const [cep, setCep] = useState('');
  const [out, setOut] = useState(false);
  function check() {
    if (cep.replace(/\D/g, '').length !== 8) return;
    if (inServiceArea(cep)) { try { localStorage.setItem(KEY, cep); } catch { /* sem armazenamento */ } setOk(true); }
    else setOut(true);
  }
  return (
    <>
      {children}
      <Dialog open={!ok} title="Onde será o atendimento?" onClose={() => { /* obrigatório */ }}>
        {!out ? (
          <>
            <p>A ONEMA SAÚDE atende em <strong>toda a cidade de São Paulo</strong>. Informe o CEP de onde o cuidado será realizado.</p>
            <Field label="CEP do atendimento"><input type="text" inputMode="numeric" autoComplete="postal-code" maxLength={9} value={cep}
              onChange={(e) => setCep(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') check(); }} placeholder="00000-000" /></Field>
            <Button className="deep block" disabled={cep.replace(/\D/g, '').length !== 8} onClick={check}>Continuar</Button>
          </>
        ) : (
          <>
            <p><strong>Ainda não atendemos nesse CEP.</strong> No momento, os atendimentos são somente na cidade de São Paulo.</p>
            <p className="small muted">Fale com a gente pelo e-mail atendimento@onemasaude.com.br para saber quando chegaremos à sua região.</p>
            <div className="row"><button type="button" className="btn secondary" onClick={() => { setOut(false); setCep(''); }}>Tentar outro CEP</button>
              <Link to="/" className="btn deep">Voltar ao início</Link></div>
          </>
        )}
      </Dialog>
    </>
  );
}
