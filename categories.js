/**
 * categories.js
 * ------------------------------------------------------------------
 * Supermarkt-Kategorien (in Laufweg-Reihenfolge), deutsches
 * Keyword-Wörterbuch, automatische Kategorisierung und der
 * Multi-Artikel-Parser ("Smart-Paste").
 *
 * Erweitern: Einfach weitere Begriffe (klein geschrieben) in das
 * passende `keywords`-Array eintragen.
 *   - "milch"   → Teilwort-Treffer (Vollmilch, H-Milch, ...)
 *   - "=ei"     → nur als ganzes Wort (damit "Reis" nicht zu "Ei" wird)
 *
 * Bei zusammengesetzten Wörtern gewinnt der Treffer, der am weitesten
 * hinten im Wort steht (im Deutschen bestimmt das letzte Wortteil die
 * Bedeutung: "Milchschokolade" → Schokolade, "Butterkeks" → Keks).
 * Bei Gleichstand gewinnt der längere Begriff.
 * ------------------------------------------------------------------
 */

export const CATEGORIES = [
  {
    id: 'obst',
    name: 'Obst & Gemüse',
    icon: '🥦',
    keywords: [
      'apfel', 'äpfel', 'banane', 'birne', 'orange', 'mandarine', 'clementine', 'zitrone', 'limette',
      'grapefruit', 'kiwi', 'mango', 'ananas', 'melone', 'traube', 'weintraube', 'erdbeere', 'himbeere',
      'heidelbeere', 'blaubeere', 'johannisbeere', 'brombeere', 'kirsche', 'pflaume', 'zwetschge',
      'aprikose', 'pfirsich', 'nektarine', 'avocado', 'granatapfel', 'feige', 'obst', 'beeren',
      'tomate', 'gurke', 'salatgurke', 'paprika', 'zucchini', 'aubergine', 'kartoffel', 'süßkartoffel',
      'zwiebel', 'lauchzwiebel', 'frühlingszwiebel', 'knoblauch', 'möhre', 'möhren', 'karotte', 'lauch',
      'porree', 'sellerie', 'staudensellerie', 'brokkoli', 'broccoli', 'blumenkohl', 'rosenkohl',
      'weißkohl', 'rotkohl', 'kohlrabi', 'wirsing', 'grünkohl', 'spinat', 'mangold', 'salat',
      'eisbergsalat', 'kopfsalat', 'feldsalat', 'rucola', 'radieschen', 'rettich', 'rote bete',
      'kürbis', 'champignon', 'pilze', 'spargel', 'mais', 'fenchel', 'ingwer', 'petersilie',
      'schnittlauch', 'basilikum', 'dill', 'kräuter', 'minze', 'koriander', 'gemüse', 'suppengrün',
      'pastinake', 'ruccola', 'chili', 'peperoni', 'bohnen grün', 'grüne bohnen', 'erbsenschoten',
      'kirschtomate', 'cocktailtomate', 'rispentomate', 'lollo'
    ]
  },
  {
    id: 'backwaren',
    name: 'Backwaren',
    icon: '🥖',
    keywords: [
      'brot', 'brötchen', 'semmel', 'baguette', 'toast', 'toastbrot', 'vollkornbrot', 'schwarzbrot',
      'pumpernickel', 'croissant', 'brezel', 'laugen', 'kuchen', 'stuten', 'rosinenstuten', 'zwieback',
      'knäckebrot', 'ciabatta', 'fladenbrot', 'wraps', 'tortilla', 'hefezopf', 'berliner', 'teilchen',
      'aufbackbrötchen', 'sandwich', 'burger buns', 'buns', 'muffin', 'donut', 'waffeln', 'pfannkuchen'
    ]
  },
  {
    id: 'fleisch',
    name: 'Fleisch & Wurst',
    icon: '🥩',
    keywords: [
      'fleisch', 'hack', 'hackfleisch', 'gehacktes', 'rind', 'rinder', 'schwein', 'hähnchen', 'hühnchen',
      'huhn', 'pute', 'puten', 'chicken', 'schnitzel', 'kotelett', 'steak', 'braten', 'gulasch',
      'filet', 'brust', 'keule', 'schenkel', 'wurst', 'würstchen', 'bratwurst', 'bockwurst', 'wiener',
      'frikadelle', 'salami', 'schinken', 'kochschinken', 'speck', 'bacon', 'mett', 'leberwurst',
      'aufschnitt', 'mortadella', 'lyoner', 'fleischwurst', 'cervelat', 'geflügel', 'lachs', 'fisch',
      'forelle', 'hering', 'matjes', 'garnelen', 'krabben', 'thunfisch frisch', 'kassler', 'leberkäse',
      'chorizo', 'pastrami', 'roastbeef', 'fleischsalat', 'geschnetzeltes', 'rouladen', 'lamm', '=ente'
    ]
  },
  {
    id: 'kuehl',
    name: 'Kühlregal & Molkerei',
    icon: '🥛',
    keywords: [
      'milch', 'vollmilch', 'h-milch', 'hafermilch', 'buttermilch', 'butter', 'margarine', 'käse',
      'gouda', 'emmentaler', 'mozzarella', 'feta', 'parmesan', 'camembert', 'brie', 'frischkäse',
      'hüttenkäse', 'körniger frischkäse', 'reibekäse', 'quark', 'magerquark', 'joghurt', 'jogurt',
      'skyr', 'sahne', 'schlagsahne', 'schmand', 'saure sahne', 'crème fraîche', 'creme fraiche',
      'kefir', 'pudding', 'dessert', 'eier', '=ei', 'hefe', 'frischhefe', 'tofu', 'blätterteig',
      'pizzateig', 'kräuterbutter', 'aufstrich', 'hummus', 'tzatziki', 'feinkost', 'räucherlachs',
      'mascarpone', 'ricotta', 'halloumi', 'grillkäse', 'schafskäse', 'milchreis', 'kakao trinkfertig',
      'smoothie', 'orangensaft frisch', 'gnocchi', 'tortellini', 'frische nudeln', 'maultaschen'
    ]
  },
  {
    id: 'trocken',
    name: 'Trockensortiment & Vorräte',
    icon: '🥫',
    keywords: [
      'nudeln', 'spaghetti', 'penne', 'fusilli', 'pasta', 'lasagne', 'reis', 'basmati', 'couscous',
      'bulgur', 'quinoa', 'linsen', 'kichererbsen', 'mehl', 'zucker', 'puderzucker', 'vanillezucker',
      'backpulver', 'salz', 'pfeffer', 'gewürz', 'paprikapulver', 'zimt', 'curry', 'oregano',
      '=öl', 'olivenöl', 'sonnenblumenöl', 'rapsöl', 'essig', 'balsamico', 'senf', 'ketchup',
      'mayonnaise', 'mayo', 'remoulade', 'soße', 'sauce', 'tomatensoße', 'passierte tomaten',
      'tomatenmark', 'dosentomaten', 'pesto', 'brühe', 'gemüsebrühe', 'fond', 'bouillon',
      'konserve', 'dose', 'mais dose', 'kidneybohnen', 'weiße bohnen', 'erbsen', 'thunfisch',
      'sardinen', 'gurken', 'gewürzgurken', 'oliven', 'sauerkraut', 'rotkohl glas', 'apfelmus',
      'marmelade', 'konfitüre', 'honig', 'nutella', 'nuss-nougat', 'erdnussbutter', 'müsli', 'muesli',
      'haferflocken', 'cornflakes', 'cerealien', 'kaffee', 'kaffeepads', 'kaffeekapseln', 'espresso',
      'tee', 'kakao', 'kakaopulver', 'kokosmilch', 'sojasoße', 'instant', 'fertiggericht', 'suppe',
      'tütensuppe', 'semmelbrösel', 'paniermehl', 'grieß', 'speisestärke', 'gelatine', 'nüsse',
      'mandeln', 'walnüsse', 'haselnüsse', 'rosinen', 'trockenobst', 'kartoffelpüree', 'knödel',
      'babynahrung', 'kondensmilch', 'kaffeesahne', 'h-sahne', 'süßstoff', 'sirup', 'tortenguss'
    ]
  },
  {
    id: 'suesses',
    name: 'Süßes & Snacks',
    icon: '🍫',
    keywords: [
      'schokolade', 'schoki', 'praline', 'bonbon', 'gummibärchen', 'fruchtgummi', 'lakritz', 'kekse',
      'keks', 'butterkeks', 'plätzchen', 'waffel', 'chips', 'flips', 'erdnussflips', 'salzstangen',
      'cracker', 'popcorn', 'nüsschen', 'studentenfutter', 'riegel', 'müsliriegel', 'kaugummi',
      'süßigkeiten', 'snack', 'lebkuchen', 'spekulatius', 'stollen', 'dominosteine', 'marzipan',
      'schokoriegel', 'knabberzeug', 'tortilla chips', 'nachos', 'erdnüsse'
    ]
  },
  {
    id: 'getraenke',
    name: 'Getränke',
    icon: '🧃',
    keywords: [
      'wasser', 'mineralwasser', 'sprudel', 'stilles wasser', 'saft', 'apfelsaft', 'orangensaft',
      'multivitaminsaft', 'schorle', 'apfelschorle', 'limo', 'limonade', 'cola', 'fanta', 'sprite',
      'spezi', 'eistee', 'bier', 'pils', 'radler', 'alkoholfrei', 'wein', 'rotwein', 'weißwein',
      'rosé', 'sekt', 'prosecco', 'tonic', 'energy', 'energydrink', 'malzbier', 'likör',
      'eierlikör', 'schnaps', 'korn', 'whisky', 'wodka', 'gin', 'rum', 'getränk', 'kasten wasser',
      'nektar', 'sirup getränk', 'glühwein', 'punsch', 'kombucha'
    ]
  },
  {
    id: 'tiefkuehl',
    name: 'Tiefkühl',
    icon: '🧊',
    keywords: [
      'tiefkühl', '=tk', 'gefroren', 'pizza', 'tiefkühlpizza', 'pommes', 'kroketten',
      'rösti', 'fischstäbchen', '=eis', 'speiseeis', 'eiscreme', 'vanilleeis', 'schokoeis', 'eis am stiel',
      'magnum', 'tk-gemüse', 'rahmspinat', 'tk-erbsen', 'kräuter tk', 'blätterspinat', 'eiswürfel',
      'tiefkühlbeeren', 'tiefkühl-beeren', 'tk-beeren', 'gefrorene beeren', 'aufbackpizza', 'lasagne tk', 'baguette tk', 'kartoffeltaschen', 'backfisch'
    ]
  },
  {
    id: 'drogerie',
    name: 'Drogerie & Haushalt',
    icon: '🧴',
    keywords: [
      'toilettenpapier', 'klopapier', 'küchenrolle', 'küchenpapier', 'taschentücher', 'tempo',
      'servietten', 'spülmittel', 'spülmaschinentabs', 'tabs', 'geschirrspül', 'waschmittel',
      'weichspüler', 'reiniger', 'allzweckreiniger', 'putzmittel', 'schwamm', 'schwämme', 'lappen',
      'müllbeutel', 'müllsäcke', 'mülltüten', 'gefrierbeutel', 'frischhaltefolie', 'alufolie',
      'backpapier', 'zahnpasta', 'zahncreme', 'zahnbürste', 'zahnseide', 'shampoo', 'duschgel',
      'seife', 'flüssigseife', 'deo', 'deodorant', 'creme', 'bodylotion', 'sonnencreme', 'rasierer',
      'rasierschaum', 'binden', 'tampons', 'slipeinlagen', 'windeln', 'feuchttücher', 'wattepads',
      'wattestäbchen', 'pflaster', 'batterien', 'glühbirne', 'kerzen', 'teelichter', 'streichhölzer',
      'feuerzeug', 'katzenfutter', 'hundefutter', 'katzenstreu', 'tierfutter', 'blumen', 'erde',
      'entkalker', 'wc-reiniger', 'glasreiniger', 'handseife', 'haarspray', 'spülbürste', 'kosmetik'
    ]
  },
  {
    id: 'sonstiges',
    name: 'Sonstiges',
    icon: '🛍️',
    keywords: []
  }
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const DEFAULT_CATEGORY = 'sonstiges';

/** Kleinschreibung, ß → ss, Mehrfach-Leerzeichen entfernen. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

// Wörterbuch vorbereiten (einmalig): [{ kw, wholeWord, catId }]
const DICTIONARY = CATEGORIES.flatMap((cat) =>
  cat.keywords.map((raw) => {
    const wholeWord = raw.startsWith('=');
    return { kw: normalize(wholeWord ? raw.slice(1) : raw), wholeWord, catId: cat.id };
  })
);

const WORD_CHAR = /[a-z0-9äöüéèàâç]/;

/**
 * Ermittelt die Kategorie für einen Artikelnamen.
 * @param {string} name        Artikelname (ohne Menge)
 * @param {object} learned     Optionale gelernte Zuordnungen { normalisierterName: catId }
 * @returns {string} Kategorie-ID
 */
export function categorize(name, learned = {}) {
  const n = normalize(name);
  if (!n) return DEFAULT_CATEGORY;
  if (learned[n] && CATEGORY_BY_ID[learned[n]]) return learned[n];

  let best = null; // { end, len, catId }
  for (const entry of DICTIONARY) {
    const { kw, wholeWord, catId } = entry;
    if (!kw) continue;
    let from = 0;
    let idx;
    while ((idx = n.indexOf(kw, from)) !== -1) {
      from = idx + 1;
      const end = idx + kw.length;
      if (wholeWord) {
        const before = idx === 0 ? '' : n[idx - 1];
        const after = end >= n.length ? '' : n[end];
        if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) continue;
      }
      // Ende des Wortes bestimmen, in dem der Treffer liegt
      let wordEnd = end;
      while (wordEnd < n.length && WORD_CHAR.test(n[wordEnd])) wordEnd++;
      // Treffer, die genau am Wortende enden, haben Vorrang (Kopf des Kompositums)
      const score = { end: wordEnd === end ? end : end - 0.5, len: kw.length, catId };
      if (!best || score.end > best.end || (score.end === best.end && score.len > best.len)) {
        best = score;
      }
    }
  }
  return best ? best.catId : DEFAULT_CATEGORY;
}

