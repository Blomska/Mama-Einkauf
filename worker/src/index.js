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

const ReplySchema = z.object({
  antwort: z.string(),
  artikel: z.array(z.object({
    name: z.string(),
    menge: z.string(),
    laden: z.enum(['aldi', 'marktkauf', 'egal'])
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
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ fehler: 'Nicht gefunden' }, 404, cors);
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
    const messages = validMessages(body?.messages);
    if (!messages) return json({ fehler: 'Ungültige Nachrichten' }, 400, cors);

    const list = Array.isArray(body?.liste) ? body.liste.filter((s) => typeof s === 'string').slice(0, 150).map((s) => s.slice(0, 80)) : [];
    const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });

    // Gemini-Format: Rollen "user" / "model". Der aktuelle Stand (Datum, Liste)
    // kommt in die letzte Nachricht.
    const contents = messages.map((m, i) => {
      const isLast = i === messages.length - 1;
      const text = isLast
        ? `[Heute ist ${today}. Auf der Einkaufsliste steht schon: ${list.length ? list.join(', ') : 'noch nichts'}.]\n\n${m.content}`
        : m.content;
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] };
    });

    const ai = createClient(env.GEMINI_API_KEY, 25000);
    try {
      const out = await generateJson(ai, {
        system: `${SYSTEM_PROMPT}\n\n${await offersContext(env)}`,
        contents,
        schema: ReplySchema,
        maxTokens: 8192,
        model: env.GEMINI_MODEL || undefined,
        retryDelayMs: 1500,
        maxModels: 3
      });
      return json({ antwort: out.antwort, artikel: out.artikel.slice(0, 40) }, 200, cors);
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
