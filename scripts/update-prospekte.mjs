#!/usr/bin/env node
/**
 * scripts/update-prospekte.mjs
 * ------------------------------------------------------------------
 * Holt die aktuellen Prospekte & Angebote und schreibt sie nach
 * data/prospekte.json. Läuft automatisch per GitHub Actions
 * (.github/workflows/deploy.yml), kann aber auch lokal gestartet werden:
 *
 *     node scripts/update-prospekte.mjs
 *
 * Quellen:
 *  - Aldi Nord Prospekt (diese + nächste Woche): Seitenbilder + PDF-Link
 *  - Aldi Nord Angebote: strukturierte Daten (Name, Marke, Preis, Bild)
 *  - Marktkauf Nientied Lüdinghausen: Titelbild, Gültigkeit, Prospekt-Link
 *
 * Fällt eine Quelle aus, bleiben die anderen erhalten. Bei Totalausfall
 * werden die zuletzt gespeicherten Daten beibehalten.
 * Keine Abhängigkeiten – benötigt Node 18+ (eingebautes fetch).
 * ------------------------------------------------------------------
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'data/prospekte.json');

const SOURCES = {
  aldiCurrent: 'https://www.aldi-nord.de/prospekte/aldi-aktuell.html',
  aldiNext: 'https://www.aldi-nord.de/prospekte/aldi-vorschau.html',
  aldiOffers: 'https://www.aldi-nord.de/angebote.html',
  marktkauf: 'https://edeka-nientied.de/angebote-marktkauf-nientied-luedinghausen/'
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9'
};

/* ---------------- Hilfsfunktionen ---------------- */

async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

function decodeEntities(str) {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Liest das eingebettete "apiData"-JSON der Aldi-Seiten aus. */
function extractAldiApiData(html) {
  const match = html.match(/"apiData":"((?:\\.|[^"\\])*)"/);
  if (!match) throw new Error('apiData nicht gefunden');
  const entries = JSON.parse(JSON.parse(`"${match[1]}"`));
  return Object.fromEntries(entries.map(([name, payload]) => [name, payload]));
}

