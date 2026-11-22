/**
 * wissen.js – Startwissen fürs Familien-Gedächtnis
 * ------------------------------------------------------------------
 * Diese Einträge werden einmalig in das gemeinsame Gedächtnis
 * (Firebase: lists/{LIST_ID}/wissen) übernommen. Danach lassen sie
 * sich in der App unter 💬 Helfer → „🧠 Das weiß ich über euch"
 * ändern oder löschen – wie alles, was Mama später ergänzt.
 *
 * Neue Einträge: mit höherer "seit"-Version anhängen und
 * WISSEN_VERSION hochzählen – dann kommen nur die neuen Punkte dazu,
 * Gelöschtes bleibt gelöscht.
 *
 * Arten:
 *  - Vorliebe:  { id, text }
 *  - Ersetzung: { id, text, wenn, dann } → wer "wenn" einträgt,
 *               bekommt automatisch "dann" auf die Liste.
 *
 * Wird auch vom Küchenhelfer und von den Wochenrezepten genutzt.
 * ------------------------------------------------------------------
 */

export const WISSEN_VERSION = 2;

export const START_WISSEN = [
  // Version 1
  { id: 'start-haushalt', seit: 1, text: 'Wir kaufen meist für 3 Personen ein (Mama, Papa und Sohn). Manchmal sind die beiden Geschwister da – dann sind wir 5.' },
  { id: 'start-eiweiss', seit: 1, text: 'Wir kochen gern eiweißreich: viel Hähnchen, eher wenig Schweinefleisch.' },
  { id: 'start-skyr', seit: 1, text: 'Skyr wird sehr viel gegessen (Mama und Sohn) – immer reichlich einplanen.' },
  { id: 'start-unvertraeglich', seit: 1, text: 'Keine Unverträglichkeiten und keine Abneigungen – es wird alles gegessen.' },
  { id: 'start-kochzeit', seit: 1, text: 'Rezepte unter der Woche dürfen 45–60 Minuten dauern.' },
  { id: 'start-marken', seit: 1, text: 'Meist darf es günstig sein (Angebote, Eigenmarken), bei manchen Produkten gibt es aber eine feste Lieblingsmarke.' },
  { id: 'start-milch', seit: 1, text: 'Milch immer mit 1,5 % Fett.', wenn: 'Milch', dann: 'Milch 1,5 %' },
  { id: 'start-skyr-natur', seit: 1, text: 'Skyr meistens Natur.', wenn: 'Skyr', dann: 'Skyr Natur' },
  // Version 2
  { id: 'start-samstag', seit: 2, text: 'Mama kauft fast immer samstags ein – für die ganze Woche.' },
  { id: 'start-wochenende', seit: 2, text: 'Samstags und sonntags gibt es Brötchen-Frühstück. Die Samstagsbrötchen kauft Mama beim Wocheneinkauf mit, die Sonntagsbrötchen holt Papa selbst. Aufschnitt für beide Tage kauft Mama samstags.' },
  { id: 'start-fruehstueck', seit: 2, text: 'Unter der Woche gibt es zum Frühstück meist Nüsse und Haferflocken mit Milch und Joghurt.' },
  { id: 'start-skyr-sohn', seit: 2, text: 'Der Sohn isst jeden Tag etwa 500 g Skyr mit gefrorenen Beeren – allein dafür ca. 3,5 kg Skyr pro Woche.' },
  { id: 'start-getraenke', seit: 2, text: 'Getränke: Wasser mit Kohlensäure und immer Orangensaft.', wenn: 'Wasser', dann: 'Wasser mit Kohlensäure' },
  { id: 'start-kuchen', seit: 2, text: 'Kuchen gibt es nur ab und zu, nicht an festen Tagen.' }
];

/**
 * Wocheneinkauf am Samstag: Diese Sachen werden fast jede Woche gekauft.
 * Ab Donnerstag zeigt die App sie als „Fehlt noch was?"-Check an.
 */
export const WOCHENEINKAUF = [
  { name: 'Brötchen (Samstag)' },
  { name: 'Aufschnitt fürs Wochenende' },
  { name: 'Skyr Natur', qty: 'ca. 4–5 kg' },
  { name: 'Tiefkühl-Beeren' },
  { name: 'Milch 1,5 %' },
  { name: 'Joghurt' },
  { name: 'Haferflocken' },
  { name: 'Nüsse' },
  { name: 'Wasser mit Kohlensäure' },
  { name: 'Orangensaft' }
];
