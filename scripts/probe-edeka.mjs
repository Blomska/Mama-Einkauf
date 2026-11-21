#!/usr/bin/env node
/**
 * scripts/probe-edeka.mjs – Diagnose (läuft im GitHub-Workflow mit)
 * Prüft, ob die offiziellen EDEKA/Marktkauf-Quellen für Marktkauf Nientied
 * Lüdinghausen (EDEKA Markt-ID 10008010) vom GitHub-Server aus erreichbar
 * sind, und zeigt einen Ausschnitt der Antwort im Workflow-Protokoll.
 * Ändert keine Dateien.
 */
const MARKET_ID = '10008010';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const URLS = [
  `https://www.edeka.de/api/offers?limit=999&marketId=${MARKET_ID}`,
  `https://www.edeka.de/eh/service/eh/offers?marketId=${MARKET_ID}`,
  `https://www.edeka.de/markt-id/${MARKET_ID}/prospekt.jsp`,
  'https://www.edeka.de/maerkte/071844/',
  'https://www.marktkauf.de/',
  'https://flipgorilla.com/p/30101275508998184/show'
];

for (const url of URLS) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE', Accept: 'application/json, text/html;q=0.9' } });
    const body = await res.text();
    console.log(`\n=== ${res.status} ${res.headers.get('content-type')} ${body.length}B ${url}`);
    console.log(`CORS: ${res.headers.get('access-control-allow-origin')}`);
    if (res.ok) {
      const links = [...new Set(body.match(/https?:\/\/[^"'\s<>]*(?:pdf|blaetter|prospekt|flyer|catalog)[^"'\s<>]*/gi) || [])].slice(0, 15);
      if (links.length) console.log('Links:', links.join('\n  '));
      console.log(body.slice(0, 1500));
    }
  } catch (err) {
    console.log(`\n=== FEHLER ${url}: ${err.message}`);
  }
}
