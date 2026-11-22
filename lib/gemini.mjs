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

/**
 * @param {string} apiKey
 * @param {number} [timeoutMs] Zeitlimit je Anfrage. Die eingebauten Wiederholungen des
 *   SDK sind aus – Wiederholung und Modellwechsel steuert generateJson selbst.
 */
export function createClient(apiKey, timeoutMs = 90000) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } }
  });
}

/** Wartet ms Millisekunden. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fehler, bei denen sich ein neuer Versuch / ein anderes Modell lohnt. */
function isTransient(err) {
  return err instanceof ApiError && [500, 502, 503, 504].includes(err.status);
}

/** Kontingent erschöpft (429) – gilt bei Google je Modell, also anderes Modell probieren. */
export function isQuota(err) {
  return err instanceof ApiError && err.status === 429;
}

let modelListCache = null;

/**
 * Verfügbare Text-Modelle als Ausweichliste, beste zuerst:
 * stabile Flash-Modelle (neueste zuerst), dann Flash-Lite.
 */
async function fallbackModels(ai) {
  if (modelListCache) return modelListCache;
  const names = [];
  try {
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    for await (const model of pager) {
      if (!model.name || (model.supportedActions && !model.supportedActions.includes('generateContent'))) continue;
      names.push(model.name.replace(/^models\//, ''));
    }
  } catch (err) {
    console.warn(`[Gemini] Modellliste nicht abrufbar: ${err.message}`);
    return [];
  }
  const version = (n) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || '0');
  const byVersion = (a, b) => version(b) - version(a);
  const flash = names.filter((n) => /^gemini-\d+(?:\.\d+)?-flash$/.test(n)).sort(byVersion);
  const lite = names.filter((n) => /^gemini-\d+(?:\.\d+)?-flash-lite$/.test(n)).sort(byVersion);
  modelListCache = [...flash, ...lite];
  return modelListCache;
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
 * @param {number} [opts.retryDelayMs] Wartezeit vor dem zweiten Versuch bei Überlastung
 * @param {number} [opts.maxModels]    wie viele Modelle höchstens probiert werden
 */
export async function generateJson(ai, { system, contents, schema, maxTokens = 8192, model, retryDelayMs = 4000, maxModels = 4 }) {
  const config = {
    systemInstruction: system,
    responseMimeType: 'application/json',
    responseJsonSchema: toGeminiSchema(schema),
    maxOutputTokens: maxTokens
  };
  const run = (name) => ai.models.generateContent({ model: name, contents, config });

  // Reihenfolge: festgelegtes/zuletzt erfolgreiches Modell → Standard → Ausweichmodelle
  const tried = new Set();
  const queue = [model || resolvedModel || DEFAULT_MODEL];
  let fallbacksLoaded = false;
  let response;
  let modelName;
  let lastError;

  while (queue.length && tried.size < maxModels) {
    modelName = queue.shift();
    if (tried.has(modelName)) continue;
    tried.add(modelName);
    try {
      response = await run(modelName);
      break;
    } catch (err) {
      lastError = err;
      const unknown = err instanceof ApiError && err.status === 404;
      if (!unknown && !isTransient(err) && !isQuota(err)) throw err;
      if (isTransient(err)) {
        // Kurz warten und dasselbe Modell nochmal versuchen
        console.warn(`[Gemini] ${modelName} überlastet (${err.status}) – neuer Versuch`);
        await sleep(retryDelayMs);
        try {
          response = await run(modelName);
          break;
        } catch (retryErr) {
          lastError = retryErr;
          if (!isTransient(retryErr)) throw retryErr;
        }
      }
      // Anderes Modell probieren
      if (!fallbacksLoaded) {
        fallbacksLoaded = true;
        if (!model) queue.push(...(await fallbackModels(ai)));
      }
      if (queue.find((m) => !tried.has(m))) {
        console.warn(`[Gemini] ${modelName} nicht nutzbar – probiere ${queue.find((m) => !tried.has(m))}`);
      }
    }
  }
  if (!response) throw lastError;
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
