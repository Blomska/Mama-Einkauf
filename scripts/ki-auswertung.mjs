#!/usr/bin/env node
/**
 * scripts/ki-auswertung.mjs
 * ------------------------------------------------------------------
 * Läuft im GitHub-Workflow NACH update-prospekte.mjs und nutzt Claude für:
 *
 *  1. Marktkauf-Prospekt lesen: Alle Produkte mit Preis werden aus den
 *     Seitenbildern (data/mk-seiten/) herausgeschrieben – inkl. Seitenzahl.
 *     → In der App kann man jedes Produkt antippen und auf die Liste setzen.
 *  2. Rezepte der Woche: 5 Familienrezepte aus den aktuellen Angeboten
 *     beider Läden → data/rezepte.json
 *
 * Benötigt das GitHub-Secret ANTHROPIC_API_KEY. Ohne Schlüssel beendet sich
 * das Skript ohne Fehler (die App funktioniert dann wie bisher).
 *
 * Kosten sparen: Ergebnisse werden in .ki-cache/ zwischengespeichert
 * (per actions/cache) – Claude wird nur gefragt, wenn sich Prospekt oder
 * Angebote wirklich geändert haben (also etwa 1–2× pro Woche).
 * ------------------------------------------------------------------
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = resolve(ROOT, 'data/prospekte.json');
const REZEPTE_FILE = resolve(ROOT, 'data/rezepte.json');
const PAGES_DIR = resolve(ROOT, 'data/mk-seiten');
const CACHE_DIR = resolve(ROOT, '.ki-cache');

const MODEL = 'claude-opus-5-5';
const PAGES_PER_REQUEST = 5;
const PARALLEL_REQUESTS = 3;

// Mamas feste Favoriten (wie in config.js) – fließen in die Rezeptauswahl ein
const MAMA_FAVORITES = ['Skyr', 'Eier', 'Milch', 'Rinderhack', 'Avocados'];

const CATEGORY_NAMES = [
  'Obst & Gemüse', 'Backwaren', 'Fleisch & Wurst', 'Kühlregal & Molkerei', 'Trockensortiment & Vorräte',
  'Süßes & Snacks', 'Getränke', 'Tiefkühl', 'Drogerie & Haushalt', 'Sonstiges'
];

/* ---------------- Hilfsfunktionen ---------------- */

const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function cached(name, hash, compute) {
  const file = resolve(CACHE_DIR, `${name}-${hash}.json`);
  const hit = await readJson(file);
  if (hit) {
    console.log(`  ↺ ${name}: aus dem Zwischenspeicher (keine neuen Kosten)`);
    return hit;
  }
  const value = await compute();
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value));
  return value;
}

/** Führt async-Funktionen mit begrenzter Parallelität aus. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Ein Claude-Aufruf mit strukturierter Ausgabe (Zod-Schema).
 * Server-seitiger Fallback ist aktiv: Lehnt das Modell eine Anfrage aus
 * Sicherheitsgründen ab, übernimmt automatisch ein passendes anderes Modell.
 */
async function ask(client, { system, content, schema, effort = 'medium', maxTokens = 16000 }) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: betaZodOutputFormat(schema) }
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Anfrage abgelehnt (${response.stop_details?.category ?? 'ohne Kategorie'})`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Antwort zu lang (max_tokens erreicht)');
  }
  if (!response.parsed_output) throw new Error('Antwort konnte nicht gelesen werden');
  console.log(`    Tokens: ${response.usage.input_tokens} rein / ${response.usage.output_tokens} raus`);
  return response.parsed_output;
}

/* ---------------- 1. Marktkauf-Prospekt lesen ---------------- */

const ProductSchema = z.object({
  produkte: z.array(z.object({
    seite: z.number().int(),
    listenname: z.string(),
    produkt: z.string(),
    marke: z.string(),
    preis: z.string(),
    einheit: z.string(),
    grundpreis: z.string(),
    kategorie: z.enum(CATEGORY_NAMES)
  }))
});

const EXTRACT_SYSTEM = `Du liest Seiten eines Supermarkt-Prospekts (Marktkauf, Deutschland) und schreibst jedes Angebot mit Preis heraus.