/* ------------------------------------------------------------------
 * Smart-Paste: Text → einzelne Artikel mit Mengenangabe
 * ------------------------------------------------------------------ */

const NUMBER_WORDS = {
  ein: '1', eine: '1', einen: '1', eins: '1', zwei: '2', drei: '3', vier: '4', 'fünf': '5',
  sechs: '6', sieben: '7', acht: '8', neun: '9', zehn: '10', elf: '11', 'zwölf': '12'
};

// Einheiten (Reihenfolge: längere zuerst, damit "kg" vor "g" greift)
const UNIT_PATTERN =
  '(?:x|×|stk\\.?|stück|st\\.|pck\\.?|päckchen|packung(?:en)?|packs?|pkg\\.?|dosen?|flaschen?|' +
  'gläser|glas|becher|bund|beutel|netze?|kisten?|kästen|kasten|tüten?|schalen?|rollen?|tafeln?|' +
  'kg|gramm|gr\\.?|g|liter|ml|cl|l)';

const NUM = '(\\d+(?:[.,]\\d+)?|½|¼)';
const LEADING_QTY = new RegExp(`^${NUM}\\s*(${UNIT_PATTERN})?\\.?\\s+(.+)$`, 'i');
const TRAILING_QTY = new RegExp(`^(.+?)\\s*[,(-]?\\s+${NUM}\\s*(${UNIT_PATTERN})?\\.?\\)?$`, 'i');
const TRAILING_X = /^(.+?)\s+[x×]\s*(\d+)$/i; // "Milch x2"

