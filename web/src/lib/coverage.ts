/**
 * Área de atendimento (decisão do RT, 13/11/2026): toda a cidade de São Paulo.
 * Faixas de CEP do município de São Paulo (Correios): 01000-000 a 05999-999 e 08000-000 a 08499-999.
 */
export function inServiceArea(cep: string): boolean {
  const n = Number(String(cep).replace(/\D/g, ''));
  if (!Number.isFinite(n) || String(cep).replace(/\D/g, '').length !== 8) return false;
  return (n >= 1000000 && n <= 5999999) || (n >= 8000000 && n <= 8499999);
}
export const SERVICE_AREA_LABEL = 'cidade de São Paulo';
