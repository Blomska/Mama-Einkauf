/**
 * lib/gemini.mjs – gemeinsamer Gemini-Baustein
 * ------------------------------------------------------------------
 * Wird vom Küchenhelfer (worker/) und vom Wochen-Skript
 * (scripts/ki-auswertung.mjs) genutzt.
 *
 *  - Strukturierte Antworten: Gemini antwortet als JSON nach einem
 *    Zod-Schema, die Antwort wird anschließend geprüft.
 *  - Modellwahl: Standard ist DEFAULT_MODEL. Kennt der Schlüssel dieses
 *    Modell nicht (404), sucht der Baustein automatisch das neueste
 *    verfügbare Flash-Modell. Mit GEMINI_MODEL lässt sich ein Modell
 *    fest vorgeben.
 * ------------------------------------------------------------------
 */

import { GoogleGenAI, ApiError } from '@google/genai';
import * as z from 'zod';

export const DEFAULT_MODEL = 'gemini-3.8-flash';

export class GeminiBlocked extends Error {}

let resolvedModel = null;

export function createClient(apiKey) {
  return new GoogleGenAI({ apiKey });
}

/** Neuestes stabiles Flash-Modell, das generateContent kann. */
async function newestFlashModel(ai) {
  const names = [];
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  for await (const model of pager) {
    if (!model.name || (model.supportedActions && !model.supportedActions.includes('generateContent'))) continue;
    names.push(model.name.replace(/^models\//, ''));
  }
  const version = (n) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || '0');
  const stableFlash = names.filter((n) => /^gemini-\d+(?:\.\d+)?-flash$/.test(n)).sort((a, b) => version(b) - version(a));
  if (stableFlash.length) return stableFlash[0];
  const anyFlash = names
    .filter((n) => /flash/.test(n) && !/image|tts|live|audio|embedding|lite/.test(n))
    .sort((a, b) => version(b) - version(a));
  return anyFlash[0] || null;
}

/** Zod-Schema → JSON-Schema für Gemini (ohne $schema-Kopf). */
function toGeminiSchema(schema) {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  // Zod setzt bei .int() die Grenzen ±MAX_SAFE_INTEGER – überflüssig, also entfernen
  const clean = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Math.abs(node.minimum) === Number.MAX_SAFE_INTEGER) delete node.minimum;
    if (Math.abs(node.maximum) === Number.MAX_SAFE_INTEGER) delete node.maximum;
    Object.values(node).forEach(clean);
  };
  clean(json);
  return json;
}

/**
 * Fragt Gemini und liefert ein geprüftes Objekt nach `schema`.
 * @param {GoogleGenAI} ai
 * @param {object} opts
 * @param {string} opts.system     Systemanweisung
 * @param {Array}  opts.contents   Gemini-Inhalte [{ role: 'user'|'model', parts: [...] }]
 * @param {z.ZodType} opts.schema  erwartetes Antwortformat
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.model]    fest vorgegebenes Modell (sonst automatisch)
 */
export async function generateJson(ai, { system, contents, schema, maxTokens = 8192, model }) {
  const config = {
    systemInstruction: system,
    responseMimeType: 'application/json',
    responseJsonSchema: toGeminiSchema(schema),
    maxOutputTokens: maxTokens
  };
  const run = (name) => ai.models.generateContent({ model: name, contents, config });

  let modelName = model || resolvedModel || DEFAULT_MODEL;
  let response;
  try {
    response = await run(modelName);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404 || model) throw err;
    // Modell unbekannt → neuestes verfügbares Flash-Modell suchen
    const fallback = await newestFlashModel(ai);
    if (!fallback || fallback === modelName) throw err;
    console.warn(`[Gemini] ${modelName} nicht verfügbar – nutze ${fallback}`);
    modelName = fallback;
    response = await run(modelName);
  }
  resolvedModel = modelName;

  const finish = response.candidates?.[0]?.finishReason;
  if (finish === 'SAFETY' || response.promptFeedback?.blockReason) {
    throw new GeminiBlocked('Von Gemini blockiert');
  }
  if (finish === 'MAX_TOKENS') throw new Error('Antwort zu lang (MAX_TOKENS)');

  const text = response.text;
  if (!text) throw new Error('Leere Antwort');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Antwort war kein gültiges JSON');
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error('Antwort passt nicht zum erwarteten Format');

  const usage = response.usageMetadata;
  if (usage) console.log(`    ${modelName}: ${usage.promptTokenCount ?? '?'} Tokens rein / ${usage.candidatesTokenCount ?? '?'} raus`);
  return parsed.data;
}

export { ApiError };
