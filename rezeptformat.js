/**
 * rezeptformat.js – Rezepte im „Rezept für Mama“-Textformat lesen
 * ------------------------------------------------------------------
 * Eine externe KI (eigenes ChatGPT-GPT oder Claude-Projekt, siehe
 * docs/rezept-fuer-mama.md) schreibt Rezepte in diesem Format. Die App
 * erkennt es beim Einfügen oder Teilen und legt das Rezept ohne
 * eigene KI direkt im Kochbuch an.
 *
 *   REZEPT
 *   Titel: Omas Apfelkuchen
 *   Emoji: 🍰
 *   Kategorie: Kuchen & Backen
 *   Portionen: 12
 *   Zeit: 75 Minuten
 *   Schwierigkeit: einfach
 *   Beschreibung: Saftiger Rührkuchen mit Äpfeln vom Blech.
 *
 *   ZUTATEN
 *   - 200 g | Mehl | Vorrat
 *   - 4 | Äpfel
 *
 *   ZUBEREITUNG
 *   1. Ofen auf 180 °C vorheizen.
 *   2. 45 Minuten backen.
 *
 *   HINWEIS: Backzeit war schlecht lesbar.   (optional)
 *   ENDE
 *
 * Der Parser ist bewusst nachsichtig: Markdown (**fett**, ### Überschrift),
 * andere Aufzählungszeichen, fehlende „|“ und mehrere Rezepte in einem
 * Text werden verkraftet.
 * ------------------------------------------------------------------
 */

const KATEGORIEN = ['Hauptgerichte', 'Schnelle Gerichte', 'Frühstück', 'Suppen & Eintöpfe', 'Salate & Beilagen', 'Kuchen & Backen'];

const VORRAT_RE = /^(salz|pfeffer|salz (und|&) pfeffer|zucker|mehl|öl|oel|olivenöl|sonnenblumenöl|rapsöl|speiseöl|wasser|essig|backpulver|natron|gemüsebrühe|brühe|paprikapulver|zimt|muskat|oregano|basilikum \(getrocknet\)|currypulver|chiliflocken|vanillezucker|puderzucker)\b/i;

const EINHEIT = '(?:g|gr\\.?|kg|mg|ml|cl|dl|l|liter|el|tl|msp\\.?|prise[n]?|stück|stk\\.?|pck\\.?|päckchen|packung(?:en)?|becher|dose[n]?|glas|gläser|bund|zehe[n]?|scheibe[n]?|tasse[n]?|würfel|zweig[e]?|handvoll|blatt|blätter|kopf|köpfe|stange[n]?|knolle[n]?|beutel|tüte[n]?|flasche[n]?|schuss|spritzer|tropfen)';
const ZAHL = '(?:ca\\.\\s*)?(?:\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔⅛])(?:\\s*(?:-|–|bis)\\s*(?:\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔]))?(?:\\s*[½¼¾⅓⅔])?(?:\\s*\\/\\s*\\d+)?';
const MENGE_VORNE = new RegExp(`^(${ZAHL}\\s*(?:${EINHEIT}\\.?(?![a-zäöüß]))?|(?:etwas|einige|ein paar|1 prise|eine prise|nach geschmack|n\\. ?b\\.)(?![a-zäöüß]))\\s*(.+)$`, 'i');
const SIEHT_AUS_WIE_MENGE = new RegExp(`^(${ZAHL}|etwas|einige|ein paar|eine?|nach geschmack|n\\. ?b\\.|${EINHEIT}\\b)`, 'i');

