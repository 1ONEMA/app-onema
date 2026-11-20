import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Dialog } from './ui';
import './doc-viewer.css';

/**
 * Abre um documento protegido DENTRO do app: baixa com a sessão atual (fetch same-origin) e mostra a imagem ou o PDF
 * no próprio visualizador (Ajuste 07). O PDF é desenhado página a página em <canvas> pelo pdf.js — no Android/PWA o
 * <iframe> do PDF ficava em branco. Não há botão de baixar, imprimir, compartilhar nem abrir fora do app.
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

const ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.25;
const PARSE_ERROR = 'Não foi possível exibir este documento agora.';

/** pdf.js carregado sob demanda (fica fora do pacote principal); worker configurado do jeito do Vite. */
let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
      .then(([lib, worker]) => { lib.GlobalWorkerOptions.workerSrc = worker.default; return lib; })
      .catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'image'; src: string }
  | { kind: 'pdf'; doc: PDFDocumentProxy };

const blockMenu = (e: React.SyntheticEvent) => e.preventDefault();

function DocViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    let loadingTask: { destroy(): Promise<void> } | null = null;
    setState({ kind: 'loading' }); setPage(1); setZoom(1);
    (async () => {
      let res: Response;
      try { res = await fetch(url, { credentials: 'same-origin' }); }
      catch { if (!cancelled) setState({ kind: 'error', message: 'Sem conexão. Verifique sua internet e tente de novo.' }); return; }
      if (!res.ok) {
        let msg = 'Não foi possível abrir o documento agora.';
        try { const j = await res.json(); if (res.status === 401) msg = 'Sua sessão expirou. Entre novamente para abrir o documento.'; else if (j?.error?.message) msg = j.error.message; } catch { /* sem corpo */ }
        if (!cancelled) setState({ kind: 'error', message: msg });
        return;
      }
      try {
        const b = await res.blob();
        const type = b.type || res.headers.get('content-type') || '';
        if (cancelled) return;
        if (type.startsWith('image/')) {
          objectUrl = URL.createObjectURL(b);
          setState({ kind: 'image', src: objectUrl });
          return;
        }
        const pdfjs = await loadPdfjs();
        const data = new Uint8Array(await b.arrayBuffer());
        if (cancelled) return;
        const task = pdfjs.getDocument({ data, enableXfa: false });
        loadingTask = task;
        const doc = await task.promise;
        if (cancelled) return;
        setState({ kind: 'pdf', doc });
      } catch {
        if (!cancelled) setState({ kind: 'error', message: PARSE_ERROR });
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (loadingTask) void loadingTask.destroy().catch(() => {});
    };
  }, [url, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const onRenderError = useCallback(() => setState({ kind: 'error', message: PARSE_ERROR }), []);
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));
  const pages = state.kind === 'pdf' ? state.doc.numPages : 0;

  return (
    <Dialog open title={name} onClose={onClose}>
      <div className="doc-viewer dv">
        {state.kind === 'loading' && <p className="muted" role="status">Carregando documento…</p>}
        {state.kind === 'error' && (
          <div className="dv-error">
            <div className="danger" role="alert">{state.message}</div>
            <div className="row mt">
              <button type="button" className="btn sm" onClick={retry} aria-label="Tentar abrir o documento novamente">Tentar novamente</button>
              <button type="button" className="btn sm secondary" onClick={onClose} aria-label="Fechar documento">Fechar</button>
            </div>
          </div>
        )}
        {(state.kind === 'image' || state.kind === 'pdf') && (<>
          <div className="dv-toolbar" role="toolbar" aria-label="Controles do documento">
            {state.kind === 'pdf' && (
              <div className="dv-group">
                <button type="button" className="btn sm secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} aria-label="Página anterior">‹ Anterior</button>
                <span className="dv-status" role="status" aria-live="polite">Página {page} de {pages}</span>
                <button type="button" className="btn sm secondary" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} aria-label="Próxima página">Próxima ›</button>
              </div>
            )}
            <div className="dv-group">
              <button type="button" className="btn sm secondary" onClick={zoomOut} disabled={zoom <= ZOOM_MIN} aria-label="Diminuir zoom">−</button>
              <button type="button" className="btn sm ghost" onClick={() => setZoom(1)} aria-label="Restaurar tamanho original">{Math.round(zoom * 100)}%</button>
              <button type="button" className="btn sm secondary" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} aria-label="Aumentar zoom">+</button>
            </div>
            <button type="button" className="btn sm" onClick={onClose} aria-label="Fechar documento">Fechar</button>
          </div>
          <div className="dv-stage" onContextMenu={blockMenu} onDragStart={blockMenu}>
            {state.kind === 'image'
              ? <img className="dv-content" src={state.src} alt={name} draggable={false} onContextMenu={blockMenu}
                  style={{ width: `${zoom * 100}%` }} />
              : <PdfPage doc={state.doc} page={page} zoom={zoom} name={name} onError={onRenderError} />}
          </div>
        </>)}
      </div>
    </Dialog>
  );
}

/** Desenha uma página do PDF em <canvas>, ajustada à largura disponível × zoom, nítida em telas de alta densidade. */
function PdfPage({ doc, page, zoom, name, onError }: { doc: PDFDocumentProxy; page: number; zoom: number; name: string; onError: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!width || !canvasRef.current) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    setRendering(true);
    (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const cssScale = (width / base.width) * zoom;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const viewport = p.getViewport({ scale: cssScale * dpr });
        const canvas = canvasRef.current!;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        task = p.render({ canvas, viewport });
        await task.promise;
        if (!cancelled) setRendering(false);
      } catch (e: any) {
        if (cancelled || e?.name === 'RenderingCancelledException') return;
        onError();
      }
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, page, zoom, width, onError]);

  return (
    <div ref={boxRef} className="dv-pdf">
      {rendering && <p className="muted small dv-rendering">Carregando página…</p>}
      <canvas ref={canvasRef} className="dv-content" role="img" aria-label={`${name} — página ${page}`}
        draggable={false} onContextMenu={blockMenu} />
    </div>
  );
}
