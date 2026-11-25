/**
 * Chat-Helfer für die Familien-Einkaufsliste (Cloudflare Worker)
 * ------------------------------------------------------------------
 * Die App schickt den Chatverlauf + die aktuelle Einkaufsliste hierher.
 * Der Worker ergänzt die Angebote der Woche (aus data/prospekte.json der
 * App), fragt Google Gemini und gibt eine freundliche Antwort plus – falls passend –
 * eine Liste von Artikeln zurück, die Mama mit einem Tipp übernehmen kann.
 *
 * Geheimnisse (als Worker-Secrets, NIE im Code):
 *   GEMINI_API_KEY    – API-Schlüssel von aistudio.google.com
 * Optional (Variable): GEMINI_MODEL – bestimmtes Gemini-Modell erzwingen
 *   FAMILY_CODE       – Familien-Code, den die App einmalig abfragt
 *                       (schützt vor fremder Nutzung und Kosten)
 * ------------------------------------------------------------------
 */

import * as z from 'zod';
import { createClient, generateJson, GeminiBlocked, ApiError } from '../../lib/gemini.mjs';

const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 2000;
const RATE_LIMIT_PER_HOUR = 40;

const RecipeSchema = z.object({
  titel: z.string(),
  emoji: z.string(),
  beschreibung: z.string(),
  portionen: z.number().int(),
  dauer_minuten: z.number().int(),
  schwierigkeit: z.enum(['einfach', 'mittel']),
  kategorie: z.enum(['Hauptgerichte', 'Schnelle Gerichte', 'Frühstück', 'Suppen & Eintöpfe', 'Salate & Beilagen', 'Kuchen & Backen']),
  zutaten: z.array(z.object({
    name: z.string(),
    menge: z.string(),
    laden: z.enum(['aldi', 'marktkauf', 'egal']),
    im_angebot: z.boolean(),
    preis: z.string(),
    vorrat: z.boolean()
  })),
  schritte: z.array(z.string())
});

const ReplySchema = z.object({
  antwort: z.string(),
  artikel: z.array(z.object({
    name: z.string(),
    menge: z.string(),
    laden: z.enum(['aldi', 'marktkauf', 'egal'])
  })),
  rezepte: z.array(RecipeSchema),
  merken: z.array(z.object({
    text: z.string(),
    wenn: z.string(),
    dann: z.string()
  }))
});