/** Markdown und Schmuckzeichen von einer Zeile entfernen. */
function clean(line) {
  return String(line)
    .replace(/ /g, ' ')
    .replace(/^\s*>+\s?/, '')          // Zitat
    .replace(/^\s*#{1,6}\s*/, '')      // Überschrift
    .replace(/\*\*|__|`/g, '')         // fett, Code
    .replace(/^\s*\*(?=\S)(.*)\*\s*$/, '$1') // *kursiv*
    .trim();
}

function plain(text) {
  return String(text).toLowerCase().normalize('NFC').replace(/[:：]\s*$/, '').trim();
}

/** Abschnitts-Überschrift? → 'zutaten' | 'schritte' | null */
function sectionOf(line) {
  const t = plain(line).replace(/^[^a-zäöü]+/, '').replace(/\s*\(.*\)\s*$/, '');
  if (/^(zutaten|zutatenliste|einkaufsliste|du brauchst|ingredients)$/.test(t)) return 'zutaten';
  if (/^(zubereitung|schritte|anleitung|so geht'?s|so wird'?s gemacht|arbeitsschritte|instructions)$/.test(t)) return 'schritte';
  return null;
}

const FELDER = {
  titel: 'titel', name: 'titel', rezept: 'titel', rezeptname: 'titel',
  emoji: 'emoji',
  kategorie: 'kategorie',
  portionen: 'portionen', personen: 'portionen',
  zeit: 'zeit', dauer: 'zeit', gesamtzeit: 'zeit', zubereitungszeit: 'zeit',
  schwierigkeit: 'schwierigkeit',
  beschreibung: 'beschreibung', kurzbeschreibung: 'beschreibung',
  hinweis: 'hinweis', hinweise: 'hinweis', tipp: 'hinweis', notiz: 'hinweis',
  quelle: 'quelle'
};

/** „Schlüssel: Wert“ → [feld, wert] */
function fieldOf(line) {
  const m = line.match(/^[-•*]?\s*([A-Za-zÄÖÜäöüß]+)\s*[:：]\s*(.*)$/);
  if (!m) return null;
  const feld = FELDER[m[1].toLowerCase()];
  return feld ? [feld, m[2].trim()] : null;
}

/** „75 Minuten“, „1 Std. 15 Min.“, „1,5 Stunden“ → Minuten */
export function parseMinuten(text) {
  const t = String(text).toLowerCase().replace(',', '.');
  let min = 0;
  const h = t.match(/(\d+(?:\.\d+)?)\s*(?:std|stunde|h\b)/);
  const m = t.match(/(\d+)\s*(?:min|minute)/);
  if (h) min += Number(h[1]) * 60;
  if (m) min += Number(m[1]);
  if (!h && !m) {
    const n = t.match(/\d+/);
    if (n) min = Number(n[0]);
  }
  return Math.round(min) || 0;
}

function parseKategorie(text) {
  const t = plain(text);
  const exact = KATEGORIEN.find((k) => k.toLowerCase() === t);
  if (exact) return exact;
  if (/kuchen|back|dessert|nachtisch|süß/.test(t)) return 'Kuchen & Backen';
  if (/suppe|eintopf/.test(t)) return 'Suppen & Eintöpfe';
  if (/salat|beilage/.test(t)) return 'Salate & Beilagen';
  if (/frühstück/.test(t)) return 'Frühstück';
  if (/schnell/.test(t)) return 'Schnelle Gerichte';
  if (/haupt/.test(t)) return 'Hauptgerichte';
  return '';
}

/** Eine Zutatenzeile → { name, menge, vorrat } */
export function parseZutat(raw) {
  let line = clean(raw).replace(/^(?:[-•*–·▪◦]|\d+[.)])\s*/, '').replace(/^\[[ x]?\]\s*/i, '').trim();
  if (!line) return null;
  let vorrat = false;
  if (/\(\s*vorrat\s*\)/i.test(line)) {
    vorrat = true;
    line = line.replace(/\(\s*vorrat\s*\)/i, '').trim();
  }

  let menge = '';
  let name = '';
  if (line.includes('|')) {
    const parts = line.split('|').map((p) => p.trim());
    if (parts.slice(2).some((p) => /vorrat/i.test(p))) vorrat = true;
    let [a = '', b = ''] = parts;
    if (/^vorrat$/i.test(b)) { vorrat = true; b = ''; }
    // Falls die KI Name und Menge vertauscht hat
    if (a && b && !SIEHT_AUS_WIE_MENGE.test(a) && SIEHT_AUS_WIE_MENGE.test(b)) [a, b] = [b, a];
    if (b) { menge = a; name = b; } else { name = a; }
    if (menge === '-' || menge === '–') menge = '';
  } else {
    const m = line.match(MENGE_VORNE);
    if (m && m[2]) { menge = m[1].trim(); name = m[2].trim(); }
    else {
      // „Mehl: 200 g“ oder „Mehl – 200 g“ oder „Mehl (200 g)“
      const hinten = line.match(/^(.+?)\s*(?:[:–]\s*|\s-\s|\()\s*([^()]+?)\)?$/);
      if (hinten && SIEHT_AUS_WIE_MENGE.test(hinten[2])) { name = hinten[1].trim(); menge = hinten[2].trim(); }
      else name = line;
    }
  }
  name = name.replace(/[,;.]\s*$/, '').trim();
  if (!name) return null;
  if (!vorrat && VORRAT_RE.test(name)) vorrat = true;
  return { name: name.slice(0, 80), menge: menge.slice(0, 40), vorrat };
}

function parseSchritt(raw) {
  return clean(raw)
    .replace(/^(?:[-•*–·▪◦]|\d+\s*[.):]|schritt\s*\d+\s*[:.)]?)\s*/i, '')
    .trim();
}

/** Ein einzelner Block → Rezept oder null */
function parseBlock(lines) {
  const r = { titel: '', emoji: '', kategorie: '', portionen: 0, dauer_minuten: 0, schwierigkeit: 'einfach', beschreibung: '', zutaten: [], schritte: [] };
  let hinweis = '';
  let quelle = '';
  let section = null;
  let lastField = null;
  let titelGeraten = false;

  for (const raw of lines) {
    const line = clean(raw);
    if (!line) { lastField = null; continue; }
    const bare = line.replace(/^[=\-*_\s]+|[=\-*_\s]+$/g, '');
    if (!bare || /^rezept$/i.test(bare)) continue;
    if (/^ende$/i.test(bare)) break;
    const sec = sectionOf(line);
    if (sec) { section = sec; lastField = null; continue; }

    const f = fieldOf(line);
    if (f && (section === null || ['hinweis', 'quelle'].includes(f[0]) || (f[0] === 'titel' && (!r.titel || titelGeraten)))) {
      const [feld, wert] = f;
      lastField = feld;
      if (feld === 'titel') { r.titel = wert; titelGeraten = false; }
      else if (feld === 'emoji') r.emoji = [...wert].slice(0, 4).join('').trim();
      else if (feld === 'kategorie') r.kategorie = parseKategorie(wert);
      else if (feld === 'portionen') r.portionen = Number(wert.match(/\d+/)?.[0]) || 0;
      else if (feld === 'zeit') r.dauer_minuten = parseMinuten(wert);
      else if (feld === 'schwierigkeit') r.schwierigkeit = /mittel|schwer|aufwendig|anspruchs/i.test(wert) ? 'mittel' : 'einfach';
      else if (feld === 'beschreibung') r.beschreibung = wert;
      else if (feld === 'hinweis') { hinweis = wert; section = 'hinweis'; }
      else if (feld === 'quelle') quelle = wert;
      continue;
    }

    if (section === 'zutaten') {
      // Zwischenüberschrift wie „Für den Teig:“ als Zutatengruppe überspringen
      if (/^(für|fuer)\s.+[:：]$/i.test(line)) continue;
      const z = parseZutat(line);
      if (z) r.zutaten.push(z);
    } else if (section === 'schritte') {
      const s = parseSchritt(line);
      if (s) r.schritte.push(s);
    } else if (section === 'hinweis') {
      hinweis = `${hinweis} ${line}`.trim();
    } else if (lastField === 'beschreibung') {
      r.beschreibung = `${r.beschreibung} ${line}`.trim();
    } else if (!r.titel && line.length <= 80) {
      // Erste freie Zeile ohne „Titel:“ als Titel nehmen
      r.titel = line.replace(/[:：]\s*$/, '');
      titelGeraten = true;
    }
  }

  r.titel = r.titel.replace(/^[^\p{L}\p{N}]+/u, (m) => {
    if (!r.emoji && /\p{Extended_Pictographic}/u.test(m)) r.emoji = m.trim();
    return '';
  }).trim();
  if (!r.titel || !r.zutaten.length) return null;
  if (!r.emoji) r.emoji = '🍽️';
  if (!r.portionen) r.portionen = 4;
  if (quelle) r.beschreibung = [r.beschreibung, `Quelle: ${quelle}`].filter(Boolean).join(' ');
  r.beschreibung = r.beschreibung.slice(0, 300);
  r.schritte = r.schritte.slice(0, 30);
  r.zutaten = r.zutaten.slice(0, 60);
  return { rezept: r, hinweis: hinweis.slice(0, 300) };
}

/**
 * Text → Liste von { rezept, hinweis }. Leer, wenn kein Rezept im Format erkannt wurde.
 * Erkannt wird ein Rezept, wenn es einen Titel und einen Abschnitt „Zutaten“ hat.
 */
export function parseRezeptText(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  const lines = src.split('\n');
  const hasZutaten = lines.some((l) => sectionOf(clean(l)) === 'zutaten');
  if (!hasZutaten) return [];

  // An „REZEPT“-Zeilen aufteilen (mehrere Rezepte in einer Antwort)
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    const c = clean(l).replace(/^[=\-*\s]+|[=\-*\s]+$/g, '');
    if (/^rezept$/i.test(c)) {
      if (cur.some((x) => x.trim())) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(l);
  }
  if (cur.some((x) => x.trim())) blocks.push(cur);

  return blocks.map(parseBlock).filter(Boolean);
}
