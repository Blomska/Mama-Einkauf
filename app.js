/**
 * app.js – Familien-Einkaufsliste
 * ------------------------------------------------------------------
 * Aufbau:
 *   1. Konstanten & Hilfsfunktionen
 *   2. Datenspeicher (Firebase Firestore ODER lokaler Demo-Modus)
 *   3. Zustand, Favoriten & gelernte Kategorien
 *   4. Rendering
 *   5. Aktionen (Hinzufügen, Abhaken, Bearbeiten, Löschen, Teilen)
 *   6. Wake Lock, Service Worker, Start
 *
 * Datenmodell eines Artikels (Firestore: lists/{LIST_ID}/items/{id}):
 * {
 *   name:       string   – "Milch"
 *   qty:        string   – "2×", "500 g" oder ""
 *   store:      string   – "both" | "marktkauf" | "aldi"
 *   category:   string   – Kategorie-ID aus categories.js
 *   done:       boolean
 *   doneAt:     number|null (ms)
 *   createdAt:  number (ms)
 *   isOffer:    boolean  – für spätere Angebots-Feeds
 *   offerPrice: string   – z. B. "1,99 €"
 * }
 *
 * Angebote (Firestore: lists/{LIST_ID}/offers/{normalisierterName}):
 * { name: "Skyr", store: "aldi" | "marktkauf", price: "0,99 €", until: ms }
 * Ein Angebot gilt automatisch bis Samstagabend der laufenden Woche und
 * wird an allen passenden Artikeln und Favoriten angezeigt.
 * Die Item-Felder isOffer/offerPrice bleiben für einen späteren
 * automatischen Angebots-Feed reserviert.
 * ------------------------------------------------------------------
 */

import {
  CATEGORIES, CATEGORY_BY_ID, DEFAULT_CATEGORY, categorize, normalize, parseItems, offerMatchScore
} from './categories.js';
import {
  firebaseConfig, LIST_ID, USE_ANONYMOUS_AUTH, OFFER_LINKS, MAMA_FAVORITES, GREETING_NAME, CHAT_URL,
  isFirebaseConfigured
} from './config.js';
import { START_WISSEN, WISSEN_VERSION, WOCHENEINKAUF } from './wissen.js';

/* ================================================================
 * 1. Konstanten & Hilfsfunktionen
 * ================================================================ */

const FIREBASE_VERSION = '10.12.2';
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const STORE_LABELS = { both: 'Beide / Egal', marktkauf: 'Marktkauf', aldi: 'Aldi' };
const CHECK_ANIMATION_MS = 600;
const FAVORITES_LIMIT = 12;
const STARTER_FAVORITES = ['Milch', 'Brot', 'Eier', 'Butter', 'Bananen', 'Äpfel', 'Käse', 'Joghurt', 'Kaffee', 'Tomaten'];

const LS = {
  freq: 'einkauf:freq',
  learned: 'einkauf:learned',
  doneOpen: 'einkauf:doneOpen',
  filter: 'einkauf:filter',
  cache: `einkauf:cache:${LIST_ID}`,
  demoItems: `einkauf:demo:${LIST_ID}`,
  demoOffers: `einkauf:demo-offers:${LIST_ID}`,
  offersCache: `einkauf:offers:${LIST_ID}`
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Speicher voll oder blockiert – App funktioniert trotzdem */
  }
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function vibrate(ms = 12) {
  if (navigator.vibrate) {
    try { navigator.vibrate(ms); } catch { /* ignorieren */ }
  }
}

/** Artikel passt zum Laden-Filter? ("Beide" erscheint überall) */
function matchesFilter(item, filter) {
  if (filter === 'all') return true;
  return item.store === filter || item.store === 'both' || !item.store;
}

/** Fehlende Felder (z. B. von älteren Einträgen) auffüllen. */
function sanitizeItem(raw) {
  return {
    id: raw.id,
    name: String(raw.name || '').slice(0, 80),
    qty: String(raw.qty || '').slice(0, 20),
    store: STORE_LABELS[raw.store] ? raw.store : 'both',
    category: CATEGORY_BY_ID[raw.category] ? raw.category : DEFAULT_CATEGORY,
    done: Boolean(raw.done),
    doneAt: typeof raw.doneAt === 'number' ? raw.doneAt : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    isOffer: Boolean(raw.isOffer),
    offerPrice: String(raw.offerPrice || '')
  };
}

/* ================================================================
 * 2. Datenspeicher
 *    Beide Varianten bieten dieselbe Schnittstelle:
 *    start(onItems, onStatus), add(items), update(id, patch),
 *    remove(ids), restore(items)
 * ================================================================ */

/**
 * Gemeinsame Sammlung (z. B. Gedächtnis, Kochbuch) lokal auf dem Gerät –
 * im Demo-Modus oder solange die passende Firebase-Regel fehlt.
 */
class LocalMapStore {
  constructor(name) {
    this.key = `einkauf:${name}:${LIST_ID}`;
    this.map = readJSON(this.key, {});
  }

  start(onChange) {
    this.onChange = onChange;
    window.addEventListener('storage', (e) => {
      if (e.key === this.key) {
        this.map = readJSON(this.key, {});
        onChange({ ...this.map }, { fromServer: true, local: true });
      }
    });
    onChange({ ...this.map }, { fromServer: true, local: true });
  }

  set(changes) {
    for (const [id, entry] of Object.entries(changes)) {
      if (entry) this.map[id] = entry;
      else delete this.map[id];
    }
    writeJSON(this.key, this.map);
    this.onChange?.({ ...this.map }, { fromServer: true, local: true });
  }
}

/** Demo-Modus: speichert lokal (synchronisiert zwischen Tabs desselben Browsers). */
class LocalBackend {
  constructor() {
    this.items = readJSON(LS.demoItems, []);
  }

  start(onItems, onStatus) {
    this.onItems = onItems;
    onStatus('demo');
    window.addEventListener('storage', (e) => {
      if (e.key === LS.demoItems) {
        this.items = readJSON(LS.demoItems, []);
        this.emit();
      }
    });
    this.emit();
  }

  emit() {
    writeJSON(LS.demoItems, this.items);
    this.onItems?.(this.items.map((i) => ({ ...i })));
  }

  add(items) {
    this.items.push(...items);
    this.emit();
  }

  update(id, patch) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    this.emit();
  }

  remove(ids) {
    const set = new Set(ids);
    this.items = this.items.filter((i) => !set.has(i.id));
    this.emit();
  }

  restore(items) {
    const ids = new Set(items.map((i) => i.id));
    this.items = this.items.filter((i) => !ids.has(i.id)).concat(items);
    this.emit();
  }

  startOffers(onOffers) {
    this.onOffers = onOffers;
    this.offers = readJSON(LS.demoOffers, {});
    window.addEventListener('storage', (e) => {
      if (e.key === LS.demoOffers) {
        this.offers = readJSON(LS.demoOffers, {});
        onOffers({ ...this.offers });
      }
    });
    onOffers({ ...this.offers });
  }

  setOffers(changes) {
    for (const [key, offer] of Object.entries(changes)) {
      if (offer) this.offers[key] = offer;
      else delete this.offers[key];
    }
    writeJSON(LS.demoOffers, this.offers);
    this.onOffers?.({ ...this.offers });
  }

  startMap(name, onChange) {
    this.maps = this.maps || {};
    this.maps[name] = new LocalMapStore(name);
    this.maps[name].start(onChange);
  }

  setMap(name, changes) {
    this.maps[name].set(changes);
  }

  startWissen(onWissen) { this.startMap('wissen', onWissen); }
  setWissen(changes) { this.setMap('wissen', changes); }
}

/** Firebase Firestore mit Echtzeit-Sync & Offline-Cache. */
class FirebaseBackend {
  constructor() {
    this.ready = null;
    this.unsubscribe = null;
  }

  start(onItems, onStatus) {
    this.onItems = onItems;
    this.onStatus = onStatus;
    onStatus('connecting');
    this.ready = this.init().catch((err) => {
      console.error('[Firebase] Start fehlgeschlagen:', err);
      onStatus(navigator.onLine ? 'error' : 'offline');
      throw err;
    });
  }

  async init() {
    const [appMod, fs, authMod] = await Promise.all([
      import(`${FIREBASE_BASE}/firebase-app.js`),
      import(`${FIREBASE_BASE}/firebase-firestore.js`),
      USE_ANONYMOUS_AUTH ? import(`${FIREBASE_BASE}/firebase-auth.js`) : Promise.resolve(null)
    ]);
    this.fs = fs;

    const app = appMod.initializeApp(firebaseConfig);
    try {
      this.db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
      });
    } catch (err) {
      console.warn('[Firebase] Offline-Cache nicht verfügbar, nutze Standard:', err);
      this.db = fs.getFirestore(app);
    }
    this.col = fs.collection(this.db, 'lists', LIST_ID, 'items');
    this.offersCol = fs.collection(this.db, 'lists', LIST_ID, 'offers');

    if (authMod) {
      const auth = authMod.getAuth(app);
      // Gespeicherte (anonyme) Anmeldung abwarten
      await new Promise((resolve) => {
        const off = authMod.onAuthStateChanged(auth, () => { off(); resolve(); });
      });
      const signIn = async () => {
        if (auth.currentUser) return;
        try {
          await authMod.signInAnonymously(auth);
        } catch (err) {
          console.warn('[Firebase] Anonyme Anmeldung fehlgeschlagen:', err.code || err);
        }
      };
      await signIn();
      window.addEventListener('online', signIn);
      // Nach (Neu-)Anmeldung Listener neu aufbauen, falls er vorher abgelehnt wurde
      authMod.onAuthStateChanged(auth, (user) => {
        if (user && (this.listenerFailed || this.offersFailed || Object.values(this.mapFailed || {}).some(Boolean))) this.subscribe();
      });
    }

    this.subscribe();
  }

  subscribe() {
    const { fs } = this;
    this.listenerFailed = false;
    this.unsubscribe?.();
    this.unsubscribe = fs.onSnapshot(
      this.col,
      { includeMetadataChanges: true },
      (snap) => {
        const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this.onItems(items);
        if (!snap.metadata.fromCache) this.onStatus('live');
        else this.onStatus(navigator.onLine ? 'connecting' : 'offline');
      },
      (err) => {
        console.error('[Firebase] Listener-Fehler:', err);
        this.listenerFailed = true;
        this.onStatus('error', err.code === 'permission-denied'
          ? 'Kein Zugriff – Firestore-Regeln / Anonym-Login prüfen'
          : undefined);
      }
    );

    // Angebote (eigene Sammlung). Fehler hier blockieren die Liste nicht.
    this.offersFailed = false;
    this.unsubscribeOffers?.();
    this.unsubscribeOffers = fs.onSnapshot(
      this.offersCol,
      (snap) => {
        const offers = {};
        snap.docs.forEach((d) => { offers[d.id] = d.data(); });
        this.onOffers?.(offers);
      },
      (err) => {
        console.warn('[Firebase] Angebote nicht lesbar:', err.code || err);
        this.offersFailed = true;
      }
    );

    // Gemeinsame Sammlungen (Gedächtnis, Kochbuch)
    Object.keys(this.mapHandlers || {}).forEach((name) => this.subscribeMap(name));
  }

  /** Echtzeit-Abo einer Sammlung lists/{LIST_ID}/{name}. Fehlt die Regel → Gerät. */
  subscribeMap(name) {
    const { fs } = this;
    this.mapFailed = this.mapFailed || {};
    this.mapLocal = this.mapLocal || {};
    this.mapUnsub = this.mapUnsub || {};
    if (this.mapLocal[name]) return;
    this.mapFailed[name] = false;
    this.mapUnsub[name]?.();
    this.mapUnsub[name] = fs.onSnapshot(
      fs.collection(this.db, 'lists', LIST_ID, name),
      (snap) => {
        const map = {};
        snap.docs.forEach((d) => { map[d.id] = d.data(); });
        this.mapHandlers[name]?.(map, { fromServer: !snap.metadata.fromCache });
      },
      (err) => {
        console.warn(`[Firebase] ${name} nicht lesbar:`, err.code || err);
        this.mapFailed[name] = true;
        if (err.code === 'permission-denied') this.useLocalMap(name);
      }
    );
  }

  useLocalMap(name) {
    this.mapLocal = this.mapLocal || {};
    if (this.mapLocal[name]) return;
    this.mapUnsub?.[name]?.();
    this.mapLocal[name] = new LocalMapStore(name);
    this.mapLocal[name].start((map, meta) => this.mapHandlers[name]?.(map, meta));
  }

  startMap(name, onChange) {
    this.mapHandlers = this.mapHandlers || {};
    this.mapHandlers[name] = onChange;
  }

  async setMap(name, changes) {
    if (this.mapLocal?.[name]) {
      this.mapLocal[name].set(changes);
      return;
    }
    await this.ready;
    const col = this.fs.collection(this.db, 'lists', LIST_ID, name);
    const batch = this.fs.writeBatch(this.db);
    for (const [id, entry] of Object.entries(changes)) {
      const ref = this.fs.doc(col, id);
      if (entry) batch.set(ref, entry);
      else batch.delete(ref);
    }
    batch.commit().catch((err) => {
      console.error(`[Firebase] ${name} speichern fehlgeschlagen:`, err);
      if (err.code === 'permission-denied') {
        this.useLocalMap(name);
        this.mapLocal[name].set(changes);
      } else {
        showToast('Konnte ich gerade nicht speichern – bitte nochmal versuchen.');
      }
    });
  }

  startWissen(onWissen) { this.startMap('wissen', onWissen); }
  setWissen(changes) { return this.setMap('wissen', changes); }

  startOffers(onOffers) {
    this.onOffers = onOffers;
  }

  async setOffers(changes) {
    await this.ready;
    const batch = this.fs.writeBatch(this.db);
    for (const [key, offer] of Object.entries(changes)) {
      const ref = this.fs.doc(this.offersCol, key);
      if (offer) batch.set(ref, offer);
      else batch.delete(ref);
    }
    batch.commit().catch((err) => {
      console.error('[Firebase] Angebote speichern fehlgeschlagen:', err);
      showToast(err.code === 'permission-denied'
        ? 'Angebote: Firestore-Regeln noch nicht aktualisiert (siehe README).'
        : 'Angebote konnten nicht gespeichert werden.');
    });
  }

  ref(id) {
    return this.fs.doc(this.col, id);
  }

  /** Schreibvorgänge nicht blockierend ausführen (funktioniert auch offline). */
  run(promise) {
    promise.catch((err) => {
      console.error('[Firebase] Schreibfehler:', err);
      showToast('Speichern fehlgeschlagen – bitte Verbindung prüfen.');
    });
  }

  async add(items) {
    await this.ready;
    const batch = this.fs.writeBatch(this.db);
    items.forEach(({ id, ...data }) => batch.set(this.ref(id), data));
    this.run(batch.commit());
  }

  async update(id, patch) {
    await this.ready;
    this.run(this.fs.updateDoc(this.ref(id), patch));
  }

  async remove(ids) {
    await this.ready;
    const batch = this.fs.writeBatch(this.db);
    ids.forEach((id) => batch.delete(this.ref(id)));
    this.run(batch.commit());
  }

  async restore(items) {
    return this.add(items);
  }
}

