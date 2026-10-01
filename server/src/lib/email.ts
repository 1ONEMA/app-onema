/**
 * Envio de e-mail transacional (recuperação de senha, convite de responsável).
 * DESLIGADO por padrão: só envia quando RESEND_API_KEY e EMAIL_FROM estão definidos no painel da hospedagem
 * (a configuração é a autorização expressa para o envio do endereço do destinatário a esse provedor).
 * Conteúdo mínimo: nenhuma informação de saúde no corpo da mensagem.
 */
export const emailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

export interface Mail { to: string; subject: string; text: string; html: string }

export async function sendEmail(m: Mail): Promise<{ sent: boolean; error?: string }> {
  if (!emailConfigured()) return { sent: false, error: 'SEM_PROVEDOR' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { sent: false, error: `HTTP_${res.status}` };
    return { sent: true };
  } catch (e: any) {
    return { sent: false, error: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'REDE' };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Layout simples com a identidade ONEMA (sem imagens externas, sem rastreamento). */
export function layout(title: string, paragraphs: string[], cta?: { label: string; url: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('');
  const button = cta ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#00307E;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block;font-weight:bold">${esc(cta.label)}</a></p>
    <p style="margin:0 0 14px;font-size:12px;color:#53627A">Se o botão não funcionar, copie este endereço no navegador:<br>${esc(cta.url)}</p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F3F6FA;font-family:Helvetica,Arial,sans-serif;color:#1C2B45">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="font-weight:bold;font-size:20px;color:#00307E;margin-bottom:16px">ONEMA SAÚDE</div>
    <div style="background:#fff;border-radius:16px;padding:24px;border:1px solid #D5DFEA">
      <h1 style="font-size:18px;margin:0 0 14px;color:#00307E">${esc(title)}</h1>${body}${button}
    </div>
    <p style="font-size:11px;color:#53627A;margin-top:16px">Mensagem automática. Não responda este e-mail.</p>
  </div></body></html>`;
  const text = [title, '', ...paragraphs, ...(cta ? ['', `${cta.label}: ${cta.url}`] : [])].join('\n');
  return { html, text };
}