/** Montag einer ISO-Kalenderwoche als YYYY-MM-DD. */
function isoWeekMonday(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "16.11.26" → "2026-11-16" */
function germanDateToIso(str) {
  const m = String(str).match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function formatEuro(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  return `${value.toFixed(2).replace('.', ',')} €`;
}

/* ---------------- Aldi: Prospekte ---------------- */

async function loadAldiFlyer(url) {
  const html = await fetchText(url);
  const api = extractAldiApiData(html);
  const structure = api.LEAFLET_IPAPER_STRUCTURE_GET;
  if (!structure?.req?.url) throw new Error('Kein Prospekt auf der Seite');

  const viewerUrl = structure.req.url.replace(/\/?$/, '/');
  const pages = (structure.res || [])
    .map((p) => ({ n: Number(p.pageNumber), url: p.url }))
    .filter((p) => p.n && p.url)
    .sort((a, b) => a.n - b.n)
    .map((p) => p.url);

  // Gültigkeit aus der Kalenderwoche im Pfad, z. B. ".../2026cw47mo..."
  const cw = viewerUrl.match(/(\d{4})cw(\d{1,2})/i);
  const validFrom = cw ? isoWeekMonday(Number(cw[1]), Number(cw[2])) : null;

  return {
    title: 'ALDI Aktuell',
    validFrom,
    validTo: validFrom ? addDays(validFrom, 5) : null,
    viewerUrl,
    pdfUrl: `${viewerUrl}GetPDF.ashx`,
    cover: pages[0] || null,
    pages
  };
}

/* ---------------- Aldi: Angebote ---------------- */

async function loadAldiOffers() {
  const html = await fetchText(SOURCES.aldiOffers);
  const api = extractAldiApiData(html);
  const data = api.OFFER_GET?.res;
  if (!data?.algoliaDataMap) throw new Error('Keine Angebotsdaten');

  // Produkt-ID → Aktions-Gruppe ("Frische-Aktion: Obst & Gemüse" …)
  const groupOf = {};
  const groups = [];
  for (const action of data.categories || []) {
    for (const block of action.content || []) {
      if (!Array.isArray(block.productIds) || !block.title) continue;
      const groupTitle = block.title.trim();
      const label = `${groupTitle} · ${action.shortTitle || action.title}`;
      if (!groups.includes(label)) groups.push(label);
      block.productIds.forEach((id) => { groupOf[id] = groupOf[id] || label; });
    }
  }

  const offers = [];
  for (const [id, p] of Object.entries(data.algoliaDataMap)) {
    if (!p || !p.name || p.isAvailable === false) continue;
    const promo = (p.promotionPrices && p.promotionPrices[0]) || {};
    const price = p.currentPrice?.priceValue ?? promo.priceValue;
    const base = (p.currentPrice?.basePrice || promo.basePrice || [])[0];
    const image = (p.assets || []).find((a) => a.type === 'primary')?.url;
    offers.push({
      id,
      name: p.name.trim(),
      brand: (p.brandName || '').trim(),
      price: formatEuro(price),
      unit: (p.salesUnit || '').trim(),
      basePrice: base && base.basePriceValue ? `1 ${base.basePriceScale} = ${formatEuro(base.basePriceValue)}` : '',
      validFrom: promo.validFromLocalDate || null,
      validTo: promo.validUntilLocalDate || null,
      group: groupOf[id] || 'Weitere Angebote',
      image: image ? `${image}?wid=320&hei=320&fit=fit,1&fmt=jpg&qlt=80` : null
    });
  }

  offers.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.name.localeCompare(b.name, 'de'));
  return { groups: groups.filter((g) => offers.some((o) => o.group === g)), offers, sourceUrl: SOURCES.aldiOffers };
}

/* ---------------- Marktkauf Nientied ---------------- */

/** Wählt aus src/srcset die Bildgröße, die am nächsten an `width` liegt. */
function pickSrc(imgTag, width) {
  const src = imgTag.match(/\ssrc="([^"]+)"/i)?.[1];
  const srcset = imgTag.match(/\ssrcset="([^"]+)"/i)?.[1];
  if (!srcset) return src;
  const candidates = srcset.split(',').map((part) => {
    const [url, w] = part.trim().split(/\s+/);
    return { url, w: parseInt(w, 10) || 0 };
  }).filter((c) => c.url && c.w);
  if (!candidates.length) return src;
  candidates.sort((a, b) => Math.abs(a.w - width) - Math.abs(b.w - width));
  return candidates[0].url;
}

/**
 * Lädt ein Titelbild in den data-Ordner, damit es von GitHub Pages
 * ausgeliefert wird (kein Fremd-Einbinden, keine Sperren durch den Shop).
 * Bei Fehlern bleibt die Original-Adresse erhalten.
 */
async function mirrorImage(url, baseName) {
  if (!url || !/^https?:/.test(url)) return url;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const file = `${baseName}.${ext}`;
    await writeFile(resolve(ROOT, 'data', file), Buffer.from(await res.arrayBuffer()));
    return `data/${file}`;
  } catch (err) {
    console.warn(`  Bild nicht gespiegelt (${err.message}) – nutze Original-Adresse`);
    return url;
  }
}