Regeln:
- Nur Produkte mit sichtbarem Angebotspreis. Keine Werbetexte, Gutscheine oder Dienstleistungen.
- "seite": die Seitenzahl, die im Text vor dem jeweiligen Bild steht.
- "listenname": so, wie man es auf einen Einkaufszettel schreibt – kurz (1–3 Wörter), mit Marke nur wenn sie wichtig ist, z. B. "Landliebe Butter", "Bockwurst", "Philadelphia".
- "produkt": Produktbezeichnung wie im Prospekt (ohne Marke), kurz gefasst.
- "marke": Marke oder leerer Text.
- "preis": Angebotspreis im Format "1,29 €". Bei App-/Karten-Preisen den normal gültigen Angebotspreis nehmen und "(App)" anhängen, wenn es nur mit App gilt.
- "einheit": Packungsgröße/Sorten kurz, z. B. "250-g-Packung, versch. Sorten". Sonst leer.
- "grundpreis": z. B. "1 kg = 5,16 €", sonst leer.
- "kategorie": passende Supermarkt-Abteilung.
- Lies Preise sehr sorgfältig. Wenn ein Preis unleserlich ist, lass das Produkt weg.`;

async function extractMarktkauf(client) {
  let files = [];
  try {
    files = (await readdir(PAGES_DIR))
      .map((f) => ({ f, n: Number(f.match(/seite-(\d+)\.jpg$/)?.[1]) }))
      .filter((x) => x.n)
      .sort((a, b) => a.n - b.n);
  } catch {
    console.log('  Keine Marktkauf-Seiten vorhanden – übersprungen');
    return null;
  }
  if (!files.length) return null;

  const images = await Promise.all(files.map(async ({ f, n }) => ({ n, data: await readFile(resolve(PAGES_DIR, f)) })));
  const hash = sha(Buffer.concat(images.map((i) => i.data)));

  return cached('marktkauf-produkte', hash, async () => {
    console.log(`  Claude liest ${images.length} Marktkauf-Seiten …`);
    const batches = [];
    for (let i = 0; i < images.length; i += PAGES_PER_REQUEST) batches.push(images.slice(i, i + PAGES_PER_REQUEST));

    const results = await pool(batches.map((batch) => async () => {
      const content = [];
      for (const img of batch) {
        content.push({ type: 'text', text: `Seite ${img.n}:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data.toString('base64') } });
      }
      content.push({ type: 'text', text: 'Schreibe alle Angebote dieser Seiten heraus.' });
      try {
        const out = await ask(client, { system: EXTRACT_SYSTEM, content, schema: ProductSchema });
        return out.produkte;
      } catch (err) {
        console.warn(`    Seiten ${batch[0].n}–${batch.at(-1).n}: ${err.message}`);
        return [];
      }
    }), PARALLEL_REQUESTS);

    return results.flat();
  });
}

/* ---------------- 2. Rezepte der Woche ---------------- */

const RecipeSchema = z.object({
  rezepte: z.array(z.object({
    titel: z.string(),
    emoji: z.string(),
    beschreibung: z.string(),
    portionen: z.number().int(),
    dauer_minuten: z.number().int(),
    schwierigkeit: z.enum(['einfach', 'mittel']),
    zutaten: z.array(z.object({
      name: z.string(),
      menge: z.string(),
      laden: z.enum(['aldi', 'marktkauf', 'egal']),
      im_angebot: z.boolean(),
      preis: z.string(),
      vorrat: z.boolean()
    })),
    schritte: z.array(z.string())
  }))
});

const RECIPE_SYSTEM = `Du bist eine erfahrene, herzliche Hausköchin aus dem Münsterland und schlägst einer Mutter (Familie mit erwachsenen Kindern, kauft bei Marktkauf und Aldi Nord in Lüdinghausen) Rezepte für die Woche vor.

Ziele:
- 5 abwechslungsreiche, alltagstaugliche Rezepte (z. B. 3 Hauptgerichte, 1 schnelles Abendessen, 1 Kuchen oder Frühstück/Brunch), passend zur Jahreszeit.
- Nutze möglichst viele Zutaten, die diese Woche im Angebot sind – das ist der Sinn der Sache.
- Bodenständige deutsche Familienküche mit ein bisschen Abwechslung, keine exotischen Zutaten.
- Lieblingszutaten der Mutter gern einbauen, wenn es passt.

Zutaten:
- "name" so, wie man es auf den Einkaufszettel schreibt (z. B. "Rinderhack", "Paprika", "Schmand").
- "laden": "aldi" oder "marktkauf", wenn die Zutat dort im Angebot ist, sonst "egal".
- "im_angebot" und "preis" nur für echte Angebote aus der Liste (Preis wie angegeben), sonst false und "".
- "vorrat": true für Dinge, die man meist zu Hause hat (Salz, Pfeffer, Öl, Mehl, Zucker, Gewürze, Brühe).
- "portionen": 4.

Schritte: kurz, klar, in einfacher Sprache, 4–8 Schritte. "emoji": ein passendes Essens-Emoji.`;