const SYSTEM_PROMPT = `Du bist der freundliche Einkaufs- und Küchenhelfer in der Einkaufslisten-App einer Familie aus Lüdinghausen (Münsterland). Meistens schreibt dir die Mutter der Familie. Sie kauft bei Marktkauf (Nientied) und Aldi Nord ein.

Wie du antwortest:
- Herzlich, kurz und in einfacher Sprache. Duze sie. Keine Tabellen, keine Überschriften, höchstens kurze Aufzählungen mit "•".
- Wenn sie etwas plant (Frühstück, Besuch, Abendessen, Kuchen, Grillen …), schlage konkret vor, was es geben könnte, und rechne Mengen für die genannte Personenzahl.
- Nutze die Angebote der Woche, wenn sie passen, und sag dazu, wo es gerade günstig ist (z. B. "Avocados sind bei Aldi im Angebot für 0,88 €").
- Wenn Einkäufe sinnvoll sind, fülle "artikel" mit allem, was gekauft werden muss:
  • "name" so, wie man es auf den Einkaufszettel schreibt (z. B. "Brötchen", "Rinderhack", "Erdbeermarmelade").
  • "menge" kurz (z. B. "8 Stück", "500 g", "1 Glas"); leer, wenn egal.
  • "laden": "aldi" oder "marktkauf", wenn es dort im Angebot ist, sonst "egal".
  • Lass weg, was schon auf ihrer Liste steht, und typische Vorräte (Salz, Pfeffer, Öl, Zucker, Mehl), außer sie fragt danach.
- Wenn sie nur etwas fragt (z. B. ein Rezept oder einen Tipp), antworte einfach – "artikel" darf dann leer sein.
- Sag in der Antwort nicht, dass du die Artikel "unten" auflistest – die App zeigt sie automatisch als Knöpfe an. Ein kurzer Satz wie "Ich hab dir die Sachen zum Abhaken rausgesucht." reicht.
- Wenn du ein konkretes Gericht oder einen Kuchen mit Zutaten und Zubereitung vorschlägst (oder sie nach einem Rezept fragt), lege es zusätzlich vollständig in "rezepte" ab (höchstens 2):
  • "zutaten" mit Mengen für die genannte Personenzahl (sonst 4), "vorrat": true für Salz, Pfeffer, Öl, Mehl, Zucker, Gewürze, Brühe.
  • "im_angebot"/"preis" nur, wenn die Zutat in den Angeboten dieser Woche steht (Preis wie angegeben), sonst false und "".
  • "schritte": 4–8 kurze, klare Schritte. "emoji": ein passendes Essens-Emoji.
  • In "antwort" dann nur kurz beschreiben, was es gibt – nicht die ganze Zubereitung wiederholen. Die App zeigt das Rezept als Karte an, die sie mit „⭐ In meine Rezepte“ speichern kann.
- Erzählt sie ein EIGENES Rezept (z. B. „Omas Rinderrouladen“) oder will sie eins ins Kochbuch eintragen, schreib es sauber als Rezept in "rezepte": ihre Zutaten, Mengen und Schritte übernehmen (nicht verändern), nur ordnen und fehlende Kleinigkeiten sinnvoll ergänzen. Fehlt Wichtiges (z. B. Mengen oder Backzeit), frag in "antwort" freundlich nach. In "antwort" kurz bestätigen und sagen, dass sie es mit „⭐ Ins Kochbuch“ speichern kann.
- "kategorie" passend wählen: Hauptgerichte, Schnelle Gerichte (bis ca. 30 Min), Frühstück, Suppen & Eintöpfe, Salate & Beilagen oder Kuchen & Backen.
- Ohne konkretes Rezept bleibt "rezepte" leer.
- Familien-Gedächtnis: Am Anfang ihrer Nachricht steht, was du schon über die Familie weißt. Richte dich immer danach (Personenzahl, Vorlieben, Lieblingssorten) – auch bei Mengen in "artikel" und "rezepte".
- Sagt sie etwas Dauerhaftes, das du dir merken solltest (Vorliebe, Abneigung, Lieblingssorte/-marke, Personenzahl, Allergie, Gewohnheit), und steht es noch nicht im Gedächtnis, schlage es in "merken" vor:
  • "text": kurz in der 3. Person, z. B. "Papa mag keine Rosinen." oder "Joghurt immer von Ehrmann."
  • "wenn"/"dann" nur, wenn ein Artikelname auf der Einkaufsliste immer ersetzt werden soll, z. B. wenn "Joghurt", dann "Ehrmann Joghurt". Sonst beide leer.
  • Frag in "antwort" kurz: "Soll ich mir das merken?" – die App zeigt dafür einen Knopf.
  • Ohne neue dauerhafte Info bleibt "merken" leer. Schlage nie etwas vor, das schon im Gedächtnis steht.
- Lieblingsmarken lernst du mit der Zeit: Nennt sie eine Marke (z. B. "die Butter von Kerrygold") oder steht ein Markenprodukt auf ihrer Liste, das noch nicht im Gedächtnis ist, frag ruhig nach, ob das ihre feste Marke ist, und schlage es zum Merken vor.
- Bleib beim Thema Essen, Einkaufen, Haushalt und Planung. Bei anderem antworte freundlich und kurz.`;

/* ---------------- Hilfsfunktionen ---------------- */

const rateLimits = new Map(); // IP → Zeitstempel (pro Worker-Instanz, einfacher Schutz)

function rateLimited(ip) {
  const now = Date.now();
  const recent = (rateLimits.get(ip) || []).filter((t) => now - t < 3600_000);
  recent.push(now);
  rateLimits.set(ip, recent);
  return recent.length > RATE_LIMIT_PER_HOUR;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors }
  });
}

