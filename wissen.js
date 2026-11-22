/**
 * wissen.js – Startwissen fürs Familien-Gedächtnis
 * ------------------------------------------------------------------
 * Diese Einträge werden beim ersten Start einmalig in das gemeinsame
 * Gedächtnis (Firebase: lists/{LIST_ID}/wissen) übernommen. Danach
 * lassen sie sich in der App unter 💬 Helfer → „🧠 Das weiß ich über
 * euch" ändern oder löschen – wie alles, was Mama später ergänzt.
 *
 * Arten:
 *  - Vorliebe:  { id, text }
 *  - Ersetzung: { id, text, wenn, dann } → wer "wenn" einträgt,
 *               bekommt automatisch "dann" auf die Liste.
 *
 * Wird auch vom Küchenhelfer und von den Wochenrezepten genutzt.
 * ------------------------------------------------------------------
 */

export const START_WISSEN = [
  { id: 'start-haushalt', text: 'Wir kaufen meist für 3 Personen ein (Mama, Papa und Sohn). Manchmal sind die beiden Geschwister da – dann sind wir 5.' },
  { id: 'start-eiweiss', text: 'Wir kochen gern eiweißreich: viel Hähnchen, eher wenig Schweinefleisch.' },
  { id: 'start-skyr', text: 'Skyr wird sehr viel gegessen (Mama und Sohn) – immer reichlich einplanen.' },
  { id: 'start-unvertraeglich', text: 'Keine Unverträglichkeiten und keine Abneigungen – es wird alles gegessen.' },
  { id: 'start-kochzeit', text: 'Rezepte unter der Woche dürfen 45–60 Minuten dauern.' },
  { id: 'start-marken', text: 'Meist darf es günstig sein (Angebote, Eigenmarken), bei manchen Produkten gibt es aber eine feste Lieblingsmarke.' },
  { id: 'start-milch', text: 'Milch immer mit 1,5 % Fett.', wenn: 'Milch', dann: 'Milch 1,5 %' },
  { id: 'start-skyr-natur', text: 'Skyr meistens Natur.', wenn: 'Skyr', dann: 'Skyr Natur' }
];
