import { useId } from 'react';

/** Traçado do "S" oficial (ícone do app), em viewBox 0 0 200 200. */
export const S_TOP = 'M137.7 80.7 A37.8 33.2 0 1 0 99.9 113.9';
export const S_BOTTOM = 'M99.9 85.8 A37.8 33.2 0 1 1 62.1 119';

/** Logotipo oficial horizontal (ícone + ONEMA SAÚDE + slogan). */
export function Logo({ height = 40, className = '' }: { height?: number; className?: string }) {
  return <img src="/icons/logo-onema-saude.png" alt="ONEMA SAÚDE — Sua saúde organizada sempre com você" height={height} style={{ height, width: 'auto' }} className={className} />;
}

/** Ícone oficial do app (quadrado arredondado azul com o S). */
export function AppIcon({ size = 44, className = '' }: { size?: number; className?: string }) {
  return <img src="/icons/icon-192.png" alt="" aria-hidden width={size} height={size} className={className} style={{ borderRadius: size * 0.22 }} />;
}

/** "S" vetorial nas cores oficiais (azul em cima, verde embaixo). */
export function SMark({ size = 48, stroke = 16.6 }: { size?: number; stroke?: number }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" aria-hidden>
      <defs>
        <linearGradient id={`b${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3D8BFF" /><stop offset="1" stopColor="#0A6CFF" /></linearGradient>
      </defs>
      <path d={S_TOP} fill="none" stroke={`url(#b${id})`} strokeWidth={stroke} strokeLinecap="round" />
      <path d={S_BOTTOM} fill="none" stroke="#00C2A8" strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}