async function loadMarktkauf() {
  const html = await fetchText(SOURCES.marktkauf);

  // Abschnitte anhand der Überschriften trennen
  const parts = html.split(/<h2[^>]*>/i).slice(1).map((chunk) => {
    const end = chunk.indexOf('</h2>');
    return { heading: stripTags(chunk.slice(0, end)), body: chunk.slice(end) };
  });

  const parseSection = (section) => {
    if (!section) return null;
    // Nur den Inhalt bis zur nächsten Überschrift / Seitenleiste betrachten
    const body = section.body.split(/<h[1-3][\s>]|<\/article|<aside|class="[^"]*(?:sidebar|widget)/i)[0];
    const text = stripTags(body);
    const dates = text.match(/(\d{1,2}\.\d{1,2}\.\d{2,4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/);
    const link = body.match(/href="(https?:\/\/[^"]*(?:flipgorilla|prospekt|\.pdf)[^"]*)"/i);
    const imgTag = link ? body.match(/<img[^>]+src="https?:\/\/[^"]+\/wp-content\/uploads\/[^>]+>/i) : null;
    const img = imgTag ? [null, pickSrc(imgTag[0], 768)] : null;
    if (!dates && !link) return null;
    return {
      title: 'Marktkauf Nientied',
      validFrom: dates ? germanDateToIso(dates[1]) : null,
      validTo: dates ? germanDateToIso(dates[2]) : null,
      viewerUrl: link ? decodeEntities(link[1]) : null,
      pdfUrl: link && /\.pdf(\?|$)/i.test(link[1]) ? decodeEntities(link[1]) : null,
      cover: img ? decodeEntities(img[1]) : null,
      pages: []
    };
  };

  const current = parseSection(parts.find((p) => /aktuelle angebote/i.test(p.heading)));
  const next = parseSection(parts.find((p) => /folgewoche/i.test(p.heading)));
  if (!current && !next) throw new Error('Keine Prospekt-Infos gefunden');
  await mkdir(resolve(ROOT, 'data'), { recursive: true });
  if (current?.cover) current.cover = await mirrorImage(current.cover, 'marktkauf-aktuell');
  if (next?.cover) next.cover = await mirrorImage(next.cover, 'marktkauf-vorschau');
  return { current, next, pageUrl: SOURCES.marktkauf };
}

/* ---------------- Hauptprogramm ---------------- */

async function settle(label, fn) {
  try {
    const value = await fn();
    console.log(`✓ ${label}`);
    return value;
  } catch (err) {
    console.warn(`✗ ${label}: ${err.message}`);
    return undefined;
  }
}

async function main() {
  let previous = {};
  try {
    previous = JSON.parse(await readFile(OUT_FILE, 'utf8'));
  } catch { /* erste Ausführung */ }

  const [aldiCurrent, aldiNext, aldiOffers, marktkauf] = await Promise.all([
    settle('Aldi Prospekt (diese Woche)', () => loadAldiFlyer(SOURCES.aldiCurrent)),
    settle('Aldi Prospekt (nächste Woche)', () => loadAldiFlyer(SOURCES.aldiNext)),
    settle('Aldi Angebote', loadAldiOffers),
    settle('Marktkauf Prospekt', loadMarktkauf)
  ]);

  const result = {
    updatedAt: new Date().toISOString(),
    aldi: {
      pageUrl: 'https://www.aldi-nord.de/prospekte.html',
      current: aldiCurrent ?? previous.aldi?.current ?? null,
      next: aldiNext ?? previous.aldi?.next ?? null,
      offers: aldiOffers ?? previous.aldi?.offers ?? null
    },
    marktkauf: marktkauf ?? previous.marktkauf ?? { current: null, next: null, pageUrl: SOURCES.marktkauf }
  };

  // Vorschau = gleiche Woche wie aktuell? Dann weglassen.
  if (result.aldi.next && result.aldi.current && result.aldi.next.viewerUrl === result.aldi.current.viewerUrl) {
    result.aldi.next = null;
  }

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(result, null, 1)}\n`);
  const count = result.aldi.offers?.offers?.length ?? 0;
  console.log(`→ ${OUT_FILE} geschrieben (${count} Aldi-Angebote)`);

  if (!aldiCurrent && !aldiOffers && !marktkauf) {
    console.error('Alle Quellen fehlgeschlagen – alte Daten beibehalten.');
    process.exitCode = previous.updatedAt ? 0 : 1;
  }
}

main();
