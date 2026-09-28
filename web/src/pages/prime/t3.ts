import { useApi } from '../../lib/hooks';

/** Textos T3 aprovados (escolhas e confirmações), usados literalmente nos rótulos. */
export function useT3() {
  const { data } = useApi<any>('/api/prime/texts/T3');
  const doc = data ? JSON.parse(data.body) : null;
  const find = (prefix: string) => {
    const s = doc?.sections.find((x: any) => x.heading.startsWith(prefix));
    return s ? s.paragraphs.join(' ').replace(/^“|”$/g, '') : '';
  };
  return {
    loaded: !!doc,
    mandatory: find('Checkbox obrigatório'),
    reminders: find('Checkbox opcional de lembretes'),
    summary: find('Checkbox opcional de resumo'),
    marketing: find('Checkbox opcional de marketing'),
    channels: find('Seleção de canal'),
    invite: find('Convite a responsável'),
    version: data?.version as string | undefined,
  };
}