const SHORT_UNITS = { gramm: 'g', 'gr': 'g', 'gr.': 'g', liter: 'l', 'stk': 'Stk.', 'stk.': 'Stk.', 'st.': 'Stk.', 'pck': 'Pck.', 'pck.': 'Pck.', 'pkg': 'Pck.', 'pkg.': 'Pck.' };

function formatQty(num, unit) {
  const n = String(num).replace('.', ',');
  if (!unit || /^[x×]$/i.test(unit)) return `${n}×`;
  const u = unit.toLowerCase();
  const short = SHORT_UNITS[u];
  if (short) return `${n} ${short}`;
  if (['kg', 'g', 'l', 'ml', 'cl'].includes(u)) return `${n} ${u}`;
  return `${n} ${u.charAt(0).toUpperCase()}${u.slice(1)}`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Zerlegt eine einzelne Zeile in { name, qty }.
 *  "2x Milch"         → { name: "Milch", qty: "2×" }
 *  "500g Hackfleisch" → { name: "Hackfleisch", qty: "500 g" }
 *  "Eier 10"          → { name: "Eier", qty: "10×" }
 *  "zwei Liter Milch" → { name: "Milch", qty: "2 Liter" }
 */
export function parseLine(line) {
  let s = String(line || '').trim();
  // Aufzählungszeichen / Nummerierung entfernen
  s = s.replace(/^\s*(?:[-*•·–—+]+|\d+[.)]|\[\s?[x ]?\s?\])\s+/i, '');
  // Satzzeichen am Ende entfernen
  s = s.replace(/[.!?:]+$/, '').trim();
  if (!s) return null;

  let qty = '';

  // "ein paar ..." / "etwas ..."
  const paar = s.match(/^(ein paar|einige|etwas|viel|viele)\s+(.+)$/i);
  if (paar) {
    return { name: capitalize(paar[2].trim()), qty: paar[1].toLowerCase() };
  }

  // Zahlwort am Anfang → Ziffer
  const firstWord = s.split(' ')[0].toLowerCase();
  if (NUMBER_WORDS[firstWord] && s.includes(' ')) {
    s = `${NUMBER_WORDS[firstWord]} ${s.slice(firstWord.length).trim()}`;
  }

  let m = s.match(LEADING_QTY);
  if (m) {
    qty = formatQty(m[1], m[2]);
    s = m[3].trim();
  } else if ((m = s.match(TRAILING_X))) {
    qty = formatQty(m[2], 'x');
    s = m[1].trim();
  } else if ((m = s.match(TRAILING_QTY))) {
    qty = formatQty(m[2], m[3]);
    s = m[1].trim();
  }

  s = s.replace(/^(?:x|×)\s+/i, '').replace(/[,;:-]+$/, '').trim();
  if (!s) return null;
  return { name: capitalize(s), qty };
}