async function loadJson(url) {
  try {
    const res = await fetch(url, { cf: { cacheTtl: 1800, cacheEverything: true } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const NON_FOOD = /mode|deko|schlafzimmer|pflanzen|kosmetik|haushalt|drogerie|garten|technik|elektro|spielzeug|tier/i;

/** Angebote der Woche als kompakter Text (ändert sich selten → gut für Prompt-Caching). */
async function offersContext(env) {
  const base = env.DATA_URL || '';
  const [data, recipes] = await Promise.all([loadJson(`${base}prospekte.json`), loadJson(`${base}rezepte.json`)]);
  const lines = [];
  for (const [store, label] of [['aldi', 'Aldi'], ['marktkauf', 'Marktkauf']]) {
    for (const o of data?.[store]?.offers?.offers || []) {
      if (NON_FOOD.test(o.group || '')) continue;
      lines.push(`${label} | ${[o.brand, o.name].filter(Boolean).join(' ')} | ${o.price}${o.validTo ? ` | bis ${o.validTo}` : ''}`);
    }
  }
  lines.sort();
  let text = lines.length
    ? `Angebote dieser Woche (Laden | Produkt | Preis | gültig):\n${lines.join('\n')}`
    : 'Zu den Angeboten dieser Woche liegen gerade keine Daten vor.';
  if (recipes?.rezepte?.length) {
    text += `\n\nRezepte der Woche in der App: ${recipes.rezepte.map((r) => r.titel).join('; ')}`;
  }
  return text;
}

function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return null;
  const clean = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    const content = m.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    clean.push({ role: m.role, content });
  }
  // Muss mit einer Nachricht der Nutzerin beginnen und enden
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean.at(-1).role !== 'user') return null;
  return clean;
}

/* ---------------- Rezept aus Foto, Link oder Text ---------------- */

const IMPORT_SYSTEM = `Du liest Rezepte aus Fotos (z. B. Kochbuchseiten, Zeitschriften, handgeschriebene Rezeptkarten, Screenshots), Webseiten oder eingefügtem Text und schreibst sie sauber auf Deutsch für das Familien-Kochbuch.

- Übernimm das Rezept so originalgetreu wie möglich: Zutaten mit Mengen, Portionen, Schritte. Nichts weglassen und keine Zutaten austauschen.
- Übersetze fremdsprachige Rezepte ins Deutsche und rechne amerikanische Maße (cups, oz, °F) in g/ml/°C um.
- "zutaten": "name" so, wie man es auf den Einkaufszettel schreibt, "menge" kurz (z. B. "400 g", "1 EL"), "laden": "egal", "im_angebot": false, "preis": "", "vorrat": true nur für Salz, Pfeffer, Öl, Mehl, Zucker, Gewürze, Brühe.
- "schritte": klare, kurze Schritte in einfacher Sprache, höchstens 12. Zeiten mit Zahl und Einheit schreiben (z. B. "20 Minuten backen"), damit die App dafür einen Timer anbieten kann.
- "portionen": wie im Rezept, sonst 4. "dauer_minuten": geschätzte Gesamtzeit. "emoji": ein passendes Essens-Emoji.
- "kategorie": Hauptgerichte, Schnelle Gerichte (bis ca. 30 Min), Frühstück, Suppen & Eintöpfe, Salate & Beilagen oder Kuchen & Backen.
- "hinweis": leer lassen, außer etwas Wichtiges war nicht lesbar (dann ein kurzer, freundlicher Satz dazu).
- Ist kein Rezept zu erkennen, setze "gefunden": false und erkläre in "hinweis" kurz, warum (z. B. "Auf dem Foto ist kein Rezept zu erkennen.").`;

const ImportSchema = z.object({
  gefunden: z.boolean(),
  hinweis: z.string(),
  rezept: RecipeSchema
});

/** Seite laden und den Rezept-Teil herausholen (JSON-LD „Recipe" oder Text). */
async function pageText(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Accept-Language': 'de-DE,de;q=0.9'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 1_500_000);
  const decode = (t) => String(t || '').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  const meta = (name) => decode(html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)`, 'i'))?.[1]);

  // 1. Strukturierte Rezeptdaten (Chefkoch, Lecker, viele Blogs)
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [data].flat().flatMap((d) => (d && d['@graph'] ? d['@graph'] : [d]));
    const recipe = nodes.find((n) => n && [n['@type']].flat().includes('Recipe'));
    if (!recipe) continue;
    const steps = [recipe.recipeInstructions].flat().filter(Boolean).flatMap((st) => {
      if (typeof st === 'string') return [st];
      if (st.itemListElement) return [st.itemListElement].flat().map((x) => x.text || x.name || '');
      return [st.text || st.name || ''];
    });
    return [
      `Titel: ${decode(recipe.name)}`,
      recipe.recipeYield ? `Portionen: ${[recipe.recipeYield].flat().join(' ')}` : '',
      recipe.totalTime ? `Zeit: ${recipe.totalTime}` : '',
      recipe.description ? `Beschreibung: ${decode(recipe.description)}` : '',
      `Zutaten:\n${[recipe.recipeIngredient].flat().filter(Boolean).map((z) => `- ${decode(z)}`).join('\n')}`,
      `Zubereitung:\n${steps.map((st, i) => `${i + 1}. ${decode(st).replace(/<[^>]+>/g, ' ')}`).join('\n')}`
    ].filter(Boolean).join('\n').slice(0, 15000);
  }

  // 2. Sonst: Titel, Beschreibung (bei Instagram steht dort der Beitragstext) und Seitentext
  const body = decode(html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|h\d|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return [
    `Titel: ${meta('og:title') || decode(html.match(/<title>([^<]*)/i)?.[1])}`,
    `Beschreibung: ${meta('og:description') || meta('description')}`,
    `Seitentext:\n${body.slice(0, 12000)}`
  ].join('\n');
}

/** Rezept aus Foto, Link oder Text. */
async function handleRezept(body, env, cors) {
  const parts = [];
  if (typeof body?.bild === 'string' && body.bild) {
    const mime = /^image\/(jpeg|png|webp|heic|heif)$/.test(body.mime) ? body.mime : 'image/jpeg';
    if (body.bild.length > 6_000_000) return json({ fehler: 'Das Foto ist zu groß.' }, 400, cors);
    parts.push({ inlineData: { mimeType: mime, data: body.bild } });
    parts.push({ text: 'Lies das Rezept auf diesem Foto aus.' });
  } else if (typeof body?.link === 'string' && body.link) {
    let text = null;
    try {
      text = await pageText(body.link.trim().slice(0, 2000));
    } catch (err) {
      console.warn('[Rezept] Seite nicht ladbar', err.message);
    }
    if (!text) {
      return json({ fehler: 'Die Seite lässt sich nicht öffnen. Kopiere den Rezepttext und füge ihn unten ein, oder mach ein Bildschirmfoto.' }, 422, cors);
    }
    parts.push({ text: `Link: ${body.link}\n\n${text}` });
  } else if (typeof body?.text === 'string' && body.text.trim()) {
    parts.push({ text: body.text.trim().slice(0, 15000) });
  } else {
    return json({ fehler: 'Bitte ein Foto, einen Link oder Text schicken.' }, 400, cors);
  }
  const ai = createClient(env.GEMINI_API_KEY, 40000);
  const out = await generateJson(ai, {
    system: IMPORT_SYSTEM,
    contents: [{ role: 'user', parts }],
    schema: ImportSchema,
    maxTokens: 6000,
    model: env.GEMINI_MODEL || undefined,
    retryDelayMs: 1500,
    maxModels: 3
  });
  if (!out.gefunden || !out.rezept?.zutaten?.length) {
    return json({ fehler: out.hinweis || 'Darin habe ich kein Rezept gefunden.' }, 422, cors);
  }
  return json({ rezept: out.rezept, hinweis: out.hinweis }, 200, cors);
}

/* ---------------- Worker ---------------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const originOk = !allowed.length || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk && origin ? origin : allowed[0] || '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Familien-Code',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return json({ ok: Boolean(env.GEMINI_API_KEY), familienCode: Boolean(env.FAMILY_CODE) }, 200, cors);
    }
    if (!['/chat', '/rezept'].includes(url.pathname) || request.method !== 'POST') return json({ fehler: 'Nicht gefunden' }, 404, cors);
    if (!originOk) return json({ fehler: 'Nicht erlaubt' }, 403, cors);
    if (env.FAMILY_CODE && request.headers.get('X-Familien-Code') !== env.FAMILY_CODE) {
      return json({ fehler: 'code', antwort: 'Der Familien-Code stimmt nicht.' }, 401, cors);
    }
    if (!env.GEMINI_API_KEY) return json({ fehler: 'Der Helfer ist noch nicht eingerichtet.' }, 503, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unbekannt';
    if (rateLimited(ip)) {
      return json({ fehler: 'Viele Fragen auf einmal – bitte in einer Stunde wieder probieren.' }, 429, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ fehler: 'Ungültige Anfrage' }, 400, cors);
    }
    if (url.pathname === '/rezept') {
      try {
        return await handleRezept(body, env, cors);
      } catch (err) {
        console.error('[Rezept]', err);
        if (err instanceof ApiError && err.status === 429) {
          return json({ fehler: 'Gerade ist viel los – bitte in einer Minute nochmal versuchen.' }, 429, cors);
        }
        return json({ fehler: 'Konnte das Rezept gerade nicht auslesen. Bitte nochmal versuchen.' }, 503, cors);
      }
    }
    const messages = validMessages(body?.messages);
    if (!messages) return json({ fehler: 'Ungültige Nachrichten' }, 400, cors);

    const list = Array.isArray(body?.liste) ? body.liste.filter((s) => typeof s === 'string').slice(0, 150).map((s) => s.slice(0, 80)) : [];
    const wissen = Array.isArray(body?.wissen) ? body.wissen.filter((s) => typeof s === 'string').slice(0, 60).map((s) => s.slice(0, 240)) : [];
    const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });

    // Gemini-Format: Rollen "user" / "model". Der aktuelle Stand (Datum, Liste)
    // kommt in die letzte Nachricht.
    const contents = messages.map((m, i) => {
      const isLast = i === messages.length - 1;
      const text = isLast
        ? `[Heute ist ${today}.\nDas weißt du über die Familie:\n${wissen.length ? wissen.map((w) => `- ${w}`).join('\n') : '- noch nichts'}\nAuf der Einkaufsliste steht schon: ${list.length ? list.join(', ') : 'noch nichts'}.]\n\n${m.content}`
        : m.content;
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
    });

    const ai = createClient(env.GEMINI_API_KEY, 25000);
    try {
      const out = await generateJson(ai, {
        system: `${SYSTEM_PROMPT}\n\n${await offersContext(env)}`,
        contents,
        schema: ReplySchema,
        maxTokens: 12000,
        model: env.GEMINI_MODEL || undefined,
        retryDelayMs: 1500,
        maxModels: 3
      });
      return json({ antwort: out.antwort, artikel: out.artikel.slice(0, 40), rezepte: out.rezepte.slice(0, 2), merken: out.merken.slice(0, 5) }, 200, cors);
    } catch (err) {
      if (err instanceof GeminiBlocked) {
        return json({ antwort: 'Dabei kann ich leider nicht helfen. Frag mich gern etwas anderes rund ums Einkaufen und Kochen! 😊', artikel: [] }, 200, cors);
      }
      if (err instanceof ApiError) {
        if (err.status === 429) return json({ fehler: 'Gerade ist viel los – bitte in einer Minute nochmal versuchen.' }, 429, cors);
        if (err.status >= 500) {
          return json({ fehler: 'Gemini ist gerade überlastet. Bitte in ein, zwei Minuten nochmal fragen. 🙏' }, 503, cors);
        }
        if (err.status === 400 || err.status === 401 || err.status === 403) {
          return json({ fehler: 'Der Helfer kommt gerade nicht an Gemini heran (Schlüssel oder Einstellung prüfen).' }, 503, cors);
        }
        return json({ fehler: `Der Helfer hat gerade ein Problem (${err.status}).` }, 502, cors);
      }
      console.error('[Helfer]', err);
      return json({ antwort: 'Da ist etwas durcheinandergeraten – magst du es nochmal fragen?', artikel: [] }, 200, cors);
    }
  }
};