const NON_FOOD = /mode|deko|schlafzimmer|pflanzen|kosmetik|haushalt|drogerie|garten|technik|elektro|spielzeug|tier/i;

async function createRecipes(client, data) {
  const lines = [];
  const add = (store, o) => {
    if (NON_FOOD.test(o.group || '') || NON_FOOD.test(o.kategorie || '')) return;
    lines.push(`${store} | ${[o.brand, o.name].filter(Boolean).join(' ')} | ${o.price}${o.unit ? ` | ${o.unit}` : ''}`);
  };
  (data?.aldi?.offers?.offers || []).forEach((o) => add('Aldi', o));
  (data?.marktkauf?.offers?.offers || []).forEach((o) => add('Marktkauf', o));
  if (lines.length < 10) {
    console.log('  Zu wenige Angebote für Rezepte – übersprungen');
    return null;
  }
  lines.sort();
  const hash = sha(lines.join('\n'));

  return cached('rezepte', hash, async () => {
    console.log(`  Claude erstellt Rezepte aus ${lines.length} Angeboten …`);
    const month = new Date().toLocaleDateString('de-DE', { month: 'long' });
    const out = await ask(client, {
      system: RECIPE_SYSTEM,
      content: `Monat: ${month}\nLieblingszutaten der Mutter: ${MAMA_FAVORITES.join(', ')}\n\nAngebote dieser Woche (Laden | Produkt | Preis | Einheit):\n${lines.join('\n')}`,
      schema: RecipeSchema
    });
    return { erstellt: new Date().toISOString(), rezepte: out.rezepte };
  });
}

/* ---------------- Hauptprogramm ---------------- */

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Kein ANTHROPIC_API_KEY gesetzt – KI-Funktionen (Rezepte, Marktkauf-Produkte) übersprungen.');
    return;
  }
  const client = new Anthropic();
  const data = await readJson(DATA_FILE);
  if (!data) {
    console.log('Keine data/prospekte.json – übersprungen.');
    return;
  }

  // 1. Marktkauf-Produkte aus den Prospektseiten
  try {
    const products = await extractMarktkauf(client);
    if (products?.length && !data.marktkauf?.offers?.offers?.length) {
      const current = data.marktkauf?.current || {};
      const offers = products.map((p, i) => ({
        id: `mk-${p.seite}-${i}`,
        name: p.listenname.trim(),
        brand: p.marke.trim(),
        product: p.produkt.trim(),
        price: p.preis.trim(),
        unit: p.einheit.trim(),
        basePrice: p.grundpreis.trim(),
        validFrom: current.validFrom || null,
        validTo: current.validTo || null,
        group: p.kategorie,
        page: p.seite,
        image: null
      }));
      const groups = CATEGORY_NAMES.filter((g) => offers.some((o) => o.group === g));
      offers.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.page - b.page);
      data.marktkauf.offers = { groups, offers, source: 'ki-prospekt' };
      await writeFile(DATA_FILE, `${JSON.stringify(data, null, 1)}\n`);
      console.log(`✓ Marktkauf: ${offers.length} Produkte aus dem Prospekt`);
    }
  } catch (err) {
    console.warn(`✗ Marktkauf-Produkte: ${err.message}`);
  }

  // 2. Rezepte
  try {
    const recipes = await createRecipes(client, data);
    if (recipes) {
      const week = {
        ...recipes,
        gueltigBis: data.aldi?.current?.validTo || data.marktkauf?.current?.validTo || null
      };
      await writeFile(REZEPTE_FILE, `${JSON.stringify(week, null, 1)}\n`);
      console.log(`✓ ${recipes.rezepte.length} Rezepte der Woche`);
    }
  } catch (err) {
    console.warn(`✗ Rezepte: ${err.message}`);
  }
}

main().catch((err) => {
  // Die App soll trotzdem veröffentlicht werden
  console.error('KI-Auswertung fehlgeschlagen:', err.message);
});