/* ================================================================
 * 3. Zustand, Favoriten & gelernte Kategorien
 * ================================================================ */

const state = {
  items: [],
  filter: ['all', 'marktkauf', 'aldi'].includes(readJSON(LS.filter, 'all')) ? readJSON(LS.filter, 'all') : 'all',
  addStore: 'both',
  doneOpen: readJSON(LS.doneOpen, false),
  editing: null,       // Artikel im Bearbeiten-Dialog
  editStore: 'both',
  editCategory: DEFAULT_CATEGORY,
  checking: new Set(), // IDs, die gerade abgehakt werden (Animation)
  fresh: new Set(),    // gerade hinzugefügte IDs (Animation)
  flash: new Set(),    // Duplikate hervorheben
  offers: readJSON(LS.offersCache, {}), // { key: { name, store, price, until } }
  offerDraft: {},      // Bearbeitungsstand im Angebots-Dialog
  prospekte: null,     // data/prospekte.json (automatisch abgerufen)
  rezepte: null,       // data/rezepte.json (KI-Rezepte der Woche)
  openRecipes: new Set(),
  kochbuch: [],
  kochbuchLocal: false,
  portions: {},
  rezepteTab: null,
  kbFilter: 'alle',
  kbSearch: '',
  view: 'liste',
  wissen: readJSON(`einkauf:wissen-cache:${LIST_ID}`, null) || START_WISSEN,
  wissenLocal: false
};

const backend = isFirebaseConfigured() ? new FirebaseBackend() : new LocalBackend();

function getLearned() {
  return readJSON(LS.learned, {});
}

function learnCategory(name, categoryId) {
  const learned = getLearned();
  learned[normalize(name)] = categoryId;
  writeJSON(LS.learned, learned);
}

/** Kategorie: gelernte Zuordnung → bestehender Artikel gleichen Namens → Wörterbuch */
function categoryFor(name) {
  const key = normalize(name);
  const learned = getLearned();
  if (learned[key] && CATEGORY_BY_ID[learned[key]]) return learned[key];
  const existing = state.items.find((i) => normalize(i.name) === key);
  if (existing && existing.category !== DEFAULT_CATEGORY) return existing.category;
  return categorize(name, learned);
}

function bumpFrequency(names) {
  const freq = readJSON(LS.freq, {});
  const now = Date.now();
  for (const name of names) {
    const key = normalize(name);
    const entry = freq[key] || { name, count: 0, last: 0 };
    entry.name = name;
    entry.count += 1;
    entry.last = now;
    freq[key] = entry;
  }
  writeJSON(LS.freq, freq);
}

/** Aktives (nicht abgelaufenes) Angebot für einen Artikelnamen. */
function activeOffer(name) {
  const offer = state.offers[normalize(name)];
  if (!offer || !offer.store || (offer.until && offer.until < Date.now())) return null;
  return offer;
}

function offerLabel(offer) {
  const startsLater = offer.validFrom && offer.validFrom > todayIso();
  const later = startsLater ? ` ab ${weekdayShort(offer.validFrom)}` : '';
  return `${STORE_LABELS[offer.store]}${offer.price ? ` ${offer.price}` : ''}${later}`;
}

/** Heutiges Datum als YYYY-MM-DD (lokale Zeit). */
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function weekdayShort(iso) {
  return parseIso(iso).toLocaleDateString('de-DE', { weekday: 'short' });
}

function formatRange(from, to) {
  if (!from) return '';
  const f = parseIso(from).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  if (!to) return `ab ${f}`;
  const t = parseIso(to).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  return `${f} – ${t}`;
}

/* ---------- Automatische Angebote (Aldi-Daten aus data/prospekte.json) ---------- */

const autoOfferCache = new Map();

/** Aktuell gültige Angebote eines Ladens (inkl. solcher, die diese Woche noch starten). */
function storeOffers(store) {
  const offers = state.prospekte?.[store]?.offers?.offers || [];
  const today = todayIso();
  return offers.filter((o) => !o.validTo || o.validTo >= today);
}

