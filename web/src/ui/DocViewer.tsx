import { useEffect, useState } from 'react';
import { Dialog } from './ui';

/**
 * Abre um documento protegido DENTRO do app: baixa com a sessão atual (fetch same-origin) e mostra a imagem ou o PDF.
 * Evita abrir o endereço da API em outra aba — no app instalado (PWA) a outra aba não leva a sessão e o servidor
 * respondia "Autenticação necessária". Nunca mostra resposta técnica bruta ao usuário.
 */
export function DocLink({ url, name, className = 'linklike' }: { url: string; name: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button type="button" className={className} onClick={() => setOpen(true)}>{name}</button>
    {open && <DocViewer url={url} name={name} onClose={() => setOpen(false)} />}
  </>);
}

function DocViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const [state, setState] = useState<{ blob: string; type: string } | { error: string } | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
          let msg = 'Não foi possível abrir o documento agora.';
          try { const j = await res.json(); if (res.status === 401) msg = 'Sua sessão expirou. Entre novamente para abrir o documento.'; else if (j?.error?.message) msg = j.error.message; } catch { /* sem corpo */ }
          setState({ error: msg }); return;
        }
        const b = await res.blob();
        objectUrl = URL.createObjectURL(b);
        setState({ blob: objectUrl, type: b.type || res.headers.get('content-type') || '' });
      } catch { setState({ error: 'Sem conexão. Verifique sua internet e tente de novo.' }); }
    })();
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  return (
    <Dialog open title={name} onClose={onClose}>
      {!state ? <p className="muted" role="status">Carregando documento…</p>
        : 'error' in state ? <div className="danger" role="alert">{state.error}</div>
        : (
          <div className="doc-viewer">
            {state.type.startsWith('image/') ? <img src={state.blob} alt={name} />
              : <iframe src={state.blob} title={name} />}
            <p className="small mt"><a className="btn sm secondary" href={state.blob} download={name}>Baixar arquivo</a>
              {!state.type.startsWith('image/') && <span className="muted"> Se o PDF não aparecer no celular, toque em "Baixar arquivo".</span>}</p>
          </div>
        )}
    </Dialog>
  );
}
