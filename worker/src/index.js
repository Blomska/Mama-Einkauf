/**
 * Chat-Helfer für die Familien-Einkaufsliste (Cloudflare Worker)
 * ------------------------------------------------------------------
 * Die App schickt den Chatverlauf + die aktuelle Einkaufsliste hierher.
 * Der Worker ergänzt die Angebote der Woche (aus data/prospekte.json der
 * App), fragt Claude und gibt eine freundliche Antwort plus – falls passend –
 * eine Liste von Artikeln zurück, die Mama mit einem Tipp übernehmen kann.
 *
 * Geheimnisse (als Worker-Secrets, NIE im Code):
 *   ANTHROPIC_API_KEY – API-Schlüssel von console.anthropic.com
 *   FAMILY_CODE       – Familien-Code, den die App einmalig abfragt
 *                       (schützt vor fremder Nutzung und Kosten)
 * ------------------------------------------------------------------
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod';

const MODEL = 'claude-opus-5-5';
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
      return json({ ok: Boolean(env.ANTHROPIC_API_KEY), familienCode: Boolean(env.FAMILY_CODE) }, 200, cors);
    }
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ fehler: 'Nicht gefunden' }, 404, cors);
    if (!originOk) return json({ fehler: 'Nicht erlaubt' }, 403, cors);
    if (env.FAMILY_CODE && request.headers.get('X-Familien-Code') !== env.FAMILY_CODE) {
      return json({ fehler: 'code', antwort: 'Der Familien-Code stimmt nicht.' }, 401, cors);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ fehler: 'Der Helfer ist noch nicht eingerichtet.' }, 503, cors);

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

    // Aktueller Stand (ändert sich pro Anfrage) gehört in die letzte Nachricht,
    // damit System-Prompt + Angebote im Prompt-Cache bleiben.
    const last = messages.pop();
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: `[Heute ist ${today}. Auf der Einkaufsliste steht schon: ${list.length ? list.join(', ') : 'noch nichts'}.]` },
        { type: 'text', text: last.content }
      ]
    });

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const response = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          { type: 'text', text: SYSTEM_PROMPT },
          { type: 'text', text: await offersContext(env), cache_control: { type: 'ephemeral' } }
        ],
        messages,
        output_config: { effort: 'low', format: betaZodOutputFormat(ReplySchema) }
      });

      if (response.stop_reason === 'refusal') {
        return json({ antwort: 'Dabei kann ich leider nicht helfen. Frag mich gern etwas anderes rund ums Einkaufen und Kochen! 😊', artikel: [] }, 200, cors);
      }
      const out = response.parsed_output;
      if (!out) {
        return json({ antwort: 'Da ist etwas durcheinandergeraten – magst du es nochmal fragen?', artikel: [] }, 200, cors);
      }
      return json({ antwort: out.antwort, artikel: out.artikel.slice(0, 40) }, 200, cors);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        return json({ fehler: 'Gerade ist viel los – bitte gleich nochmal versuchen.' }, 429, cors);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        return json({ fehler: 'Der API-Schlüssel des Helfers stimmt nicht.' }, 503, cors);
      }
      if (err instanceof Anthropic.APIError) {
        return json({ fehler: `Der Helfer hat gerade ein Problem (${err.status ?? 'Verbindung'}).` }, 502, cors);
      }
      return json({ fehler: 'Unerwarteter Fehler im Helfer.' }, 500, cors);
    }
  }
};
