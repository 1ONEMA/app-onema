import { z } from 'zod';

/** Validação dos dígitos verificadores do CPF. */
export function validCpf(raw: string) {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}
export const cpfSchema = z.string().trim().refine(validCpf, 'CPF inválido.').transform((v) => v.replace(/\D/g, ''));