/**
 * Zerlegt beliebigen Text (Tippen, Diktat, WhatsApp-Kopie) in Artikel.
 * Trennzeichen: Komma, Semikolon, Zeilenumbruch, " und ", " sowie ".
 * Dezimal-Kommas in Mengen ("1,5 kg") bleiben erhalten.
 */
export function parseItems(text) {
  const raw = String(text || '')
    // WhatsApp-Zeitstempel "[21.11.26, 10:12] Name: " entfernen
    .replace(/^\[[^\]]{4,30}\]\s*[^:\n]{1,40}:\s*/gm, '')
    // Dezimal-Komma schützen
    .replace(/(\d),(\d)/g, '$1\u0000$2');

  const parts = raw
    .split(/[\n\r;,]+|\s+und\s+|\s+sowie\s+|\s+&\s+/i)
    .map((p) => p.replace(/\u0000/g, ',').trim())
    .filter(Boolean);

  const result = [];
  const seen = new Set();
  for (const part of parts) {
    const parsed = parseLine(part);
    if (!parsed || parsed.name.length > 80) continue;
    const key = normalize(parsed.name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(parsed);
  }
  return result;
}

/* ------------------------------------------------------------------
 * Angebots-Abgleich: passt ein Angebot ("Frische Milch") zu einem
 * Artikel auf der Liste ("Milch")?
 *  - gleiches Wort (Plural egal): "Avocados" ↔ "Avocado"
 *  - Kopf eines zusammengesetzten Wortes: "Milch" ↔ "Vollmilch"
 *  - Wortanfang bei längeren Begriffen: "Rinderhack" ↔ "Rinderhackfleisch"
 *  - Nicht: "Milch" ↔ "Milchmäuse" (anderes Produkt)
 * ------------------------------------------------------------------ */

function stem(word) {
  return word.length > 4 ? word.replace(/(en|n|s|e)$/, '') : word;
}

function tokens(text) {
  return normalize(text).split(/[^a-z0-9äöüéèàç]+/).filter(Boolean);
}

/**
 * @returns {number} 0 = passt nicht, 1 = passt (Teilwort), 2 = passt genau
 */
export function offerMatchScore(itemName, offerName) {
  // Zahlen/Prozente im Artikel ignorieren: "Milch 1,5 %" ↔ "Frische Milch"
  const item = tokens(itemName).filter((t) => !/^\d+$/.test(t));
  const offer = tokens(offerName).map(stem);
  if (!item.length || !offer.length) return 0;

  if (item.length > 1) {
    return offer.join(' ').includes(item.map(stem).join(' ')) ? 2 : 0;
  }

  const key = stem(item[0]);
  if (key.length < 3) return 0;
  let best = 0;
  for (const word of offer) {
    if (word === key) return 2;
    if (key.length >= 4 && word.endsWith(key)) best = 1;
    else if (key.length >= 6 && word.startsWith(key)) best = 1;
  }
  return best;
}
