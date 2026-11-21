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
 * ------------------------------------------------------------------
 */

import {
  CATEGORIES, CATEGORY_BY_ID, DEFAULT_CATEGORY, categorize, normalize, parseItems
} from './categories.js';
import {
  firebaseConfig, LIST_ID, USE_ANONYMOUS_AUTH, OFFER_LINKS, isFirebaseConfigured
} from './config.js';

/* ================================================================
 * 1. Konstanten & Hilfsfunktionen
 * ================================================================ */

const FIREBASE_VERSION = '10.12.2';
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const STORE_LABELS = { both: 'Beide / Egal', marktkauf: 'Marktkauf', aldi: 'Aldi' };
const CHECK_ANIMATION_MS = 600;
const FAVORITES_LIMIT = 10;
const STARTER_FAVORITES = ['Milch', 'Brot', 'Eier', 'Butter', 'Bananen', 'Äpfel', 'Käse', 'Joghurt', 'Kaffee', 'Tomaten'];

const LS = {
  freq: 'einkauf:freq',
  learned: 'einkauf:learned',
  doneOpen: 'einkauf:doneOpen',
  filter: 'einkauf:filter',
  cache: `einkauf:cache:${LIST_ID}`,
  demoItems: `einkauf:demo:${LIST_ID}`
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
        if (user && this.listenerFailed) this.subscribe();
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
  flash: new Set()     // Duplikate hervorheben
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

function getFavorites() {
  const freq = readJSON(LS.freq, {});
  const openNames = new Set(state.items.filter((i) => !i.done).map((i) => normalize(i.name)));
  const list = Object.entries(freq)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count || b.last - a.last);

  // Startvorschläge auffüllen, solange noch wenig gelernt wurde
  for (const name of STARTER_FAVORITES) {
    const key = normalize(name);
    if (!freq[key]) list.push({ key, name, count: 0, last: 0 });
  }

  return list.filter((f) => !openNames.has(f.key)).slice(0, FAVORITES_LIMIT);
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
  toastAction: $('#toastAction')
};

function itemHtml(item) {
  const classes = ['item'];
  if (state.checking.has(item.id)) classes.push('is-checking');
  if (state.fresh.has(item.id)) classes.push('is-new');
  if (state.flash.has(item.id)) classes.push('is-flash');

  const badges = [];
  if (item.store === 'marktkauf') badges.push('<span class="badge badge--marktkauf">Marktkauf</span>');
  if (item.store === 'aldi') badges.push('<span class="badge badge--aldi">Aldi</span>');
  if (item.isOffer) {
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
    <section class="group" aria-label="${escapeHtml(cat.name)}">
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
  updateDocumentTitle(open.length);
}

function renderFavorites() {
  const favs = getFavorites();
  els.favoritesWrap.hidden = favs.length === 0;
  els.favorites.innerHTML = favs.map((f) => `
    <button type="button" class="chip chip--fav" data-fav="${escapeHtml(f.name)}"
            aria-label="${escapeHtml(f.name)} hinzufügen">${escapeHtml(f.name)}</button>`).join('');
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
  render();
}

function addFromText(text, store = state.addStore) {
  const parsed = parseItems(text);
  if (!parsed.length) return false;

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
        const offer = i.isOffer ? ` 🏷️${i.offerPrice ? ` ${i.offerPrice}` : ''}` : '';
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
    } else {
      els.input.focus();
    }
  });
  els.input.addEventListener('input', autoGrow);
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
  $('#offerMarktkauf').href = OFFER_LINKS.marktkauf;
  $('#offerAldi').href = OFFER_LINKS.aldi;

  buildCategoryGrid();
  bindEvents();
  initWakeLock();
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

  backend.start(handleItems, setStatus);
}

init();