function priceValue(price) {
  const n = parseFloat(String(price || '').replace(/[^\d,]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : Infinity;
}

/**
 * Passendes Angebot (Aldi oder Marktkauf) für einen Artikelnamen.
 * Bester Treffer gewinnt; bei gleich gutem Treffer der günstigere Preis.
 */
function autoOffer(name) {
  const key = normalize(name);
  if (autoOfferCache.has(key)) return autoOfferCache.get(key);
  let best = null;
  let bestScore = 0;
  let bestStore = null;
  // Auch den ursprünglichen Namen prüfen, wenn das Gedächtnis ersetzt hat ("Skyr Natur" ← "Skyr")
  const names = [name, ...(state.wissen || [])
    .filter((w) => w.wenn && w.dann && normalize(w.dann) === key)
    .map((w) => w.wenn)];
  for (const store of ['aldi', 'marktkauf']) {
    for (const o of storeOffers(store)) {
      const score = Math.max(...names.map((n) => offerMatchScore(n, o.name)));
      if (!score) continue;
      if (score > bestScore || (score === bestScore && priceValue(o.price) < priceValue(best.price))) {
        best = o;
        bestScore = score;
        bestStore = store;
      }
    }
  }
  const result = best ? {
    auto: true,
    store: bestStore,
    price: best.price,
    name: best.name,
    product: [best.brand, best.name].filter(Boolean).join(' '),
    unit: best.unit,
    validFrom: best.validFrom,
    validTo: best.validTo,
    image: best.image,
    id: best.id
  } : null;
  autoOfferCache.set(key, result);
  return result;
}

/** Angebot für einen Artikel: selbst markiert (Familie) hat Vorrang vor automatisch. */
function getOffer(name) {
  return activeOffer(name) || autoOffer(name);
}

/** Ende der Angebotswoche: kommender Samstag 23:59 (Sonntag → nächster Samstag). */
function offerWeekEnd(from = new Date()) {
  const d = new Date(from);
  const daysToSaturday = (6 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysToSaturday);
  d.setHours(23, 59, 59, 0);
  return d.getTime();
}

/**
 * Favoriten in dieser Reihenfolge:
 *   1. Favoriten mit aktuellem Angebot
 *   2. Mamas feste Favoriten (config.js, ⭐)
 *   3. Häufig gekaufte Artikel
 *   4. Startvorschläge
 * Artikel, die schon offen auf der Liste stehen, werden ausgeblendet.
 */
function getFavorites() {
  const freq = readJSON(LS.freq, {});
  const openNames = new Set(state.items.filter((i) => !i.done).map((i) => normalize(i.name)));
  const seen = new Set();
  const list = [];
  const push = (rawName, pinned) => {
    const name = applyWissen(rawName);
    const key = normalize(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push({ key, name: freq[key]?.name || name, pinned, offer: getOffer(name) });
  };

  MAMA_FAVORITES.forEach((name) => push(name, true));
  Object.values(freq)
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .forEach((f) => push(f.name, false));
  STARTER_FAVORITES.forEach((name) => push(name, false));

  const visible = list.filter((f) => !openNames.has(f.key));
  // Angebote nach vorne, sonst Reihenfolge beibehalten (stabile Sortierung)
  visible.sort((a, b) => Number(Boolean(b.offer)) - Number(Boolean(a.offer)));
  const pinnedCount = visible.filter((f) => f.pinned || f.offer).length;
  return visible.slice(0, Math.max(FAVORITES_LIMIT, pinnedCount));
}

/** Kandidaten für den Angebots-Dialog: Favoriten, offene Artikel, bestehende Angebote. */
function getOfferCandidates() {
  const seen = new Set();
  const list = [];
  const push = (name, pinned = false) => {
    const key = normalize(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push({ key, name, pinned });
  };
  MAMA_FAVORITES.forEach((n) => push(n, true));
  Object.values(state.offers).forEach((o) => { if (activeOffer(o.name)) push(o.name); });
  state.items.filter((i) => !i.done).sort((a, b) => a.createdAt - b.createdAt).forEach((i) => push(i.name));
  Object.values(readJSON(LS.freq, {}))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .forEach((f) => push(f.name));
  return list;
}

/* ================================================================
 * 4. Rendering
 * ================================================================ */

const els = {
  form: $('#addForm'),
  input: $('#itemInput'),
  storePicker: $('#storePicker'),
  favoritesWrap: $('#favoritesWrap'),
  favorites: $('#favorites'),
  tabs: $('#filterTabs'),
  list: $('#list'),
  empty: $('#emptyState'),
  doneSection: $('#doneSection'),
  doneToggle: $('#doneToggle'),
  doneList: $('#doneList'),
  doneCount: $('#doneCount'),
  clearDone: $('#clearDoneBtn'),
  share: $('#shareBtn'),
  sync: $('#syncStatus'),
  modeInfo: $('#modeInfo'),
  wake: $('#wakeToggle'),
  dialog: $('#editDialog'),
  editForm: $('#editForm'),
  editName: $('#editName'),
  editQty: $('#editQty'),
  editStore: $('#editStore'),
  editCategory: $('#editCategory'),
  editDelete: $('#editDelete'),
  editCancel: $('#editCancel'),
  toast: $('#toast'),
  toastText: $('#toastText'),
  toastAction: $('#toastAction'),
  offerBtn: $('#offerManageBtn'),
  offerDialog: $('#offerDialog'),
  offerForm: $('#offerForm'),
  offerRows: $('#offerRows'),
  offerUntil: $('#offerUntil'),
  offerNewName: $('#offerNewName'),
  offerNewAdd: $('#offerNewAdd'),
  offerCancel: $('#offerCancel'),
  addBtn: $('#addBtn'),
  mic: $('#micBtn'),
  suggest: $('#suggestions'),
  greeting: $('#greeting'),
  deals: $('#deals'),
  dealsWrap: $('#dealsWrap'),
  viewer: $('#prospektDialog'),
  viewerTitle: $('#viewerTitle'),
  viewerClose: $('#viewerClose'),
  viewerWeeks: $('#viewerWeeks'),
  viewerTabs: $('#viewerTabs'),
  viewerBody: $('#viewerBody'),
  hello: $('#hello'),
  nav: $('#bottomNav'),
  navBadgeListe: $('#navBadgeListe'),
  navBadgeAngebote: $('#navBadgeAngebote'),
  recipes: $('#recipes'),
  recipesSub: $('#recipesSub'),
  chatLog: $('#chatLog'),
  chatIdeas: $('#chatIdeas'),
  chatSetup: $('#chatSetup'),
  chatForm: $('#chatForm'),
  chatInput: $('#chatInput'),
  chatMic: $('#chatMic'),
  chatSend: $('#chatSend')
};

function itemHtml(item) {
  const classes = ['item'];
  if (state.checking.has(item.id)) classes.push('is-checking');
  if (state.fresh.has(item.id)) classes.push('is-new');
  if (state.flash.has(item.id)) classes.push('is-flash');

  const badges = [];
  if (item.store === 'marktkauf') badges.push('<span class="badge badge--marktkauf">Marktkauf</span>');
  if (item.store === 'aldi') badges.push('<span class="badge badge--aldi">Aldi</span>');
  const offer = item.done ? null : getOffer(item.name);
  if (offer) {
    const title = offer.product ? ` title="${escapeHtml(`${offer.product}${offer.unit ? `, ${offer.unit}` : ''}`)}"` : '';
    badges.push(`<span class="badge badge--offer badge--offer-${offer.store}"${title}>🏷️ Angebot ${escapeHtml(offerLabel(offer))}</span>`);
  } else if (item.isOffer) {
    badges.push(`<span class="badge badge--offer">🏷️ Angebot${item.offerPrice ? ` ${escapeHtml(item.offerPrice)}` : ''}</span>`);
  }
  if (item.done) {
    const cat = CATEGORY_BY_ID[item.category];
    badges.push(`<span class="badge" style="background:#F1F5F9;color:#64748B">${cat.icon} ${escapeHtml(cat.name)}</span>`);
  }

  const qty = item.qty ? `<span class="item__qty">${escapeHtml(item.qty)}</span>` : '';
  const label = `${item.qty ? `${item.qty} ` : ''}${item.name}`;
  const actionLabel = item.done ? `${label} wieder auf die Liste setzen` : `${label} abhaken`;

  return `
    <div class="${classes.join(' ')}" data-id="${escapeHtml(item.id)}">
      <button type="button" class="item__main" data-action="toggle" aria-label="${escapeHtml(actionLabel)}">
        <span class="check" aria-hidden="true"></span>
        <span class="item__text">
          <span class="item__name">${qty}${escapeHtml(item.name)}</span>
          ${badges.length ? `<span class="item__meta">${badges.join('')}</span>` : ''}
        </span>
      </button>
      <button type="button" class="item__edit" data-action="edit" aria-label="${escapeHtml(item.name)} bearbeiten">✏️</button>
    </div>`;
}

function render() {
  const open = state.items.filter((i) => !i.done);
  const done = state.items.filter((i) => i.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const visible = open.filter((i) => matchesFilter(i, state.filter));

  // Zähler in den Tabs
  const counts = {
    all: open.length,
    marktkauf: open.filter((i) => matchesFilter(i, 'marktkauf')).length,
    aldi: open.filter((i) => matchesFilter(i, 'aldi')).length
  };
  $$('[data-count]', els.tabs).forEach((el) => { el.textContent = counts[el.dataset.count]; });
  $$('.tab', els.tabs).forEach((tab) => {
    const active = tab.dataset.filter === state.filter;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  // Offene Artikel nach Kategorie (Laufweg-Reihenfolge)
  const groups = CATEGORIES
    .map((cat) => ({
      cat,
      items: visible.filter((i) => i.category === cat.id).sort((a, b) => a.createdAt - b.createdAt)
    }))
    .filter((g) => g.items.length);

  els.list.innerHTML = groups.map(({ cat, items }) => `
    <section class="group" data-cat="${cat.id}" aria-label="${escapeHtml(cat.name)}">
      <h3 class="group__title">
        <span aria-hidden="true">${cat.icon}</span> ${escapeHtml(cat.name)}
        <span class="group__count">${items.length}</span>
      </h3>
      <div class="group__items">${items.map(itemHtml).join('')}</div>
    </section>`).join('');

  // Leerer Zustand
  els.empty.hidden = visible.length > 0;
  if (!visible.length) {
    const title = $('.empty__title', els.empty);
    const text = $('.empty__text', els.empty);
    if (open.length && state.filter !== 'all') {
      title.textContent = `Für ${STORE_LABELS[state.filter]} ist nichts offen`;
      text.textContent = 'Unter „Alle“ stehen noch Artikel für den anderen Laden.';
    } else if (done.length) {
      title.textContent = 'Alles erledigt! 🎉';
      text.textContent = 'Alle Artikel sind im Einkaufswagen.';
    } else {
      title.textContent = 'Die Liste ist leer';
      text.textContent = 'Oben einfach eintippen oder einsprechen, was gebraucht wird.';
    }
  }

  // Erledigt-Bereich
  els.doneSection.hidden = done.length === 0;
  els.doneCount.textContent = done.length;
  els.doneToggle.setAttribute('aria-expanded', String(state.doneOpen));
  els.doneList.hidden = !state.doneOpen;
  els.clearDone.hidden = !state.doneOpen;
  els.doneList.innerHTML = state.doneOpen ? done.map(itemHtml).join('') : '';

  renderFavorites();
  renderWeeklyCheck();
  renderProspektCards();
  renderDeals();
  updateGreeting();
  updateNavBadges(open.length);
  updateDocumentTitle(open.length);
}

function renderFavorites() {
  const favs = getFavorites();
  els.favoritesWrap.hidden = favs.length === 0;
  els.favorites.innerHTML = favs.map((f) => {
    const classes = ['chip', 'chip--fav'];
    if (f.pinned) classes.push('chip--pinned');
    if (f.offer) classes.push('chip--offer', `chip--offer-${f.offer.store}`);
    const label = `${f.name} hinzufügen${f.offer ? `, im Angebot bei ${offerLabel(f.offer)}` : ''}`;
    return `
    <button type="button" class="${classes.join(' ')}" data-fav="${escapeHtml(f.name)}"
            aria-label="${escapeHtml(label)}">
      ${f.pinned ? '<span class="chip__star" aria-hidden="true">⭐</span>' : ''}
      <span>${escapeHtml(f.name)}</span>
      ${f.offer ? `<span class="chip__offer" aria-hidden="true">🏷️ ${escapeHtml(offerLabel(f.offer))}</span>` : ''}
    </button>`;
  }).join('');
}

function updateDocumentTitle(openCount) {
  document.title = openCount ? `Einkaufsliste (${openCount})` : 'Einkaufsliste';
}

function setStatus(status, message) {
  const texts = {
    connecting: 'Verbinde …',
    live: 'Live · synchron mit der Familie',
    offline: 'Offline · wird später abgeglichen',
    demo: 'Demo-Modus · nur auf diesem Gerät',
    error: 'Verbindungsproblem'
  };
  els.sync.className = `sync is-${status}`;
  $('.sync__text', els.sync).textContent = message || texts[status] || '';
}

function setPickerActive(container, store) {
  $$('.chip', container).forEach((chip) => {
    const active = chip.dataset.store === store;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-checked', String(active));
  });
}

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(text, action) {
  clearTimeout(toastTimer);
  els.toastText.textContent = text;
  els.toastAction.hidden = !action;
  els.toastAction.onclick = action
    ? () => { hideToast(); action.onClick(); }
    : null;
  if (action) els.toastAction.textContent = action.label || 'Rückgängig';
  els.toast.hidden = false;
  // Animation neu starten
  els.toast.style.animation = 'none';
  void els.toast.offsetWidth;
  els.toast.style.animation = '';
  toastTimer = setTimeout(hideToast, action ? 6000 : 3000);
}

function hideToast() {
  els.toast.hidden = true;
}

/* ================================================================
 * 5. Aktionen
 * ================================================================ */

function handleItems(rawItems) {
  state.items = rawItems.map(sanitizeItem).filter((i) => i.id && i.name);
  writeJSON(LS.cache, state.items);
  vocabulary = null;
  render();
}

function handleOffers(offers) {
  state.offers = offers || {};
  writeJSON(LS.offersCache, state.offers);
  render();
  // Abgelaufene Angebote aufräumen
  const now = Date.now();
  const expired = Object.entries(state.offers).filter(([, o]) => o.until && o.until < now);
  if (expired.length) backend.setOffers(Object.fromEntries(expired.map(([k]) => [k, null])));
}

function addFromText(text, store = state.addStore) {
  return addParsed(parseItems(text), store);
}

/** Fügt bereits zerlegte Artikel [{ name, qty }] hinzu. */
function addParsed(parsed, store = state.addStore) {
  if (!parsed.length) return false;
  // Familien-Gedächtnis: z. B. "Milch" → "Milch 1,5 %"
  parsed = parsed.map((p) => ({ ...p, name: applyWissen(p.name) }));

  const openByName = new Map(state.items.filter((i) => !i.done).map((i) => [normalize(i.name), i]));
  const toAdd = [];
  const duplicates = [];
  const now = Date.now();

  parsed.forEach((p, index) => {
    const existing = openByName.get(normalize(p.name));
    if (existing) {
      duplicates.push(existing);
      if (p.qty && p.qty !== existing.qty) backend.update(existing.id, { qty: p.qty });
      return;
    }
    toAdd.push({
      id: makeId(),
      name: p.name,
      qty: p.qty,
      store,
      category: categoryFor(p.name),
      done: false,
      doneAt: null,
      createdAt: now + index, // Reihenfolge der Eingabe beibehalten
      isOffer: false,
      offerPrice: ''
    });
  });

  if (toAdd.length) {
    toAdd.forEach((i) => state.fresh.add(i.id));
    setTimeout(() => toAdd.forEach((i) => state.fresh.delete(i.id)), 800);
    backend.add(toAdd);
    bumpFrequency(toAdd.map((i) => i.name));
    vibrate(15);
  }

  if (duplicates.length) {
    duplicates.forEach((i) => state.flash.add(i.id));
    setTimeout(() => { duplicates.forEach((i) => state.flash.delete(i.id)); }, 1300);
    render();
  }

  // Rückmeldung
  const storeHint = store !== 'both' ? ` (${STORE_LABELS[store]})` : '';
  const hiddenByFilter = toAdd.some((i) => !matchesFilter(i, state.filter));
  let message;
  if (toAdd.length === 1) message = `„${toAdd[0].name}“ hinzugefügt${storeHint}`;
  else if (toAdd.length > 1) message = `${toAdd.length} Artikel hinzugefügt${storeHint}`;
  if (duplicates.length) {
    const dupText = duplicates.length === 1
      ? `„${duplicates[0].name}“ steht schon auf der Liste`
      : `${duplicates.length} Artikel stehen schon auf der Liste`;
    message = message ? `${message} · ${dupText}` : dupText;
  }
  if (hiddenByFilter) message += ' – sichtbar unter „Alle“';
  const offerHits = toAdd.map((i) => [i, getOffer(i.name)]).filter(([, o]) => o);
  if (offerHits.length === 1) {
    const [i, o] = offerHits[0];
    message += ` · 🏷️ ${i.name} ist im Angebot bei ${offerLabel(o)}`;
  } else if (offerHits.length > 1) {
    message += ` · 🏷️ ${offerHits.length} davon im Angebot`;
  }
  if (message) {
    const addedIds = toAdd.map((i) => i.id);
    showToast(message, addedIds.length ? {
      label: 'Rückgängig',
      onClick: () => backend.remove(addedIds)
    } : undefined);
  }
  return true;
}

function toggleItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item || state.checking.has(id)) return;

  if (item.done) {
    backend.update(id, { done: false, doneAt: null });
    vibrate(10);
    return;
  }

  state.checking.add(id);
  const el = els.list.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  el?.classList.add('is-checking');
  vibrate(20);
  setTimeout(() => {
    state.checking.delete(id);
    backend.update(id, { done: true, doneAt: Date.now() });
  }, CHECK_ANIMATION_MS);
}

function clearDone() {
  const done = state.items.filter((i) => i.done);
  if (!done.length) return;
  backend.remove(done.map((i) => i.id));
  vibrate(25);
  showToast(`${done.length} abgehakte Artikel gelöscht`, {
    label: 'Rückgängig',
    onClick: () => backend.restore(done)
  });
}

/* ---------- Bearbeiten-Dialog ---------- */

function buildCategoryGrid() {
  els.editCategory.innerHTML = CATEGORIES.map((c) => `
    <button type="button" class="cat-option" role="radio" aria-checked="false" data-cat="${c.id}">
      <span aria-hidden="true">${c.icon}</span><span>${escapeHtml(c.name)}</span>
    </button>`).join('');
}

function setEditCategory(catId) {
  state.editCategory = catId;
  $$('.cat-option', els.editCategory).forEach((btn) => {
    const active = btn.dataset.cat === catId;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

function openEdit(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  state.editing = { ...item };
  els.editName.value = item.name;
  els.editQty.value = item.qty;
  state.editStore = item.store;
  setPickerActive(els.editStore, item.store);
  setEditCategory(item.category);
  if (typeof els.dialog.showModal === 'function') els.dialog.showModal();
  else els.dialog.setAttribute('open', '');
}

function closeEdit() {
  state.editing = null;
  if (els.dialog.open) els.dialog.close();
}

function saveEdit() {
  const original = state.editing;
  if (!original) return;
  const name = els.editName.value.trim().replace(/\s+/g, ' ');
  const patch = {};
  if (name && name !== original.name) patch.name = name.charAt(0).toUpperCase() + name.slice(1);
  const qty = els.editQty.value.trim();
  if (qty !== original.qty) patch.qty = qty;
  if (state.editStore !== original.store) patch.store = state.editStore;
  if (state.editCategory !== original.category) {
    patch.category = state.editCategory;
    learnCategory(patch.name || original.name, state.editCategory);
  }
  if (Object.keys(patch).length) {
    backend.update(original.id, patch);
    showToast('Gespeichert ✓');
  }
  closeEdit();
}

function deleteFromEdit() {
  const item = state.items.find((i) => i.id === state.editing?.id);
  closeEdit();
  if (!item) return;
  backend.remove([item.id]);
  showToast(`„${item.name}“ gelöscht`, {
    label: 'Rückgängig',
    onClick: () => backend.restore([item])
  });
}

/* ---------- Angebote markieren ---------- */

function formatPrice(raw) {
  const p = String(raw || '').trim().slice(0, 20);
  if (/^\d+([.,]\d{1,2})?$/.test(p)) {
    const [euro, cent = ''] = p.replace('.', ',').split(',');
    return `${euro},${cent.padEnd(2, '0')} €`;
  }
  return p;
}

function offerRowHtml(row) {
  const draft = state.offerDraft[row.key] || { store: '', price: '' };
  const seg = [['', 'Kein'], ['marktkauf', 'Marktkauf'], ['aldi', 'Aldi']].map(([store, label]) => `
      <button type="button" class="chip chip--${store || 'none'}${draft.store === store ? ' is-active' : ''}"
              role="radio" aria-checked="${draft.store === store}" data-offer-store="${store}">${label}</button>`).join('');
  return `
    <div class="offer-row${draft.store ? ' is-on' : ''}" data-key="${escapeHtml(row.key)}" data-name="${escapeHtml(row.name)}">
      <div class="offer-row__name">${row.pinned ? '⭐ ' : ''}${escapeHtml(row.name)}</div>
      <div class="chips chips--offer" role="radiogroup" aria-label="Angebot für ${escapeHtml(row.name)}">${seg}</div>
      <input type="text" class="offer-row__price" inputmode="decimal" maxlength="20"
             placeholder="Preis, z. B. 0,99 (optional)" value="${escapeHtml(draft.price)}"
             aria-label="Angebotspreis für ${escapeHtml(row.name)}" ${draft.store ? '' : 'hidden'}>
    </div>`;
}

function renderOfferRows() {
  const rows = state.offerRows || [];
  els.offerRows.innerHTML = rows.map(offerRowHtml).join('');
}

function openOffers() {
  state.offerDraft = {};
  for (const [key, offer] of Object.entries(state.offers)) {
    if (activeOffer(offer.name)) state.offerDraft[key] = { store: offer.store, price: offer.price || '' };
  }
  state.offerRows = getOfferCandidates();
  const until = new Date(offerWeekEnd());
  els.offerUntil.textContent = until.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
  els.offerNewName.value = '';
  renderOfferRows();
  if (typeof els.offerDialog.showModal === 'function') els.offerDialog.showModal();
  else els.offerDialog.setAttribute('open', '');
}

function closeOffers() {
  if (els.offerDialog.open) els.offerDialog.close();
}

function addOfferRow() {
  const parsed = parseItems(els.offerNewName.value)[0];
  if (!parsed) return;
  const key = normalize(parsed.name);
  if (!state.offerRows.some((r) => r.key === key)) {
    state.offerRows.unshift({ key, name: parsed.name, pinned: false });
  }
  state.offerDraft[key] = state.offerDraft[key] || { store: '', price: '' };
  els.offerNewName.value = '';
  renderOfferRows();
  els.offerRows.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function saveOffers() {
  const until = offerWeekEnd();
  const changes = {};
  let count = 0;
  for (const row of state.offerRows || []) {
    const draft = state.offerDraft[row.key] || { store: '', price: '' };
    const current = activeOffer(row.name);
    const price = formatPrice(draft.price);
    if (!draft.store) {
      if (state.offers[row.key]) changes[row.key] = null;
      continue;
    }
    count += 1;
    if (current && current.store === draft.store && (current.price || '') === price) continue;
    changes[row.key] = { name: row.name, store: draft.store, price, until, updatedAt: Date.now() };
  }
  closeOffers();
  if (!Object.keys(changes).length) return;
  backend.setOffers(changes);
  vibrate(15);
  showToast(count ? `🏷️ ${count} Angebot${count === 1 ? '' : 'e'} markiert – gilt bis Samstag` : 'Angebote entfernt');
}

/* ---------- Prospekte & Angebote ---------- */

async function loadProspekte() {
  try {
    const res = await fetch('./data/prospekte.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.prospekte = await res.json();
  } catch (err) {
    console.warn('[Prospekte] nicht geladen:', err);
    state.prospekte = null;
  }
  autoOfferCache.clear();
  render();
}

function flyerFor(store, week = 'current') {
  return state.prospekte?.[store]?.[week] || null;
}

function renderProspektCards() {
  for (const store of ['marktkauf', 'aldi']) {
    const suffix = store === 'aldi' ? 'Aldi' : 'Marktkauf';
    const img = $(`#cover${suffix}`);
    const label = $(`#valid${suffix}`);
    const current = flyerFor(store, 'current');
    const next = flyerFor(store, 'next');
    const today = todayIso();
    const currentValid = current && (!current.validTo || current.validTo >= today);

    if (currentValid && current.cover && !img.dataset.failed) {
      if (img.getAttribute('src') !== current.cover) {
        img.onerror = () => { img.hidden = true; img.dataset.failed = '1'; };
        img.src = current.cover;
      }
      img.hidden = false;
    } else {
      img.hidden = true;
    }

    let text = 'Prospekt ansehen';
    if (currentValid && current.validTo) text = `gültig bis ${parseIso(current.validTo).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}`;
    if (next?.validFrom && (next.viewerUrl || next.pages?.length)) text += ` · ✨ Vorschau ab ${weekdayShort(next.validFrom)}`;
    label.textContent = text;
  }
}

/** Angebote, die zu Mamas Favoriten, der Liste oder oft Gekauftem passen. */
function getDeals() {
  const freq = readJSON(LS.freq, {});
  const openNames = new Set(state.items.filter((i) => !i.done).map((i) => normalize(i.name)));
  const names = [
    ...MAMA_FAVORITES,
    ...state.items.filter((i) => !i.done).map((i) => i.name),
    ...Object.values(freq).sort((a, b) => b.count - a.count).slice(0, 15).map((f) => f.name)
  ];
  const seen = new Set();
  const deals = [];
  for (const name of names) {
    const key = normalize(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const offer = getOffer(name);
    if (offer) deals.push({ name, offer, onList: openNames.has(key), pinned: MAMA_FAVORITES.some((f) => normalize(f) === key) });
  }
  return deals.slice(0, 10);
}

function renderDeals() {
  const deals = getDeals();
  els.dealsWrap.hidden = deals.length === 0;
  els.deals.innerHTML = deals.map((d) => `
    <button type="button" class="deal deal--${d.offer.store}${d.onList ? ' is-on-list' : ''}" data-deal="${escapeHtml(d.name)}"
            data-deal-store="${d.offer.store}"
            aria-label="${escapeHtml(`${d.name}: ${d.offer.product || ''} im Angebot bei ${offerLabel(d.offer)}${d.onList ? ', steht schon auf der Liste' : ', antippen zum Hinzufügen'}`)}">
      ${d.offer.image ? `<img src="${escapeHtml(d.offer.image)}" alt="" loading="lazy">` : '<span class="deal__icon" aria-hidden="true">🏷️</span>'}
      <span class="deal__text">
        <strong>${d.pinned ? '⭐ ' : ''}${escapeHtml(d.name)}</strong>
        <small>${escapeHtml(offerLabel(d.offer))}</small>
      </span>
      <span class="deal__add" aria-hidden="true">${d.onList ? '✓' : '＋'}</span>
    </button>`).join('');
}

/* ---------- Prospekt-Ansicht (Vollbild) ---------- */

const viewer = { store: 'aldi', week: 'current', tab: 'angebote', query: '' };

function openProspekt(store, tab) {
  viewer.store = store;
  viewer.week = 'current';
  viewer.tab = tab || (storeOffers(store).length ? 'angebote' : 'prospekt');
  viewer.query = '';
  renderViewer();
  if (typeof els.viewer.showModal === 'function') els.viewer.showModal();
  else els.viewer.setAttribute('open', '');
  els.viewerBody.scrollTop = 0;
}

function closeViewer() {
  if (els.viewer.open) els.viewer.close();
}

function renderViewer() {
  const { store } = viewer;
  const current = flyerFor(store, 'current');
  const next = flyerFor(store, 'next');
  if (viewer.week === 'next' && !next) viewer.week = 'current';
  const hasOffers = storeOffers(store).length > 0;
  if (viewer.tab === 'angebote' && (!hasOffers || viewer.week === 'next')) viewer.tab = 'prospekt';

  els.viewer.className = `viewer viewer--${store}`;
  els.viewerTitle.textContent = store === 'aldi' ? 'Aldi Nord' : 'Marktkauf Nientied';

  // Wochen-Umschalter
  const weekBtn = (week, label, flyer) => `
    <button type="button" role="tab" data-week="${week}" aria-selected="${viewer.week === week}"
            class="${viewer.week === week ? 'is-active' : ''}">
      ${label}${flyer?.validFrom ? `<small>${escapeHtml(formatRange(flyer.validFrom, flyer.validTo))}</small>` : ''}
    </button>`;
  els.viewerWeeks.innerHTML = weekBtn('current', 'Diese Woche', current) + (next ? weekBtn('next', 'Nächste Woche', next) : '');
  els.viewerWeeks.hidden = !next;

  // Ansicht-Umschalter (nur Aldi, diese Woche)
  els.viewerTabs.hidden = !(hasOffers && viewer.week === 'current');
  $$('[data-tab]', els.viewerTabs).forEach((btn) => {
    const active = btn.dataset.tab === viewer.tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
    if (btn.dataset.tab === 'angebote') btn.innerHTML = `🛒 Angebote <small>${storeOffers(store).length}</small>`;
  });

  if (viewer.tab === 'angebote') renderOfferBrowser();
  else renderFlyer(viewer.week === 'next' ? next : current);
}

function renderFlyer(flyer) {
  const isMk = viewer.store === 'marktkauf';
  // Marktkauf: offizielle EDEKA-Prospektseite des Markts (zuverlässiger als der Blätterkatalog-Anbieter)
  const pageUrl = isMk ? OFFER_LINKS.marktkauf : (state.prospekte?.aldi?.pageUrl || OFFER_LINKS.aldi);
  const fallback = `
    <a class="btn btn--primary btn--block" href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">
      📰 Prospekt bei ${isMk ? 'EDEKA/Marktkauf' : 'Aldi'} ansehen ↗
    </a>`;

  if (!flyer) {
    els.viewerBody.innerHTML = `<div class="viewer__empty"><p>Gerade ist kein Prospekt hinterlegt.</p>${fallback}</div>`;
    return;
  }
  if (!flyer.viewerUrl && !flyer.pages?.length) {
    els.viewerBody.innerHTML = `
      <div class="viewer__empty">
        <p class="viewer__soon">📅 Der Prospekt für <strong>${escapeHtml(formatRange(flyer.validFrom, flyer.validTo))}</strong>
        erscheint meistens ab Donnerstag.</p>
        <p>Die App holt ihn automatisch, sobald er online ist.</p>
        ${fallback}
      </div>`;
    return;
  }

  const actions = [];
  if (isMk && !flyer.pages?.length) {
    actions.push(`<a class="btn btn--primary btn--block" href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">📰 Prospekt durchblättern ↗</a>`);
  } else if (flyer.viewerUrl && !flyer.pages?.length) {
    actions.push(`<a class="btn btn--primary btn--block" href="${escapeHtml(flyer.viewerUrl)}" target="_blank" rel="noopener noreferrer">📰 Prospekt durchblättern ↗</a>`);
  }

  let content = '';
  if (flyer.pages?.length) {
    // Produkte je Seite (aus der KI-Auswertung) – antippen = auf die Liste
    const isCurrent = viewer.week === 'current';
    const byPage = new Map();
    if (isCurrent) {
      storeOffers(viewer.store).filter((o) => o.page).forEach((o) => {
        if (!byPage.has(o.page)) byPage.set(o.page, []);
        byPage.get(o.page).push(o);
      });
    }
    const onList = onListNames();
    content = `<p class="viewer__count">${flyer.pages.length} Seiten · einfach nach unten wischen${byPage.size ? ' · Produkte antippen = auf die Liste' : ''}</p><div class="pages">${flyer.pages.map((src, i) => {
      const products = byPage.get(i + 1) || [];
      return `
      <figure class="page">
        <img src="${escapeHtml(src)}" alt="Prospekt Seite ${i + 1}" loading="${i < 2 ? 'eager' : 'lazy'}" decoding="async">
        <figcaption>Seite ${i + 1} von ${flyer.pages.length}</figcaption>
        ${products.length ? `
        <div class="page__products">
          <h4>Von dieser Seite auf die Liste:</h4>
          <div class="page__chips">${products.map((o) => {
            const on = onList.has(normalize(o.name));
            return `<button type="button" class="pchip${on ? ' is-on-list' : ''}" data-add-offer="${escapeHtml(o.id)}">${escapeHtml(o.name)} <b>${escapeHtml(o.price)}</b></button>`;
          }).join('')}</div>
        </div>` : ''}
      </figure>`;
    }).join('')}</div>`;
  } else if (flyer.cover) {
    content = `
      <a class="cover-link" href="${escapeHtml(isMk ? pageUrl : flyer.viewerUrl)}" target="_blank" rel="noopener noreferrer">
        <img src="${escapeHtml(flyer.cover)}" alt="" onerror="this.parentElement.hidden=true">
      </a>`;
  }

  els.viewerBody.innerHTML = `
    <div class="viewer__actions">${actions.join('')}</div>
    ${content}
    ${flyer.pages?.length ? '<p class="viewer__note">Tipp: Mit zwei Fingern kannst du die Seiten größer ziehen.</p>' : ''}
    ${flyer.pdfUrl ? `<p class="viewer__note"><a href="${escapeHtml(flyer.pdfUrl)}" target="_blank" rel="noopener noreferrer">Als PDF herunterladen</a> (Achtung: sehr groß, nur im WLAN)</p>` : ''}
    ${isMk && flyer.pages?.length ? `<p class="viewer__note"><a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">Prospekt auf edeka.de öffnen</a></p>` : ''}
    ${isMk && !storeOffers('marktkauf').length ? `<p class="viewer__note">Etwas Leckeres im Prospekt gesehen? Unten auf der Startseite mit „🏷️ Angebot selbst markieren“ für alle eintragen.</p>` : ''}`;
}

function renderOfferBrowser() {
  els.viewerBody.innerHTML = `
    <div class="obrowser__search">
      <input type="search" id="offerSearch" placeholder="🔍 Angebote durchsuchen …" value="${escapeHtml(viewer.query)}"
             aria-label="Angebote durchsuchen" autocomplete="off">
    </div>
    <div id="offerList"></div>`;
  renderOfferList();
}

function offerCardHtml(o) {
  const onList = state.items.some((i) => !i.done && offerMatchScore(i.name, o.name) === 2);
  const later = o.validFrom && o.validFrom > todayIso();
  return `
    <div class="ocard${onList ? ' is-on-list' : ''}">
      ${o.image ? `<img class="ocard__img" src="${escapeHtml(o.image)}" alt="" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">` : '<span class="ocard__img"></span>'}
      <div class="ocard__text">
        ${o.brand ? `<span class="ocard__brand">${escapeHtml(o.brand)}</span>` : ''}
        <strong class="ocard__name">${escapeHtml(o.name)}</strong>
        <span class="ocard__unit">${escapeHtml([o.unit, o.basePrice].filter(Boolean).join(' · '))}</span>
        ${later ? `<span class="ocard__later">ab ${escapeHtml(weekdayShort(o.validFrom))}</span>` : ''}
      </div>
      <div class="ocard__side">
        <span class="ocard__price">${escapeHtml(o.price)}</span>
        <button type="button" class="ocard__add" data-add-offer="${escapeHtml(o.id)}"
                aria-label="${escapeHtml(o.name)} ${onList ? 'steht schon auf der Liste' : 'auf die Liste setzen'}">${onList ? '✓' : '＋'}</button>
      </div>
    </div>`;
}

function renderOfferList() {
  const list = $('#offerList', els.viewerBody);
  if (!list) return;
  const q = normalize(viewer.query);
  const all = storeOffers(viewer.store);
  const offers = q
    ? all.filter((o) => normalize(`${o.brand} ${o.name} ${o.group}`).includes(q))
    : all;

  const sections = [];
  if (!q) {
    const dealIds = new Set(getDeals().filter((d) => d.offer.auto && d.offer.store === viewer.store).map((d) => d.offer.id));
    const mine = all.filter((o) => dealIds.has(o.id));
    if (mine.length) sections.push(['⭐ Passt zu dir', mine]);
  }
  const groups = state.prospekte?.[viewer.store]?.offers?.groups || [];
  const byGroup = new Map();
  offers.forEach((o) => {
    if (!byGroup.has(o.group)) byGroup.set(o.group, []);
    byGroup.get(o.group).push(o);
  });
  [...byGroup.keys()]
    .sort((a, b) => groups.indexOf(a) - groups.indexOf(b))
    .forEach((g) => sections.push([g, byGroup.get(g)]));

  list.innerHTML = sections.length
    ? sections.map(([title, items]) => `
        <section class="ogroup">
          <h3 class="ogroup__title">${escapeHtml(title)} <span>${items.length}</span></h3>
          ${items.map(offerCardHtml).join('')}
        </section>`).join('')
    : `<p class="viewer__empty">Nichts gefunden für „${escapeHtml(viewer.query)}“.</p>`;
}

function addOfferToList(id) {
  const offer = storeOffers(viewer.store).find((o) => o.id === id);
  if (!offer) return;
  addParsed([{ name: offer.name, qty: '' }], viewer.store);
  if (viewer.tab === 'angebote') setTimeout(renderOfferList, 50);
}

/* ---------- Spracheingabe ---------- */

/** Verbindet einen Mikrofon-Knopf mit einem Eingabefeld (Web Speech API). */
function attachSpeech(button, input, { placeholder, onUpdate, onDone }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition || !button) return;
  button.hidden = false;
  const local = { rec: null, listening: false, base: '' };

  button.addEventListener('click', () => {
    if (local.listening) {
      local.rec?.stop();
      return;
    }
    const rec = new Recognition();
    rec.lang = 'de-DE';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    local.rec = rec;
    local.base = input.value.trim();

    rec.onstart = () => {
      local.listening = true;
      button.setAttribute('aria-pressed', 'true');
      input.placeholder = 'Ich höre zu … 🎤';
      vibrate(15);
    };
    rec.onresult = (event) => {
      const transcript = Array.from(event.results).map((r) => r[0].transcript).join(' ').trim();
      input.value = local.base ? `${local.base}, ${transcript}` : transcript;
      onUpdate?.();
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        showToast('Bitte das Mikrofon erlauben – oder das 🎤 auf der Tastatur nutzen.');
      } else if (event.error === 'no-speech') {
        showToast('Ich habe nichts gehört. Einfach nochmal versuchen.');
      }
    };
    rec.onend = () => {
      local.listening = false;
      button.setAttribute('aria-pressed', 'false');
      input.placeholder = placeholder;
      if (input.value.trim() && input.value.trim() !== local.base) onDone?.();
    };
    try {
      rec.start();
    } catch (err) {
      console.warn('[Sprache]', err);
    }
  });
}

function initSpeech() {
  attachSpeech(els.mic, els.input, {
    placeholder: 'z. B. Milch, Eier, Brot',
    onUpdate: () => { autoGrow(); updateSuggestions(); },
    onDone: () => {
      els.addBtn.classList.add('is-pulse');
      setTimeout(() => els.addBtn.classList.remove('is-pulse'), 2400);
      showToast('Passt das so? Dann auf „Auf die Liste“ tippen. 👍');
    }
  });
  attachSpeech(els.chatMic, els.chatInput, {
    placeholder: 'Deine Frage …',
    onDone: () => {
      const text = els.chatInput.value;
      els.chatInput.value = '';
      sendChat(text);
    }
  });
}

/* ---------- Vorschläge beim Tippen ---------- */

let vocabulary = null;

function buildVocabulary() {
  const map = new Map(); // key → { name, weight }
  const add = (name, weight) => {
    const clean = String(name || '').trim();
    const key = normalize(clean);
    if (key.length < 2) return;
    const existing = map.get(key);
    if (!existing || existing.weight < weight) map.set(key, { name: clean, weight });
  };
  // Wörterbuch-Begriffe (nur "schöne" Einträge)
  CATEGORIES.forEach((cat) => cat.keywords.forEach((kw) => {
    if (/^[a-zäöüß][a-zäöüß-]{3,}$/.test(kw)) add(kw.charAt(0).toUpperCase() + kw.slice(1), 1);
  }));
  STARTER_FAVORITES.forEach((n) => add(n, 5));
  state.items.forEach((i) => add(i.name, 20));
  Object.values(readJSON(LS.freq, {})).forEach((f) => add(f.name, 20 + f.count * 5));
  MAMA_FAVORITES.forEach((n) => add(n, 100));
  vocabulary = [...map.values()];
}

/** Letzter Teil der Eingabe (nach Komma / "und"). */
function currentSegment(text) {
  const parts = String(text).split(/[\n;,]|\s+und\s+/i);
  return parts[parts.length - 1].replace(/^\s*\d+\s*(?:x|×|g|kg|l|ml|stk\.?|stück)?\s+/i, '').trim();
}

function updateSuggestions() {
  const seg = normalize(currentSegment(els.input.value));
  if (seg.length < 2) {
    els.suggest.hidden = true;
    els.suggest.innerHTML = '';
    return;
  }
  if (!vocabulary) buildVocabulary();
  const matches = vocabulary
    .map((v) => {
      const key = normalize(v.name);
      let score = 0;
      if (key === seg) score = 3;
      else if (key.startsWith(seg)) score = 2;
      else if (key.split(/[\s-]/).some((w) => w.startsWith(seg))) score = 1;
      return { ...v, score };
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score || b.weight - a.weight || a.name.length - b.name.length)
    .filter((v, i, arr) => {
      // "Banane" und "Bananen" nur einmal zeigen
      const stemOf = (n) => normalize(n).replace(/(en|n|s|e)$/, '');
      return arr.findIndex((o) => stemOf(o.name) === stemOf(v.name)) === i;
    })
    .slice(0, 6);

  els.suggest.hidden = matches.length === 0;
  els.suggest.innerHTML = matches.map((m) => {
    const cat = CATEGORY_BY_ID[categoryFor(m.name)];
    const offer = getOffer(m.name);
    return `
      <button type="button" class="suggest__item" role="option" data-suggest="${escapeHtml(m.name)}">
        <span aria-hidden="true">${cat.icon}</span> ${escapeHtml(m.name)}
        ${offer ? `<span class="suggest__offer">🏷️ ${escapeHtml(offerLabel(offer))}</span>` : ''}
      </button>`;
  }).join('');
}

function applySuggestion(name) {
  const text = els.input.value;
  const seg = currentSegment(text);
  const idx = text.lastIndexOf(seg);
  els.input.value = idx >= 0 ? text.slice(0, idx) + name : name;
  els.suggest.hidden = true;
  els.form.requestSubmit();
}

/* ---------- Begrüßung ---------- */

function updateGreeting() {
  const h = new Date().getHours();
  const hello = h < 11 ? 'Guten Morgen' : h < 18 ? 'Hallo' : 'Guten Abend';
  const icon = h < 11 ? '☀️' : h < 18 ? '🌷' : '🌙';
  els.hello.textContent = `${hello}${GREETING_NAME ? `, ${GREETING_NAME}` : ''}! ${icon}`;
  const open = state.items.filter((i) => !i.done).length;
  els.greeting.textContent = open === 0 ? 'Was brauchst du heute?' : 'Was fehlt noch?';
}

/* ---------- Bereiche & Navigation ---------- */

function showView(name) {
  if (!document.querySelector(`.view[data-view="${name}"]`)) return;
  state.view = name;
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('[data-nav]', els.nav).forEach((btn) => {
    const active = btn.dataset.nav === name;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (name === 'rezepte') renderRecipes();
  if (name === 'helfer') renderChat();
  window.scrollTo({ top: 0 });
  vibrate(8);
}

function updateNavBadges(openCount) {
  els.navBadgeListe.hidden = !openCount;
  els.navBadgeListe.textContent = openCount;
  const deals = getDeals().filter((d) => !d.onList).length;
  els.navBadgeAngebote.hidden = !deals;
  els.navBadgeAngebote.textContent = deals;
}

/* ---------- Rezepte der Woche ---------- */

async function loadRezepte() {
  try {
    const res = await fetch('./data/rezepte.json', { cache: 'no-cache' });
    state.rezepte = res.ok ? await res.json() : null;
  } catch {
    state.rezepte = null;
  }
  if (state.view === 'rezepte') renderRecipes();
}

function onListNames() {
  return new Set(state.items.filter((i) => !i.done).map((i) => normalize(i.name)));
}

/* ---------- Kochbuch (gemeinsam, wächst mit der Zeit) ---------- */

const KB_KATEGORIEN = [
  { id: 'Hauptgerichte', icon: '🍲' },
  { id: 'Schnelle Gerichte', icon: '⚡' },
  { id: 'Frühstück', icon: '🥐' },
  { id: 'Suppen & Eintöpfe', icon: '🥣' },
  { id: 'Salate & Beilagen', icon: '🥗' },
  { id: 'Kuchen & Backen', icon: '🍰' }
];
const KB_KAT_IDS = KB_KATEGORIEN.map((k) => k.id);
const OLD_MY_RECIPES_LS = 'einkauf:meineRezepte';

/** Kategorie automatisch bestimmen (vom Helfer geliefert oder anhand von Titel/Zeit). */
function guessKategorie(r) {
  if (KB_KAT_IDS.includes(r.kategorie)) return r.kategorie;
  const t = normalize(`${r.titel} ${r.beschreibung || ''}`);
  if (/kuchen|torte|backen|muffin|plätzchen|plaetzchen|keks|waffel|brownie|stollen|hefezopf|tarte/.test(t)) return 'Kuchen & Backen';
  if (/suppe|eintopf|chili con|gulaschsuppe|brühe/.test(t)) return 'Suppen & Eintöpfe';
  if (/salat|beilage|dip\b/.test(t)) return 'Salate & Beilagen';
  if (/frühstück|fruehstueck|rührei|ruehrei|müsli|muesli|porridge|pancake|pfannkuchen|omelett|overnight|brötchen|bowl|skyr/.test(t)) return 'Frühstück';
  if (Number(r.dauer_minuten) && Number(r.dauer_minuten) <= 30) return 'Schnelle Gerichte';
  return 'Hauptgerichte';
}

function katIcon(id) {
  return KB_KATEGORIEN.find((k) => k.id === id)?.icon || '🍽️';
}

function handleKochbuch(map, meta = {}) {
  state.kochbuch = Object.entries(map)
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.titel && Array.isArray(r.zutaten))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  state.kochbuchLocal = Boolean(meta.local) && isFirebaseConfigured();

  // Bisherige „Meine Rezepte" (nur auf dem Gerät) einmalig ins Kochbuch übernehmen
  const old = readJSON(OLD_MY_RECIPES_LS, []);
  if (meta.fromServer && Array.isArray(old) && old.length) {
    const known = new Set(state.kochbuch.map((r) => normalize(r.titel)));
    const changes = {};
    old.filter((r) => r && r.titel && !known.has(normalize(r.titel))).forEach((r) => {
      changes[makeId()] = kochbuchEntry(r, 'helfer');
    });
    try { localStorage.removeItem(OLD_MY_RECIPES_LS); } catch { /* egal */ }
    if (Object.keys(changes).length) {
      backend.setMap('kochbuch', changes);
      return;
    }
  }
  if (state.view === 'rezepte') renderRecipes();
  if (state.view === 'helfer') renderChat();
}

function kochbuchEntry(r, herkunft) {
  return {
    titel: String(r.titel).slice(0, 120),
    emoji: r.emoji || '🍽️',
    beschreibung: r.beschreibung || '',
    portionen: Number(r.portionen) || 4,
    dauer_minuten: Number(r.dauer_minuten) || 0,
    schwierigkeit: r.schwierigkeit || 'einfach',
    zutaten: (r.zutaten || []).map((z) => ({
      name: z.name, menge: z.menge || '', laden: z.laden || 'egal',
      im_angebot: false, preis: '', vorrat: Boolean(z.vorrat)
    })),
    schritte: r.schritte || [],
    kategorie: guessKategorie(r),
    herkunft,
    favorit: false,
    notiz: '',
    createdAt: Date.now()
  };
}

function inKochbuch(titel) {
  return (state.kochbuch || []).some((r) => normalize(r.titel) === normalize(titel));
}

function addToKochbuch(recipe, herkunft) {
  if (inKochbuch(recipe.titel)) {
    showToast(`„${recipe.titel}“ ist schon im Kochbuch 📖`);
    return false;
  }
  backend.setMap('kochbuch', { [makeId()]: kochbuchEntry(recipe, herkunft) });
  showToast(`📖 „${recipe.titel}“ steht jetzt im Kochbuch`, {
    label: 'Ansehen',
    onClick: () => { state.rezepteTab = 'kochbuch'; showView('rezepte'); }
  });
  vibrate(15);
  return true;
}

function updateKochbuch(id, patch) {
  const entry = (state.kochbuch || []).find((r) => r.id === id);
  if (!entry) return;
  const { id: _, ...data } = entry;
  backend.setMap('kochbuch', { [id]: { ...data, ...patch } });
}

function removeFromKochbuch(id) {
  const entry = (state.kochbuch || []).find((r) => r.id === id);
  if (!entry) return;
  const { id: _, ...data } = entry;
  backend.setMap('kochbuch', { [id]: null });
  showToast(`„${entry.titel}“ aus dem Kochbuch entfernt`, {
    label: 'Rückgängig',
    onClick: () => backend.setMap('kochbuch', { [id]: data })
  });
}

/* ---------- Portionen umrechnen ---------- */

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };

function formatAmount(n, unit = '') {
  const u = unit.toLowerCase();
  let v;
  if (u === 'g' || u === 'ml') v = n >= 100 ? Math.round(n / 10) * 10 : Math.max(5, Math.round(n / 5) * 5);
  else if (u === 'kg' || u === 'l') v = Math.round(n * 10) / 10;
  else v = Math.max(0.5, Math.round(n * 2) / 2); // EL, TL, Tassen …: auf ½ runden
  return String(v).replace('.', ',');
}

// Mengen, die man nur ganz kaufen kann → auf ganze Stücke runden
const WHOLE_UNITS = /(stück|stk|st\.|\beier?\b|dosen?|gläser|glas|becher|packung|pck|päckchen|bund|zehen?|scheiben?|beutel|knollen?|köpfe?|kopf|stangen?|flaschen?|tafeln?|rollen?)/i;

/** "500 g" ×1,5 → "750 g", "2–3 Zehen" ×2 → "4–6 Zehen", "1 Prise" bleibt. */
function scaleMenge(menge, factor) {
  if (!menge || factor === 1 || /prise|etwas|nach geschmack|n\. b\./i.test(menge)) return menge;
  const whole = WHOLE_UNITS.test(menge);
  return String(menge).replace(/(\d+(?:[.,]\d+)?|[½¼¾⅓⅔])(\s*)([a-zäöüß.]*)/gi, (all, num, space, unit) => {
    let n = FRACTIONS[num] ?? parseFloat(num.replace(',', '.'));
    if (!Number.isFinite(n)) return all;
    n *= factor;
    const u = unit.toLowerCase();
    if (u === 'g' && n >= 1000) return `${formatAmount(n / 1000, 'kg')}${space}kg`;
    if (u === 'ml' && n >= 1000) return `${formatAmount(n / 1000, 'l')}${space}l`;
    if (whole) return `${Math.max(1, Math.round(n + 0.24))}${space}${unit}`;
    return `${formatAmount(n, u)}${space}${unit}`;
  });
}

function portionsFor(key, r) {
  return state.portions[key] || Number(r.portionen) || 4;
}

/** Rezept anhand seines Schlüssels: "w-<i>" (Woche), "k-<id>" (Kochbuch), "c-<msg>-<i>" (Chat). */
function recipeByKey(key) {
  const [type, a, b] = String(key).split('-');
  if (type === 'w') return state.rezepte?.rezepte?.[Number(a)] || null;
  if (type === 'k') return (state.kochbuch || []).find((r) => r.id === key.slice(2)) || null;
  if (type === 'c') return chat.messages[Number(a)]?.rezepte?.[Number(b)] || null;
  return null;
}

/** Rezeptkarte. mode: "kochbuch" | "woche" | "chat" */
function recipeCardHtml(r, key, { mode = 'woche' } = {}) {
  const open = state.openRecipes.has(key);
  const onList = onListNames();
  const zutaten = Array.isArray(r.zutaten) ? r.zutaten : [];
  const deals = zutaten.filter((z) => z.im_angebot);
  const base = Number(r.portionen) || 4;
  const persons = portionsFor(key, r);
  const factor = persons / base;
  const k = escapeHtml(key);

  const ingredients = zutaten.map((z, zi) => {
    const already = onList.has(normalize(applyWissen(z.name)));
    const checked = !z.vorrat && !already;
    return `
        <label class="ingr">
          <input type="checkbox" data-recipe="${k}" data-ingr="${zi}" ${checked ? 'checked' : ''}>
          <span>${escapeHtml(z.name)}
            ${z.im_angebot ? `<br><span class="ingr__deal">🏷️ ${escapeHtml(STORE_LABELS[z.laden] || '')} ${escapeHtml(z.preis)}</span>` : ''}
            ${already ? '<br><span class="ingr__deal" style="color:var(--primary-dark)">✓ steht schon drauf</span>' : ''}
          </span>
          <span class="ingr__menge">${escapeHtml(scaleMenge(z.menge, factor))}${z.vorrat ? '<br><small>(Vorrat)</small>' : ''}</span>
        </label>`;
  }).join('');

  const saved = mode === 'kochbuch' || inKochbuch(r.titel);
  return `
      <article class="recipe${mode === 'chat' ? ' recipe--chat' : ''}${r.favorit ? ' is-fav' : ''}">
        <div class="recipe__top">
          <span class="recipe__emoji" aria-hidden="true">${escapeHtml(r.emoji || '🍽️')}</span>
          <div class="recipe__head">
            <h3 class="recipe__title">${escapeHtml(r.titel)}</h3>
            <p class="recipe__meta">⏱ ${Number(r.dauer_minuten) || '?'} Min · 👥 ${base} Portionen · ${escapeHtml(r.schwierigkeit || 'einfach')}</p>
          </div>
          ${mode === 'kochbuch' ? `
          <button type="button" class="recipe__fav" data-kb-fav="${escapeHtml(r.id)}" aria-pressed="${Boolean(r.favorit)}"
                  aria-label="${r.favorit ? 'Nicht mehr Lieblingsrezept' : 'Als Lieblingsrezept markieren'}">${r.favorit ? '❤️' : '🤍'}</button>` : ''}
        </div>
        <p class="recipe__desc">${escapeHtml(r.beschreibung || '')}</p>
        ${mode === 'kochbuch' && r.notiz ? `<p class="recipe__note">📝 ${escapeHtml(r.notiz)}</p>` : ''}
        ${deals.length ? `<div class="recipe__deals">${deals.slice(0, 4).map((z) => `<span class="recipe__deal">🏷️ ${escapeHtml(z.name)} ${escapeHtml(z.preis)}</span>`).join('')}</div>` : ''}
        ${mode !== 'kochbuch' ? `
        <div class="recipe__save">
          ${saved
            ? '<span class="recipe__saved">📖 Steht im Kochbuch</span>'
            : `<button type="button" class="btn btn--primary btn--block" data-recipe-save="${k}">⭐ Ins Kochbuch</button>`}
        </div>` : ''}
        <button type="button" class="recipe__toggle" data-recipe-toggle="${k}" aria-expanded="${open}">
          ${open ? 'Rezept zuklappen' : '📖 Zutaten & Zubereitung'} <span aria-hidden="true">${open ? '▴' : '▾'}</span>
        </button>
        ${open ? `
        <div class="recipe__body">
          <div class="portions">
            <span>Für</span>
            <button type="button" class="portions__btn" data-portion="${k}" data-step="-1" aria-label="Weniger Portionen" ${persons <= 1 ? 'disabled' : ''}>−</button>
            <strong>${persons}</strong>
            <button type="button" class="portions__btn" data-portion="${k}" data-step="1" aria-label="Mehr Portionen">＋</button>
            <span>Personen</span>
          </div>
          <h4>Zutaten</h4>
          ${ingredients}
          <button type="button" class="btn btn--primary btn--block recipe__add" data-recipe-add="${k}">🛒 Ausgewählte auf die Liste</button>
          <h4>Zubereitung</h4>
          <ol class="steps">${(r.schritte || []).map((st) => `<li>${escapeHtml(st)}</li>`).join('')}</ol>
          ${mode === 'kochbuch' ? `
          <h4>📝 Meine Notiz</h4>
          <textarea class="recipe__notefield" data-kb-note="${escapeHtml(r.id)}" rows="2" maxlength="500"
                    placeholder="z. B. weniger Salz, Papa mag mehr Knoblauch">${escapeHtml(r.notiz || '')}</textarea>
          <h4>Kategorie</h4>
          <select class="recipe__cat" data-kb-cat="${escapeHtml(r.id)}" aria-label="Kategorie">
            ${KB_KATEGORIEN.map((c) => `<option value="${escapeHtml(c.id)}" ${c.id === r.kategorie ? 'selected' : ''}>${c.icon} ${escapeHtml(c.id)}</option>`).join('')}
          </select>
          <button type="button" class="btn btn--ghost-danger recipe__delete" data-kb-delete="${escapeHtml(r.id)}">🗑️ Aus dem Kochbuch entfernen</button>` : ''}
        </div>` : ''}
      </article>`;
}

function renderRecipes() {
  const week = state.rezepte?.rezepte || [];
  const book = state.kochbuch || [];
  if (!state.rezepteTab) state.rezepteTab = book.length ? 'kochbuch' : 'woche';
  const tab = state.rezepteTab;

  els.recipesSub.textContent = tab === 'kochbuch'
    ? 'Eure gesammelten Lieblingsrezepte – für die ganze Familie.'
    : 'Ideen aus den aktuellen Angeboten. Gefällt dir eins? Mit ⭐ ins Kochbuch.';

  const tabs = `
    <div class="seg seg--recipes" role="tablist" aria-label="Rezepte">
      <button type="button" role="tab" data-rtab="kochbuch" class="${tab === 'kochbuch' ? 'is-active' : ''}" aria-selected="${tab === 'kochbuch'}">📖 Mein Kochbuch <small>${book.length}</small></button>
      <button type="button" role="tab" data-rtab="woche" class="${tab === 'woche' ? 'is-active' : ''}" aria-selected="${tab === 'woche'}">🗓️ Ideen der Woche <small>${week.length}</small></button>
    </div>`;

  if (tab === 'woche') {
    const until = state.rezepte?.gueltigBis;
    const untilText = until && until >= todayIso()
      ? `<p class="recipes__info">Aus den Angeboten bis ${parseIso(until).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}.</p>` : '';
    els.recipes.innerHTML = tabs + (week.length
      ? untilText + week.map((r, ri) => recipeCardHtml(r, `w-${ri}`, { mode: 'woche' })).join('')
      : `<div class="empty-card"><div class="big" aria-hidden="true">🍲</div>
          <p><strong>Die Ideen der Woche kommen bald.</strong></p>
          <p>Sie werden automatisch aus den aktuellen Angeboten erstellt.</p></div>`);
    return;
  }

  if (!book.length) {
    els.recipes.innerHTML = tabs + `
      <div class="empty-card">
        <div class="big" aria-hidden="true">📖</div>
        <p><strong>Dein Kochbuch ist noch leer.</strong></p>
        <p>Tippe bei einem Rezept auf „⭐ Ins Kochbuch“ – in den Ideen der Woche oder beim Küchenhelfer.
        Eigene Rezepte (z. B. von Oma) erzählst du einfach dem Helfer.</p>
        <button type="button" class="btn btn--primary" data-rtab="woche">🗓️ Ideen der Woche ansehen</button>
        <button type="button" class="btn btn--ghost" data-nav="helfer" style="margin-top:8px">💬 Eigenes Rezept eintragen</button>
      </div>`;
    return;
  }

  const filter = state.kbFilter || 'alle';
  const cats = KB_KATEGORIEN.filter((c) => book.some((r) => r.kategorie === c.id));
  const hasFav = book.some((r) => r.favorit);
  if (!['alle', 'lieblinge', ...cats.map((c) => c.id)].includes(filter)) state.kbFilter = 'alle';
  const chip = (id, label) => `<button type="button" class="kbchip${(state.kbFilter || 'alle') === id ? ' is-active' : ''}" data-kb-filter="${escapeHtml(id)}">${label}</button>`;

  els.recipes.innerHTML = tabs + `
    <div class="kb__tools">
      <input type="search" id="kbSearch" placeholder="🔍 Im Kochbuch suchen …" value="${escapeHtml(state.kbSearch || '')}" aria-label="Im Kochbuch suchen" autocomplete="off">
      <div class="kb__filters">
        ${chip('alle', 'Alle')}
        ${hasFav ? chip('lieblinge', '❤️ Lieblinge') : ''}
        ${cats.map((c) => chip(c.id, `${c.icon} ${escapeHtml(c.id)}`)).join('')}
      </div>
    </div>
    ${state.kochbuchLocal ? '<p class="memory__note">Gerade nur auf diesem Handy gespeichert – für die ganze Familie fehlt noch eine Firebase-Regel (siehe README).</p>' : ''}
    <div id="kbList"></div>`;
  renderKochbuchList();
}

function renderKochbuchList() {
  const list = $('#kbList', els.recipes);
  if (!list) return;
  const q = normalize(state.kbSearch || '');
  const filter = state.kbFilter || 'alle';
  const book = (state.kochbuch || []).filter((r) => {
    if (filter === 'lieblinge' && !r.favorit) return false;
    if (filter !== 'alle' && filter !== 'lieblinge' && r.kategorie !== filter) return false;
    if (!q) return true;
    return normalize(`${r.titel} ${r.beschreibung} ${r.notiz || ''} ${(r.zutaten || []).map((z) => z.name).join(' ')}`).includes(q);
  });
  if (!book.length) {
    list.innerHTML = `<p class="viewer__empty">Nichts gefunden${q ? ` für „${escapeHtml(state.kbSearch)}“` : ''}.</p>`;
    return;
  }
  const sections = [];
  const favs = book.filter((r) => r.favorit);
  if (favs.length && filter !== 'lieblinge') sections.push(['❤️ Lieblingsrezepte', favs]);
  if (filter === 'lieblinge') sections.push(['❤️ Lieblingsrezepte', favs]);
  else {
    KB_KATEGORIEN.forEach((c) => {
      const items = book.filter((r) => r.kategorie === c.id && !r.favorit);
      if (items.length) sections.push([`${c.icon} ${c.id}`, items]);
    });
  }
  list.innerHTML = sections.map(([title, items]) => `
    <h3 class="recipes__heading">${escapeHtml(title)} <span>${items.length}</span></h3>
    ${items.map((r) => recipeCardHtml(r, `k-${r.id}`, { mode: 'kochbuch' })).join('')}`).join('');
}

/** Fügt Artikel [{ name, menge, laden }] hinzu – gruppiert nach Laden. */
function addSuggested(items) {
  const byStore = { both: [], aldi: [], marktkauf: [] };
  items.forEach((it) => {
    const store = it.laden === 'aldi' || it.laden === 'marktkauf' ? it.laden : 'both';
    byStore[store].push({ name: it.name.charAt(0).toUpperCase() + it.name.slice(1), qty: it.menge || '' });
  });
  let added = false;
  for (const [store, list] of Object.entries(byStore)) {
    if (list.length) added = addParsed(list, store) || added;
  }
  return added;
}

function rerenderRecipesOrChat(container) {
  if (container === els.chatLog) renderChat();
  else if ($('#kbList', els.recipes) && state.rezepteTab === 'kochbuch') renderKochbuchList();
  else renderRecipes();
}

function addRecipeIngredients(key, container) {
  const recipe = recipeByKey(key);
  if (!recipe) return;
  const factor = portionsFor(key, recipe) / (Number(recipe.portionen) || 4);
  const chosen = $$('input[data-recipe]', container)
    .filter((cb) => cb.dataset.recipe === key && cb.checked)
    .map((cb) => {
      const z = recipe.zutaten[Number(cb.dataset.ingr)];
      return { ...z, menge: scaleMenge(z.menge, factor) };
    });
  if (!chosen.length) {
    showToast('Bitte mindestens eine Zutat anhaken.');
    return;
  }
  addSuggested(chosen);
  setTimeout(() => rerenderRecipesOrChat(container), 100);
}

/** Gemeinsame Klicks auf Rezeptkarten (Rezepte-Reiter und Chat). */
function handleRecipeClick(e, container) {
  const t = e.target;
  const tab = t.closest('[data-rtab]');
  if (tab) {
    state.rezepteTab = tab.dataset.rtab;
    renderRecipes();
    return true;
  }
  const filter = t.closest('[data-kb-filter]');
  if (filter) {
    state.kbFilter = filter.dataset.kbFilter;
    renderRecipes();
    return true;
  }
  const toggle = t.closest('[data-recipe-toggle]');
  if (toggle) {
    const key = toggle.dataset.recipeToggle;
    if (state.openRecipes.has(key)) state.openRecipes.delete(key);
    else state.openRecipes.add(key);
    rerenderRecipesOrChat(container);
    return true;
  }
  const portion = t.closest('[data-portion]');
  if (portion) {
    const key = portion.dataset.portion;
    const recipe = recipeByKey(key);
    if (recipe) {
      state.portions[key] = Math.max(1, Math.min(20, portionsFor(key, recipe) + Number(portion.dataset.step)));
      rerenderRecipesOrChat(container);
    }
    return true;
  }
  const add = t.closest('[data-recipe-add]');
  if (add) {
    addRecipeIngredients(add.dataset.recipeAdd, container);
    return true;
  }
  const save = t.closest('[data-recipe-save]');
  if (save) {
    const key = save.dataset.recipeSave;
    const recipe = recipeByKey(key);
    if (recipe && addToKochbuch(recipe, key.startsWith('w-') ? 'woche' : 'helfer')) {
      setTimeout(() => rerenderRecipesOrChat(container), 50);
    }
    return true;
  }
  const fav = t.closest('[data-kb-fav]');
  if (fav) {
    const entry = (state.kochbuch || []).find((r) => r.id === fav.dataset.kbFav);
    if (entry) {
      updateKochbuch(entry.id, { favorit: !entry.favorit });
      vibrate(10);
    }
    return true;
  }
  const del = t.closest('[data-kb-delete]');
  if (del) {
    removeFromKochbuch(del.dataset.kbDelete);
    return true;
  }
  return false;
}

/* ---------- Familien-Gedächtnis ---------- */

const WISSEN_CACHE = `einkauf:wissen-cache:${LIST_ID}`;

function startWissenEntries() {
  return START_WISSEN.map((w, i) => ({ ...w, createdAt: i }));
}

/* ---------- Wocheneinkauf-Check (Do–Sa) ---------- */

function weekKey(date = new Date()) {
  // Samstag der laufenden Woche als Schlüssel
  const d = new Date(date);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

function renderWeeklyCheck() {
  const wrap = $('#weeklyWrap');
  if (!wrap) return;
  const day = new Date().getDay(); // 4 = Do, 5 = Fr, 6 = Sa
  const dismissed = readJSON('einkauf:wocheneinkauf-aus', '') === weekKey();
  const open = onListNames();
  const missing = WOCHENEINKAUF.filter((w) => !open.has(normalize(applyWissen(w.name))));
  wrap.hidden = !(day >= 4 && day <= 6) || dismissed || !missing.length;
  if (wrap.hidden) return;
  $('#weeklyTitle').textContent = day === 6 ? '🛒 Heute ist Wocheneinkauf – fehlt noch was?' : '🛒 Samstag ist Wocheneinkauf – fehlt noch was?';
  $('#weekly').innerHTML = missing.map((w) => `
    <button type="button" class="chip chip--fav" data-weekly="${escapeHtml(w.name)}" data-weekly-qty="${escapeHtml(w.qty || '')}">
      <span>${escapeHtml(w.name)}${w.qty ? ` <small>(${escapeHtml(w.qty)})</small>` : ''}</span>
    </button>`).join('');
}

function handleWissen(map, meta = {}) {
  // Startwissen einmalig ins gemeinsame Gedächtnis übernehmen
  // (nur nach echter Server-Antwort, damit Gelöschtes nicht zurückkommt)
  const seededVersion = map._start ? (map._start.version || 1) : 0;
  if (seededVersion < WISSEN_VERSION && meta.fromServer) {
    // Nur Einträge übernehmen, die seit der letzten Übernahme neu sind
    const seed = { _start: { seeded: true, version: WISSEN_VERSION, at: Date.now() } };
    startWissenEntries()
      .filter((w) => (w.seit || 1) > seededVersion)
      .forEach(({ id, seit, ...entry }) => { seed[id] = entry; });
    backend.setWissen(seed);
    // Das Speichern löst gleich eine neue Meldung mit dem vollständigen Stand aus
    return;
  }
  const entries = Object.entries(map)
    .filter(([id]) => id !== '_start')
    .map(([id, w]) => ({ id, ...w }))
    .filter((w) => w.text)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  state.wissen = map._start || entries.length ? entries : startWissenEntries();
  state.wissenLocal = Boolean(meta.local) && isFirebaseConfigured();
  writeJSON(WISSEN_CACHE, state.wissen);
  vocabulary = null;
  autoOfferCache.clear();
  renderWissen();
  if (state.view === 'liste') renderFavorites();
}

/** "Milch" → "Milch 1,5 %" usw. (nur bei genau passendem Namen) */
function applyWissen(name) {
  const key = normalize(name);
  const rule = (state.wissen || []).find((w) => w.wenn && w.dann && normalize(w.wenn) === key);
  return rule ? rule.dann : name;
}

function addWissen({ text, wenn = '', dann = '' }) {
  const clean = String(text || '').trim().slice(0, 240);
  if (!clean) return;
  if ((state.wissen || []).some((w) => normalize(w.text) === normalize(clean))) {
    showToast('Das weiß ich schon 😊');
    return;
  }
  const entry = { text: clean, createdAt: Date.now() };
  if (wenn.trim() && dann.trim()) {
    entry.wenn = wenn.trim().slice(0, 60);
    entry.dann = dann.trim().slice(0, 80);
  }
  backend.setWissen({ [makeId()]: entry });
  showToast('🧠 Gemerkt!');
  vibrate(15);
}

function removeWissen(id) {
  const entry = (state.wissen || []).find((w) => w.id === id);
  if (!entry) return;
  backend.setWissen({ [id]: null });
  const { id: _, ...data } = entry;
  showToast('Vergessen', { label: 'Rückgängig', onClick: () => backend.setWissen({ [id]: data }) });
}

function renderWissen() {
  const list = state.wissen || [];
  $('#memoryCount').textContent = list.length;
  $('#memoryList').innerHTML = list.map((w) => `
    <li class="memory__item">
      <span>${escapeHtml(w.text)}${w.wenn && w.dann ? `<br><small>„${escapeHtml(w.wenn)}“ wird automatisch zu „${escapeHtml(w.dann)}“</small>` : ''}</span>
      <button type="button" class="memory__del" data-wissen-del="${escapeHtml(w.id)}" aria-label="Vergessen: ${escapeHtml(w.text)}">🗑️</button>
    </li>`).join('') || '<li class="memory__empty">Noch nichts gemerkt.</li>';
  $('#memoryNote').hidden = !state.wissenLocal;
}

/* ---------- Küchenhelfer (Chat) ---------- */

const CHAT_LS = 'einkauf:chat';
const CODE_LS = 'einkauf:familiencode';
const chat = { messages: readJSON(CHAT_LS, []), busy: false, needsCode: false };

function saveChat() {
  chat.messages = chat.messages.slice(-30);
  writeJSON(CHAT_LS, chat.messages.filter((m) => !m.error));
}

/** Sehr einfache, sichere Formatierung: **fett** und Zeilenumbrüche. */
function formatBotText(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderChat() {
  // Einrichtung
  if (!CHAT_URL) {
    els.chatSetup.hidden = false;
    els.chatSetup.innerHTML = `
      <div class="empty-card">
        <div class="big" aria-hidden="true">🧑‍🍳</div>
        <p><strong>Der Küchenhelfer ist noch nicht eingerichtet.</strong></p>
        <p>Kai muss ihn einmal freischalten (Anleitung in der README). Danach kannst du hier alles rund ums Einkaufen und Kochen fragen.</p>
      </div>`;
    els.chatForm.hidden = true;
    els.chatIdeas.hidden = true;
    els.chatLog.innerHTML = '';
    return;
  }
  if (chat.needsCode || !readJSON(CODE_LS, '')) {
    els.chatSetup.hidden = false;
    els.chatSetup.innerHTML = `
      <div class="empty-card">
        <div class="big" aria-hidden="true">🔑</div>
        <p><strong>Einmal den Familien-Code eingeben</strong></p>
        <p>Den Code bekommst du von Kai. Danach merkt sich das Handy ihn.</p>
        <input type="text" id="familyCode" autocomplete="off" placeholder="Familien-Code" aria-label="Familien-Code">
        <button type="button" class="btn btn--primary btn--block" id="familyCodeSave">Speichern</button>
      </div>`;
    els.chatForm.hidden = true;
    els.chatIdeas.hidden = true;
    return;
  }
  els.chatSetup.hidden = true;
  els.chatForm.hidden = false;
  els.chatIdeas.hidden = chat.messages.length > 0;

  const onList = onListNames();
  const parts = chat.messages.map((m, mi) => {
    if (m.role === 'user') return `<div class="bubble bubble--me">${escapeHtml(m.content)}</div>`;
    let html = `<div class="bubble bubble--bot${m.error ? ' bubble--error' : ''}">${formatBotText(m.content)}</div>`;
    (m.rezepte || []).forEach((r, ri) => { html += recipeCardHtml(r, `c-${mi}-${ri}`, { mode: 'chat' }); });
    if (m.merken?.length) {
      const known = new Set((state.wissen || []).map((w) => normalize(w.text)));
      html += `
        <div class="memory-suggest">
          <h4>🧠 Soll ich mir das merken?</h4>
          ${m.merken.map((x, xi) => {
            const done = (m.gemerkt || []).includes(xi) || known.has(normalize(x.text));
            return `
            <div class="memory-suggest__row">
              <span>${escapeHtml(x.text)}</span>
              ${done
                ? '<span class="memory-suggest__done">✓ gemerkt</span>'
                : `<button type="button" class="btn btn--primary" data-merken="${mi}-${xi}">Merken</button>`}
            </div>`;
          }).join('')}
        </div>`;
    }
    if (m.artikel?.length) {
      html += `
        <div class="suggestion">
          <h4>🛒 Vorschlag für deine Liste</h4>
          ${m.artikel.map((a, ai) => {
            const already = onList.has(normalize(a.name));
            return `
              <label class="ingr">
                <input type="checkbox" data-chat-msg="${mi}" data-chat-item="${ai}" ${already || m.added ? '' : 'checked'} ${m.added ? 'disabled' : ''}>
                <span>${escapeHtml(a.name)}
                  ${a.laden !== 'egal' ? `<br><span class="ingr__deal">🏷️ ${escapeHtml(STORE_LABELS[a.laden])}</span>` : ''}
                  ${already ? '<br><span class="ingr__deal" style="color:var(--primary-dark)">✓ steht schon drauf</span>' : ''}
                </span>
                <span class="ingr__menge">${escapeHtml(a.menge)}</span>
              </label>`;
          }).join('')}
          ${m.added
            ? '<p style="margin:10px 0 0;font-weight:800;color:var(--primary-dark)">✓ Ist auf der Liste</p>'
            : `<button type="button" class="btn btn--primary btn--block" data-chat-add="${mi}">🛒 Ausgewählte auf die Liste</button>`}
        </div>`;
    }
    return html;
  });
  if (chat.busy) parts.push('<div class="bubble bubble--bot bubble--typing">Ich überlege kurz … 🍳</div>');
  if (chat.messages.length && !chat.busy) {
    parts.push('<button type="button" class="btn btn--ghost" id="chatReset" style="align-self:center">🧹 Neues Gespräch</button>');
  }
  els.chatLog.innerHTML = parts.join('');
  els.chatSend.disabled = chat.busy;
}

async function sendChat(text) {
  const question = String(text || '').trim();
  if (!question || chat.busy || !CHAT_URL) return;
  chat.messages.push({ role: 'user', content: question });
  chat.busy = true;
  saveChat();
  renderChat();
  els.chatLog.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });

  const history = chat.messages.filter((m) => !m.error).slice(-16).map((m) => ({ role: m.role, content: m.content }));
  const liste = state.items.filter((i) => !i.done).map((i) => `${i.qty ? `${i.qty} ` : ''}${i.name}`);
  try {
    const res = await fetch(`${CHAT_URL.replace(/\/$/, '')}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Familien-Code': readJSON(CODE_LS, '') },
      body: JSON.stringify({ messages: history, liste, wissen: (state.wissen || []).map((w) => w.text) })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      chat.needsCode = true;
      chat.messages.pop();
      showToast('Der Familien-Code stimmt nicht – bitte nochmal eingeben.');
    } else if (!res.ok) {
      chat.messages.push({ role: 'assistant', content: data.fehler || 'Der Helfer ist gerade nicht erreichbar.', error: true });
    } else {
      chat.messages.push({
        role: 'assistant',
        content: data.antwort || '',
        artikel: Array.isArray(data.artikel) ? data.artikel : [],
        rezepte: Array.isArray(data.rezepte) ? data.rezepte.filter((r) => r && r.titel && Array.isArray(r.zutaten)) : [],
        merken: Array.isArray(data.merken) ? data.merken.filter((x) => x && x.text) : []
      });
    }
  } catch {
    chat.messages.push({ role: 'assistant', content: 'Keine Verbindung – bist du online? Versuch es gleich nochmal.', error: true });
  }
  chat.busy = false;
  saveChat();
  renderChat();
  els.chatLog.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function addChatSuggestion(mi) {
  const msg = chat.messages[mi];
  if (!msg?.artikel) return;
  const chosen = $$(`input[data-chat-msg="${mi}"]`, els.chatLog)
    .filter((cb) => cb.checked)
    .map((cb) => msg.artikel[Number(cb.dataset.chatItem)]);
  if (!chosen.length) {
    showToast('Bitte mindestens eine Sache anhaken.');
    return;
  }
  addSuggested(chosen);
  msg.added = true;
  saveChat();
  renderChat();
}

/* ---------- WhatsApp teilen ---------- */

function buildShareText() {
  const open = state.items.filter((i) => !i.done && matchesFilter(i, state.filter));
  if (!open.length) return '';

  const date = new Date().toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const lines = [`🛒 *Einkaufsliste* (${date})`];

  const formatSection = (title, items) => {
    if (!items.length) return;
    lines.push('', title);
    for (const cat of CATEGORIES) {
      const catItems = items
        .filter((i) => i.category === cat.id)
        .sort((a, b) => a.createdAt - b.createdAt);
      if (!catItems.length) continue;
      lines.push(`${cat.icon} _${cat.name}_`);
      catItems.forEach((i) => {
        const o = getOffer(i.name);
        const offer = o ? ` 🏷️ Angebot ${offerLabel(o)}` : (i.isOffer ? ` 🏷️${i.offerPrice ? ` ${i.offerPrice}` : ''}` : '');
        lines.push(`• ${i.qty ? `${i.qty} ` : ''}${i.name}${offer}`);
      });
    }
  };

  if (state.filter === 'all') {
    formatSection('🔵 *Marktkauf*', open.filter((i) => i.store === 'marktkauf'));
    formatSection('🟠 *Aldi*', open.filter((i) => i.store === 'aldi'));
    const both = open.filter((i) => i.store === 'both');
    const hasStoreSpecific = both.length !== open.length;
    formatSection(hasStoreSpecific ? '🟢 *Egal wo*' : '🟢 *Alles*', both);
  } else {
    formatSection(`*${STORE_LABELS[state.filter]}*`, open);
  }

  lines.push('', `${open.length} Artikel`);
  return lines.join('\n');
}

function shareViaWhatsApp() {
  const text = buildShareText();
  if (!text) {
    showToast('Die Liste ist leer – nichts zu teilen.');
    return;
  }
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  // Über einen Link öffnen: in der installierten App startet so direkt WhatsApp,
  // im Browser öffnet sich ein neuer Tab – die Liste bleibt offen.
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/* ================================================================
 * 6. Wake Lock, Service Worker, Start
 * ================================================================ */

const wake = { wanted: false, sentinel: null };

async function requestWakeLock() {
  try {
    wake.sentinel = await navigator.wakeLock.request('screen');
    wake.sentinel.addEventListener('release', () => {
      wake.sentinel = null;
      if (!wake.wanted) updateWakeButton();
    });
    updateWakeButton();
  } catch (err) {
    console.warn('[WakeLock]', err);
    wake.wanted = false;
    updateWakeButton();
    showToast('Display-Sperre konnte nicht aktiviert werden.');
  }
}

function updateWakeButton() {
  els.wake.setAttribute('aria-pressed', String(wake.wanted));
  $('.wake__label', els.wake).innerHTML = wake.wanted ? 'Display<br>bleibt an' : 'Display<br>anlassen';
}

function initWakeLock() {
  if (!('wakeLock' in navigator)) return;
  els.wake.hidden = false;
  els.wake.addEventListener('click', async () => {
    wake.wanted = !wake.wanted;
    vibrate(10);
    if (wake.wanted) {
      await requestWakeLock();
      if (wake.wanted) showToast('Display bleibt jetzt an 💡');
    } else {
      await wake.sentinel?.release();
      wake.sentinel = null;
      updateWakeButton();
    }
  });
  // Nach App-Wechsel wird die Sperre vom System aufgehoben → neu anfordern
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wake.wanted && !wake.sentinel) requestWakeLock();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Neue App-Version aktiv → einmal neu laden (nicht beim allerersten Start)
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[SW]', err));
  });
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight + 4, 180)}px`;
}

function bindEvents() {
  // Eingabe
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (addFromText(els.input.value)) {
      els.input.value = '';
      autoGrow();
      updateSuggestions();
    } else {
      els.input.focus();
    }
  });
  els.input.addEventListener('input', () => {
    autoGrow();
    updateSuggestions();
  });
  els.suggest.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-suggest]');
    if (btn) applySuggestion(btn.dataset.suggest);
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });

  // Laden-Auswahl beim Hinzufügen
  els.storePicker.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-store]');
    if (!chip) return;
    state.addStore = chip.dataset.store;
    setPickerActive(els.storePicker, state.addStore);
    vibrate(8);
  });

  // Favoriten
  els.favorites.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fav]');
    if (chip) addFromText(chip.dataset.fav);
  });

  // Filter-Tabs
  els.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-filter]');
    if (!tab) return;
    state.filter = tab.dataset.filter;
    writeJSON(LS.filter, state.filter);
    vibrate(8);
    render();
  });

  // Liste & Erledigt (Event-Delegation)
  const onListClick = (e) => {
    const btn = e.target.closest('[data-action]');
    const row = e.target.closest('.item');
    if (!btn || !row) return;
    if (btn.dataset.action === 'toggle') toggleItem(row.dataset.id);
    if (btn.dataset.action === 'edit') openEdit(row.dataset.id);
  };
  els.list.addEventListener('click', onListClick);
  els.doneList.addEventListener('click', onListClick);

  els.doneToggle.addEventListener('click', () => {
    state.doneOpen = !state.doneOpen;
    writeJSON(LS.doneOpen, state.doneOpen);
    render();
  });
  els.clearDone.addEventListener('click', clearDone);

  // Teilen
  els.share.addEventListener('click', shareViaWhatsApp);

  // Navigation (unten + Knöpfe mit data-nav im Inhalt)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (btn) showView(btn.dataset.nav);
  });

  // Rezepte
  els.recipes.addEventListener('click', (e) => handleRecipeClick(e, els.recipes));
  els.recipes.addEventListener('input', (e) => {
    if (e.target.id !== 'kbSearch') return;
    state.kbSearch = e.target.value;
    renderKochbuchList();
  });
  els.recipes.addEventListener('change', (e) => {
    const note = e.target.closest('[data-kb-note]');
    if (note) {
      updateKochbuch(note.dataset.kbNote, { notiz: note.value.trim().slice(0, 500) });
      showToast('📝 Notiz gespeichert');
    }
    const cat = e.target.closest('[data-kb-cat]');
    if (cat && KB_KAT_IDS.includes(cat.value)) {
      updateKochbuch(cat.dataset.kbCat, { kategorie: cat.value });
      showToast(`Jetzt unter „${cat.value}“`);
    }
  });

  // Küchenhelfer
  els.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatInput.value;
    els.chatInput.value = '';
    els.chatInput.style.height = '';
    sendChat(text);
  });
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.chatForm.requestSubmit();
    }
  });
  els.chatInput.addEventListener('input', () => {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 140)}px`;
  });
  els.chatIdeas.addEventListener('click', (e) => {
    const fill = e.target.closest('[data-idea-fill]');
    if (fill) {
      els.chatInput.value = fill.dataset.ideaFill;
      els.chatInput.focus();
      return;
    }
    const idea = e.target.closest('[data-idea]');
    if (idea) sendChat(idea.dataset.idea);
  });
  els.chatLog.addEventListener('click', (e) => {
    if (handleRecipeClick(e, els.chatLog)) return;
    const merk = e.target.closest('[data-merken]');
    if (merk) {
      const [mi, xi] = merk.dataset.merken.split('-').map(Number);
      const msg = chat.messages[mi];
      const item = msg?.merken?.[xi];
      if (item) {
        addWissen(item);
        msg.gemerkt = [...(msg.gemerkt || []), xi];
        saveChat();
        renderChat();
      }
      return;
    }
    const add = e.target.closest('[data-chat-add]');
    if (add) addChatSuggestion(Number(add.dataset.chatAdd));
    if (e.target.closest('#chatReset')) {
      chat.messages = [];
      saveChat();
      renderChat();
    }
  });
  els.chatSetup.addEventListener('click', (e) => {
    if (!e.target.closest('#familyCodeSave')) return;
    const code = $('#familyCode', els.chatSetup)?.value.trim();
    if (!code) return;
    writeJSON(CODE_LS, code);
    chat.needsCode = false;
    renderChat();
    showToast('Gespeichert – jetzt kannst du loslegen! 😊');
  });

  // Wocheneinkauf-Check
  $('#weekly').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-weekly]');
    if (chip) addParsed([{ name: chip.dataset.weekly, qty: chip.dataset.weeklyQty }]);
  });
  $('#weeklyAll').addEventListener('click', () => {
    const open = onListNames();
    const missing = WOCHENEINKAUF.filter((w) => !open.has(normalize(applyWissen(w.name))));
    addParsed(missing.map((w) => ({ name: w.name, qty: w.qty || '' })));
  });
  $('#weeklyHide').addEventListener('click', () => {
    writeJSON('einkauf:wocheneinkauf-aus', weekKey());
    renderWeeklyCheck();
  });

  // Familien-Gedächtnis
  $('#memoryList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-wissen-del]');
    if (del) removeWissen(del.dataset.wissenDel);
  });
  $('#memoryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#memoryInput');
    addWissen({ text: input.value });
    input.value = '';
  });

  // Prospekte & Angebote
  $$('[data-open-prospekt]').forEach((btn) => {
    btn.addEventListener('click', () => openProspekt(btn.dataset.openProspekt));
  });
  els.deals.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-deal]');
    if (!btn) return;
    if (btn.classList.contains('is-on-list')) {
      showToast(`„${btn.dataset.deal}“ steht schon auf der Liste ✓`);
      return;
    }
    addFromText(btn.dataset.deal, btn.dataset.dealStore);
  });
  els.viewerClose.addEventListener('click', closeViewer);
  els.viewerWeeks.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-week]');
    if (!btn) return;
    viewer.week = btn.dataset.week;
    renderViewer();
    els.viewerBody.scrollTop = 0;
  });
  els.viewerTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    viewer.tab = btn.dataset.tab;
    renderViewer();
    els.viewerBody.scrollTop = 0;
  });
  els.viewerBody.addEventListener('input', (e) => {
    if (e.target.id !== 'offerSearch') return;
    viewer.query = e.target.value;
    renderOfferList();
  });
  els.viewerBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-offer]');
    if (!btn || btn.classList.contains('is-on-list') || btn.textContent.trim() === '✓') return;
    addOfferToList(btn.dataset.addOffer);
    if (btn.classList.contains('pchip')) btn.classList.add('is-on-list');
  });

  // Angebote markieren
  els.offerBtn.addEventListener('click', openOffers);
  els.offerCancel.addEventListener('click', closeOffers);
  els.offerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveOffers();
  });
  els.offerNewAdd.addEventListener('click', addOfferRow);
  els.offerNewName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addOfferRow();
    }
  });
  els.offerRows.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-offer-store]');
    const row = e.target.closest('.offer-row');
    if (!chip || !row) return;
    const draft = state.offerDraft[row.dataset.key] || { store: '', price: '' };
    draft.store = chip.dataset.offerStore;
    state.offerDraft[row.dataset.key] = draft;
    renderOfferRows();
    if (draft.store) els.offerRows.querySelector(`[data-key="${CSS.escape(row.dataset.key)}"] .offer-row__price`)?.focus();
  });
  els.offerRows.addEventListener('input', (e) => {
    if (!e.target.classList.contains('offer-row__price')) return;
    const key = e.target.closest('.offer-row').dataset.key;
    state.offerDraft[key] = { ...(state.offerDraft[key] || { store: '' }), price: e.target.value };
  });
  els.offerDialog.addEventListener('click', (e) => {
    if (e.target === els.offerDialog) closeOffers();
  });

  // Bearbeiten-Dialog
  els.editStore.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-store]');
    if (!chip) return;
    state.editStore = chip.dataset.store;
    setPickerActive(els.editStore, state.editStore);
  });
  els.editCategory.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (btn) setEditCategory(btn.dataset.cat);
  });
  els.editForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveEdit();
  });
  els.editCancel.addEventListener('click', closeEdit);
  els.editDelete.addEventListener('click', deleteFromEdit);
  els.dialog.addEventListener('click', (e) => {
    if (e.target === els.dialog) closeEdit(); // Klick auf den Hintergrund
  });
  els.dialog.addEventListener('close', () => { state.editing = null; });

  // Online/Offline-Anzeige
  window.addEventListener('offline', () => { if (backend instanceof FirebaseBackend) setStatus('offline'); });
  window.addEventListener('online', () => { if (backend instanceof FirebaseBackend) setStatus('connecting'); });

  // Höhe der Kopfzeile für die "klebenden" Filter-Tabs
  const topbar = $('.topbar');
  const setTopbarHeight = () => {
    document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
  };
  setTopbarHeight();
  if ('ResizeObserver' in window) new ResizeObserver(setTopbarHeight).observe(topbar);
}

function init() {
  // Prospekt-Links
  loadProspekte();
  loadRezepte();
  updateGreeting();

  buildCategoryGrid();
  bindEvents();
  initWakeLock();
  initSpeech();
  registerServiceWorker();

  if (backend instanceof FirebaseBackend) {
    els.modeInfo.textContent = `Gemeinsame Liste „${LIST_ID}“ · Änderungen erscheinen sofort bei allen.`;
    // Letzten Stand sofort anzeigen, bis Firebase geladen ist
    const cached = readJSON(LS.cache, []);
    if (Array.isArray(cached) && cached.length) handleItems(cached);
    else render();
  } else {
    els.modeInfo.textContent = 'Demo-Modus: Firebase ist noch nicht eingerichtet (siehe README.md). Die Liste wird nur auf diesem Gerät gespeichert.';
  }

  backend.startOffers(handleOffers);
  renderWissen();
  backend.startWissen(handleWissen);
  backend.startMap('kochbuch', handleKochbuch);
  backend.start(handleItems, setStatus);
}

init();
