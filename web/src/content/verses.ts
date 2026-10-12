/**
 * "Café com a ONEMA" — uma pausa para o coração (conteúdo OPCIONAL, pode ser ocultado pelo usuário).
 * Um versículo por dia (fuso de São Paulo), em sequência. Textos curtos citados com a referência;
 * tradução e seleção devem ser conferidas pela ONEMA antes da publicação final.
 */
export interface Verse { text: string; ref: string; reflection: string }

export const VERSES: Verse[] = [
  { text: 'Não temas, porque eu estou contigo; não te assombres, porque eu sou o teu Deus.', ref: 'Isaías 41:10', reflection: 'Cuidar e ser cuidado começa com a certeza de que não estamos sozinhos.' },
  { text: 'O Senhor é o meu pastor; nada me faltará.', ref: 'Salmos 23:1', reflection: 'Hoje, descanse naquilo que já foi provido e agradeça pelo essencial.' },
  { text: 'Vinde a mim, todos os que estais cansados e sobrecarregados, e eu vos aliviarei.', ref: 'Mateus 11:28', reflection: 'Permita-se pausar. Cansaço também pede cuidado.' },
  { text: 'Tudo posso naquele que me fortalece.', ref: 'Filipenses 4:13', reflection: 'Força não é ausência de dificuldade, é seguir com fé um passo de cada vez.' },
  { text: 'Lança o teu cuidado sobre o Senhor, e ele te susterá.', ref: 'Salmos 55:22', reflection: 'Entregue o que não depende de você e faça bem o que depende.' },
  { text: 'O amor é paciente, o amor é bondoso.', ref: '1 Coríntios 13:4', reflection: 'Paciência e bondade são remédios que todos podemos oferecer hoje.' },
  { text: 'Sede fortes e corajosos; não temais, porque o Senhor, vosso Deus, vai convosco.', ref: 'Deuteronômio 31:6', reflection: 'A coragem cresce quando lembramos de quem caminha conosco.' },
  { text: 'O choro pode durar uma noite, mas a alegria vem pela manhã.', ref: 'Salmos 30:5', reflection: 'Dias difíceis passam. Guarde esperança para a manhã que vem.' },
  { text: 'Alegrai-vos na esperança, sede pacientes na tribulação, perseverai na oração.', ref: 'Romanos 12:12', reflection: 'Esperança, paciência e oração: três apoios para atravessar o dia.' },
  { text: 'Deixo-vos a paz, a minha paz vos dou.', ref: 'João 14:27', reflection: 'Que a paz encontre espaço no seu coração e na sua casa hoje.' },
  { text: 'Entrega o teu caminho ao Senhor, confia nele, e ele tudo fará.', ref: 'Salmos 37:5', reflection: 'Confiar também é cuidar: alivia o peso de querer controlar tudo.' },
  { text: 'Levarei as cargas uns dos outros.', ref: 'Gálatas 6:2', reflection: 'Ninguém precisa carregar tudo sozinho. Pedir ajuda é sabedoria.' },
  { text: 'O coração alegre é bom remédio.', ref: 'Provérbios 17:22', reflection: 'Procure hoje um motivo simples para sorrir e compartilhe.' },
  { text: 'Ele sara os de coração quebrantado e lhes pensa as feridas.', ref: 'Salmos 147:3', reflection: 'Toda ferida merece cuidado — as do corpo e as da alma.' },
  { text: 'Buscai primeiro o Reino de Deus, e todas estas coisas vos serão acrescentadas.', ref: 'Mateus 6:33', reflection: 'Prioridades certas trazem leveza para as escolhas do dia.' },
  { text: 'Esperem no Senhor e renovarão as suas forças.', ref: 'Isaías 40:31', reflection: 'Renovar as forças é possível. Respire e recomece.' },
  { text: 'Em paz me deito e logo pego no sono, porque só tu, Senhor, me fazes repousar seguro.', ref: 'Salmos 4:8', reflection: 'Um bom descanso também faz parte da recuperação.' },
  { text: 'Amarás o teu próximo como a ti mesmo.', ref: 'Marcos 12:31', reflection: 'Cuidar do outro começa com olhar atento e respeito.' },
  { text: 'Não andeis ansiosos por coisa alguma.', ref: 'Filipenses 4:6', reflection: 'Transforme a preocupação de hoje em um pedido e um passo prático.' },
  { text: 'Bem-aventurados os misericordiosos, porque alcançarão misericórdia.', ref: 'Mateus 5:7', reflection: 'Gentileza volta. Seja gentil consigo e com quem está perto.' },
  { text: 'Os que semeiam com lágrimas com alegria ceifarão.', ref: 'Salmos 126:5', reflection: 'O esforço de hoje, mesmo silencioso, tem valor.' },
  { text: 'Tudo tem o seu tempo determinado.', ref: 'Eclesiastes 3:1', reflection: 'Respeite o tempo da recuperação — o seu e o de quem você ama.' },
  { text: 'Sejam bondosos e compassivos uns para com os outros.', ref: 'Efésios 4:32', reflection: 'Compaixão é a base de todo cuidado verdadeiro.' },
  { text: 'O Senhor é a minha luz e a minha salvação; a quem temerei?', ref: 'Salmos 27:1', reflection: 'Mesmo nos dias escuros, há luz para o próximo passo.' },
  { text: 'A minha graça te basta, porque o meu poder se aperfeiçoa na fraqueza.', ref: '2 Coríntios 12:9', reflection: 'Reconhecer limites é parte de ser forte.' },
  { text: 'Confia no Senhor de todo o teu coração.', ref: 'Provérbios 3:5', reflection: 'Confiança tranquiliza o coração e clareia as decisões.' },
  { text: 'Eis que estou convosco todos os dias.', ref: 'Mateus 28:20', reflection: 'Todos os dias — inclusive hoje.' },
  { text: 'Deus é o nosso refúgio e fortaleza, socorro bem presente na angústia.', ref: 'Salmos 46:1', reflection: 'Ter onde se apoiar faz toda a diferença.' },
  { text: 'Fiel é o que prometeu.', ref: 'Hebreus 10:23', reflection: 'Promessas cumpridas constroem confiança — no cuidado e na vida.' },
  { text: 'Este é o dia que o Senhor fez; regozijemo-nos e alegremo-nos nele.', ref: 'Salmos 118:24', reflection: 'Que hoje seja vivido com gratidão.' },
  { text: 'Se Deus é por nós, quem será contra nós?', ref: 'Romanos 8:31', reflection: 'Siga em frente com confiança.' },
  { text: 'Não se turbe o vosso coração.', ref: 'João 14:1', reflection: 'Acalme o coração: um passo de cada vez.' },
  { text: 'O Senhor te guardará de todo mal; ele guardará a tua alma.', ref: 'Salmos 121:7', reflection: 'Que você e os seus estejam guardados hoje.' },
  { text: 'Deem graças em todas as circunstâncias.', ref: '1 Tessalonicenses 5:18', reflection: 'Gratidão muda a forma como enxergamos o dia.' },
  { text: 'Ainda que eu ande pelo vale da sombra da morte, não temerei mal nenhum, porque tu estás comigo.', ref: 'Salmos 23:4', reflection: 'Nos momentos mais difíceis, presença é o que mais conforta.' },
  { text: 'Porque sou eu que conheço os planos que tenho para vocês: planos de paz e não de mal, para dar a vocês esperança e um futuro.', ref: 'Jeremias 29:11', reflection: 'Há esperança e futuro adiante.' },
  { text: 'Cada um exerça o dom que recebeu para servir os outros.', ref: '1 Pedro 4:10', reflection: 'Servir com o seu dom é uma forma bonita de cuidar.' },
  { text: 'Grandes coisas fez o Senhor por nós, e por isso estamos alegres.', ref: 'Salmos 126:3', reflection: 'Lembre-se de uma vitória recente e celebre.' },
  { text: 'Sobre tudo o que se deve guardar, guarda o teu coração.', ref: 'Provérbios 4:23', reflection: 'Proteja sua paz: ela sustenta todo o resto.' },
  { text: 'A esperança não confunde.', ref: 'Romanos 5:5', reflection: 'Mantenha a esperança acesa — ela sustenta o cuidado.' },
];

/** Índice do dia em São Paulo (troca à meia-noite local). */
export function dayIndex(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return Math.floor(Date.parse(`${p}T00:00:00Z`) / 86400000);
}
export const dailyVerse = (d = new Date()) => VERSES[((dayIndex(d) % VERSES.length) + VERSES.length) % VERSES.length];
