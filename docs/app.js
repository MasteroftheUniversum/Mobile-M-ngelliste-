'use strict';

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

/* ---------- Settings (localStorage) ---------- */
const DEFAULT_XLSX_PASSWORD = 'maengel2026';
const Settings = {
  get email() { return localStorage.getItem('ml_email') || ''; },
  set email(v) { localStorage.setItem('ml_email', v || ''); },
  get photoSize() { return localStorage.getItem('ml_photoSize') || 'mittel'; },
  set photoSize(v) { localStorage.setItem('ml_photoSize', v); },
  get xlsxProtect() { return localStorage.getItem('ml_xlsxProtect') !== '0'; }, // Standard: an
  set xlsxProtect(v) { localStorage.setItem('ml_xlsxProtect', v ? '1' : '0'); },
  get xlsxPassword() { return localStorage.getItem('ml_xlsxPassword') || ''; },
  set xlsxPassword(v) { localStorage.setItem('ml_xlsxPassword', v || ''); },
};

/* ---------- Fotogröße (PDF/Excel) ---------- */
const PHOTO_SIZES = {
  klein:  { pdfWidth: 80,  xlsxWidth: 70,  perPage: 6, previewPx: 50 },
  mittel: { pdfWidth: 140, xlsxWidth: 130, perPage: 4, previewPx: 85 },
  gross:  { pdfWidth: 200, xlsxWidth: 200, perPage: 3, previewPx: 120 },
};

function renderPhotoSizeChooser() {
  const sample = cache.find(e => e.photos && e.photos.length)?.photos[0] || null;
  const selected = Settings.photoSize;
  document.querySelectorAll('.photosize-option').forEach(btn => {
    const size = btn.dataset.size;
    const cfg = PHOTO_SIZES[size];
    btn.classList.toggle('selected', size === selected);
    const preview = btn.querySelector('.photosize-preview');
    preview.innerHTML = sample
      ? `<img src="${sample}" style="width:${cfg.previewPx}px;height:${cfg.previewPx}px">`
      : `<div style="width:${cfg.previewPx}px;height:${cfg.previewPx}px;background:var(--border);border-radius:8px"></div>`;
    btn.querySelector('.photosize-hint').textContent = `ca. ${cfg.perPage} / PDF-Seite`;
  });
}

document.querySelectorAll('.photosize-option').forEach(btn => {
  btn.addEventListener('click', () => {
    Settings.photoSize = btn.dataset.size;
    renderPhotoSizeChooser();
  });
});

/* ---------- History (Dropdown-Vorschläge für Ort/Bereich und Beschreibung) ---------- */
const HISTORY_LIMIT = 60;
function getHistory(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function addHistory(key, value) {
  if (!value) return;
  const list = getHistory(key).filter(v => v !== value);
  list.unshift(value);
  localStorage.setItem(key, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
}
function renderDatalist(datalistId, key) {
  const dl = document.getElementById(datalistId);
  dl.innerHTML = getHistory(key).map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
}
function refreshHistoryDatalists() {
  renderDatalist('ortHistoryList', 'ml_ortHistory');
  renderDatalist('rohtextHistoryList', 'ml_rohtextHistory');
  renderDatalist('gattungHistoryList', 'ml_gattungHistory');
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'maengelliste';
const STORE = 'entries';
const LISTS_STORE = 'lists';
const DB_VERSION = 2;
const DEFAULT_LIST_ID = 'default';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;

      let entryStore;
      if (!db.objectStoreNames.contains(STORE)) {
        entryStore = db.createObjectStore(STORE, { keyPath: 'id' });
        entryStore.createIndex('timestamp', 'timestamp');
      } else {
        entryStore = tx.objectStore(STORE);
      }
      if (!entryStore.indexNames.contains('listId')) {
        entryStore.createIndex('listId', 'listId');
      }

      let listStore;
      if (!db.objectStoreNames.contains(LISTS_STORE)) {
        listStore = db.createObjectStore(LISTS_STORE, { keyPath: 'id' });
      } else {
        listStore = tx.objectStore(LISTS_STORE);
      }

      // Migration von v1 (eine einzige Liste) auf v2 (mehrere Listen):
      // bestehende Einträge ohne listId bekommen eine Standardliste zugewiesen.
      if (event.oldVersion < 2) {
        const legacyTitle = localStorage.getItem('ml_firma') || 'Mängelliste';
        listStore.get(DEFAULT_LIST_ID).onsuccess = (ev) => {
          if (!ev.target.result) {
            listStore.put({ id: DEFAULT_LIST_ID, title: legacyTitle, createdAt: Date.now() });
          }
        };
        entryStore.openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) {
            const val = cursor.value;
            if (!val.listId) {
              val.listId = DEFAULT_LIST_ID;
              cursor.update(val);
            }
            cursor.continue();
          }
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function normalizeEntry(e) {
  const photos = Array.isArray(e.photos) ? e.photos.filter(Boolean).slice(0, 2) : (e.photo ? [e.photo] : []);
  return {
    ...e,
    photos,
    gattung: e.gattung || '',
    order: typeof e.order === 'number' ? e.order : e.timestamp,
    done: !!e.done,
  };
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('listId');
    const req = idx.getAll(IDBKeyRange.only(activeListId));
    req.onsuccess = () => resolve(req.result.map(normalizeEntry).sort((a, b) => a.order - b.order));
    req.onerror = () => reject(req.error);
  });
}

function nextOrder() {
  return cache.length ? Math.max(...cache.map(e => e.order ?? 0)) + 1 : 0;
}

async function dbPut(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteAllForList(listId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const idx = tx.objectStore(STORE).index('listId');
    const req = idx.openCursor(IDBKeyRange.only(listId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbCountForList(listId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('listId');
    const req = idx.count(IDBKeyRange.only(listId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Listen (mehrere Mängellisten) ---------- */
let activeListId = localStorage.getItem('ml_activeListId') || null;
let activeList = null;

async function dbListsAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LISTS_STORE, 'readonly');
    const req = tx.objectStore(LISTS_STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
    req.onerror = () => reject(req.error);
  });
}

async function dbListPut(list) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LISTS_STORE, 'readwrite');
    tx.objectStore(LISTS_STORE).put(list);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbListDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LISTS_STORE, 'readwrite');
    tx.objectStore(LISTS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadActiveList() {
  let lists = await dbListsAll();
  if (lists.length === 0) {
    const def = { id: DEFAULT_LIST_ID, title: localStorage.getItem('ml_firma') || 'Mängelliste', createdAt: Date.now() };
    await dbListPut(def);
    lists = [def];
  }
  if (!activeListId || !lists.some(l => l.id === activeListId)) {
    activeListId = lists[0].id;
    localStorage.setItem('ml_activeListId', activeListId);
  }
  activeList = lists.find(l => l.id === activeListId);
  document.getElementById('activeListTitle').textContent = activeList.title;
}

async function renderListsModal() {
  const lists = await dbListsAll();
  const ul = document.getElementById('listsUl');
  ul.innerHTML = '';
  for (const l of lists) {
    const count = await dbCountForList(l.id);
    const li = document.createElement('li');
    li.className = 'list-row' + (l.id === activeListId ? ' active' : '');
    li.dataset.id = l.id;
    li.innerHTML = `
      <button class="list-row-main" data-action="switch" type="button">${escapeHtml(l.title)} <span class="list-row-count">(${count})</span></button>
      <button class="list-row-icon" data-action="rename" type="button" title="Umbenennen" aria-label="Liste umbenennen">✏️</button>
      <button class="list-row-icon" data-action="clear" type="button" title="Liste leeren" aria-label="Liste leeren">🧹</button>
      <button class="list-row-icon" data-action="delete" type="button" title="Liste löschen" aria-label="Liste löschen">🗑️</button>`;
    ul.appendChild(li);
  }
}

document.getElementById('listSwitchBtn').addEventListener('click', async () => {
  await renderListsModal();
  document.getElementById('listsModal').classList.remove('hidden');
});
document.getElementById('listsModalCancel').addEventListener('click', () => {
  document.getElementById('listsModal').classList.add('hidden');
});
document.getElementById('listsModal').addEventListener('click', (e) => {
  if (e.target.id === 'listsModal') document.getElementById('listsModal').classList.add('hidden');
});

document.getElementById('newListBtn').addEventListener('click', async () => {
  const title = prompt('Titel der neuen Liste (z. B. Projektname):', '');
  if (title === null) return;
  const list = { id: uid(), title: title.trim() || 'Neue Liste', createdAt: Date.now() };
  await dbListPut(list);
  activeListId = list.id;
  localStorage.setItem('ml_activeListId', activeListId);
  await loadActiveList();
  document.getElementById('listsModal').classList.add('hidden');
  refreshList();
  showToast('Neue Liste angelegt.');
});

document.getElementById('listsUl').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('.list-row');
  const id = row.dataset.id;
  const action = btn.dataset.action;
  const lists = await dbListsAll();
  const list = lists.find(l => l.id === id);
  if (!list) return;

  if (action === 'switch') {
    activeListId = id;
    localStorage.setItem('ml_activeListId', id);
    await loadActiveList();
    document.getElementById('listsModal').classList.add('hidden');
    refreshList();
  } else if (action === 'rename') {
    const newTitle = prompt('Neuer Titel für diese Liste:', list.title);
    if (newTitle && newTitle.trim()) {
      list.title = newTitle.trim();
      await dbListPut(list);
      if (id === activeListId) await loadActiveList();
      renderListsModal();
    }
  } else if (action === 'clear') {
    if (confirm(`Alle Einträge in „${list.title}“ wirklich löschen? Die Liste selbst bleibt bestehen.`)) {
      await dbDeleteAllForList(id);
      if (id === activeListId) refreshList();
      renderListsModal();
      showToast('Liste geleert.');
    }
  } else if (action === 'delete') {
    if (lists.length <= 1) {
      showToast('Mindestens eine Liste muss bestehen bleiben.');
      return;
    }
    if (confirm(`Liste „${list.title}“ inkl. aller Einträge wirklich löschen?`)) {
      await dbDeleteAllForList(id);
      await dbListDelete(id);
      if (id === activeListId) {
        const remaining = await dbListsAll();
        activeListId = remaining[0].id;
        localStorage.setItem('ml_activeListId', activeListId);
        await loadActiveList();
        refreshList();
      }
      renderListsModal();
      showToast('Liste gelöscht.');
    }
  }
});

/* ---------- Utilities ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function showToast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function resizeImage(file, maxDim = 1280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else { width = Math.round(width * maxDim / height); height = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- View management ---------- */
const views = {
  list: document.getElementById('listView'),
  editor: document.getElementById('editorView'),
  settings: document.getElementById('settingsView'),
};
function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
  document.getElementById('addBtn').classList.toggle('hidden', name !== 'list');
}

/* ---------- List rendering ---------- */
let cache = [];

// Sortierung/Gruppierung ist rein fürs Anzeigen – die gespeicherte
// manuelle Reihenfolge (entry.order) bleibt dabei unangetastet, damit man
// jederzeit zurück zu "Manuell" wechseln kann, ohne etwas zu verlieren.
let sortMode = localStorage.getItem('ml_sortMode') || 'manual';
if (!['manual', 'ort', 'text'].includes(sortMode)) sortMode = 'manual';

function localeCompareDe(a, b) {
  return (a || '').localeCompare(b || '', 'de', { sensitivity: 'base', numeric: true });
}

function sortedForDisplay(entries, mode) {
  const arr = entries.slice();
  if (mode === 'text') {
    arr.sort((a, b) => localeCompareDe(a.rohtext, b.rohtext));
  } else if (mode === 'ort') {
    arr.sort((a, b) => {
      const oa = a.ort || '';
      const ob = b.ort || '';
      if (!oa && ob) return 1;
      if (oa && !ob) return -1;
      const c = localeCompareDe(oa, ob);
      if (c !== 0) return c;
      return localeCompareDe(a.rohtext, b.rohtext);
    });
  }
  return arr;
}

const sortModeSelect = document.getElementById('sortModeSelect');
sortModeSelect.value = sortMode;
sortModeSelect.addEventListener('change', () => {
  sortMode = sortModeSelect.value;
  localStorage.setItem('ml_sortMode', sortMode);
  refreshList();
});

async function refreshList() {
  cache = await dbAll();
  const list = document.getElementById('entryList');
  const empty = document.getElementById('emptyState');
  const exportBar = document.getElementById('exportBar');
  const progressSummary = document.getElementById('progressSummary');
  list.innerHTML = '';
  document.getElementById('addBtn').classList.toggle('raised', cache.length > 0);
  if (cache.length === 0) {
    empty.classList.remove('hidden');
    exportBar.classList.add('hidden');
    progressSummary.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  exportBar.classList.remove('hidden');

  const doneCount = cache.filter(e => e.done).length;
  progressSummary.classList.remove('hidden');
  document.getElementById('progressSummaryText').innerHTML =
    `<strong>${doneCount}</strong> von ${cache.length} erledigt`;
  document.getElementById('progressFill').style.width = `${Math.round((doneCount / cache.length) * 100)}%`;

  const manual = sortMode === 'manual';
  const displayEntries = manual ? cache : sortedForDisplay(cache, sortMode);
  let lastGroupKey;

  displayEntries.forEach(entry => {
    if (sortMode === 'ort') {
      const groupKey = entry.ort || 'Ohne Ortsangabe';
      if (groupKey !== lastGroupKey) {
        lastGroupKey = groupKey;
        const header = document.createElement('li');
        header.className = 'group-header';
        header.textContent = groupKey;
        list.appendChild(header);
      }
    }

    const li = document.createElement('li');
    li.className = 'entry-card' + (entry.done ? ' done' : '');
    li.dataset.id = entry.id;
    const photosHtml = entry.photos.map(p => `<img src="${p}" alt="">`).join('');
    li.innerHTML = `
      <button class="done-toggle" data-action="toggle-done" title="${entry.done ? 'Als offen markieren' : 'Als erledigt markieren'}" aria-label="Erledigt umschalten">✓</button>
      ${manual ? `<span class="drag-handle" title="Ziehen zum Verschieben" aria-label="Ziehen zum Verschieben">≡</span>` : ''}
      ${photosHtml ? `<div class="entry-photos">${photosHtml}</div>` : ''}
      <div class="entry-body">
        <div class="entry-tags">
          ${entry.ort ? `<span class="entry-ort">${escapeHtml(entry.ort)}</span>` : ''}
          ${entry.gattung ? `<span class="entry-gattung">${escapeHtml(entry.gattung)}</span>` : ''}
        </div>
        <p class="entry-text">${escapeHtml(entry.rohtext)}</p>
        <div class="entry-meta">${formatDate(entry.timestamp)}${entry.done ? ' · Erledigt' : ''}</div>
      </div>
      <div class="entry-actions">
        <button data-action="edit" title="Bearbeiten">✏️</button>
        <button data-action="delete" title="Löschen">🗑️</button>
      </div>`;
    li.querySelector('[data-action="toggle-done"]').addEventListener('click', async () => {
      entry.done = !entry.done;
      await dbPut(entry);
      refreshList();
    });
    li.querySelector('[data-action="edit"]').addEventListener('click', () => openEditor(entry));
    li.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (confirm('Diesen Mangel wirklich löschen?')) {
        await dbDelete(entry.id);
        refreshList();
      }
    });
    if (manual) makeDraggable(li);
    list.appendChild(li);
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Liste per Drag & Drop sortieren ---------- */
function persistNewOrder() {
  const ids = Array.from(document.getElementById('entryList').children).map(li => li.dataset.id);
  ids.forEach((id, idx) => {
    const entry = cache.find(e => e.id === id);
    if (entry) entry.order = idx;
  });
  cache.sort((a, b) => a.order - b.order);
  ids.forEach(async (id) => {
    const entry = cache.find(e => e.id === id);
    if (entry) await dbPut(entry);
  });
}

// Findet die Zielposition anhand der vertikalen Mitte jeder Karte statt eines
// einzelnen (x,y)-Treffpunkts. So wird auch getroffen, wenn der Zeigepunkt
// zwischen zwei Karten (im Abstand) oder über einem Foto/Icon liegt.
function findDropTarget(list, dragged, clientY) {
  const siblings = Array.from(list.children).filter(c => c !== dragged);
  for (const sib of siblings) {
    const rect = sib.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return sib;
  }
  return null; // ans Ende einsortieren
}

// Scrollt die Seite automatisch weiter, wenn beim Ziehen der Rand des
// Bildschirms erreicht wird (z. B. um einen Eintrag ans Ende einer langen
// Liste zu verschieben, die nicht komplett sichtbar ist).
function makeAutoScroller() {
  const EDGE = 90;
  const MAX_SPEED = 16;
  let clientY = null;
  let rafId = null;

  function tick() {
    if (clientY !== null) {
      const vh = window.innerHeight;
      let dy = 0;
      if (clientY < EDGE) {
        dy = -MAX_SPEED * (1 - clientY / EDGE);
      } else if (clientY > vh - EDGE) {
        dy = MAX_SPEED * (1 - (vh - clientY) / EDGE);
      }
      if (dy !== 0) window.scrollBy(0, dy);
    }
    rafId = requestAnimationFrame(tick);
  }

  return {
    start() { if (rafId === null) rafId = requestAnimationFrame(tick); },
    update(y) { clientY = y; },
    stop() { if (rafId !== null) cancelAnimationFrame(rafId); rafId = null; clientY = null; },
  };
}

function makeDraggable(li) {
  const handle = li.querySelector('.drag-handle');
  const autoScroller = makeAutoScroller();
  let startY = 0;
  let pointerId = null;

  function onMove(e) {
    if (pointerId === null || e.pointerId !== pointerId) return;
    // li bleibt im normalen Fluss der Liste, scrollt also automatisch mit der
    // Seite mit; translateY ist nur der Offset relativ zur Startposition.
    li.style.transform = `translateY(${e.clientY - startY}px)`;

    autoScroller.update(e.clientY);

    const list = li.parentElement;
    const target = findDropTarget(list, li, e.clientY);
    if (target !== li.nextSibling && target !== li) {
      if (target) list.insertBefore(li, target);
      else list.appendChild(li);
      startY = e.clientY;
      li.style.transform = 'translateY(0px)';
    }
  }

  function onUp(e) {
    if (pointerId === null || (e && e.pointerId !== undefined && e.pointerId !== pointerId)) return;
    pointerId = null;
    autoScroller.stop();
    li.classList.remove('dragging');
    li.style.transform = '';
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
    persistNewOrder();
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // nur linke Maustaste / primärer Touch
    e.preventDefault();
    pointerId = e.pointerId;
    startY = e.clientY;
    li.classList.add('dragging');
    autoScroller.start();
    // Bewusst NICHT setPointerCapture(handle): wird die Karte während des
    // Ziehens im DOM neu einsortiert (list.insertBefore), geben manche
    // Browser die Pointer-Capture unbemerkt frei – danach kommt kein
    // pointerup mehr an, Auto-Scroll läuft endlos weiter und die Karte
    // bleibt "hängen" (blockiert die Seite). Listener auf document sind
    // davon unabhängig und funktionieren unabhängig von Capture-Verlust.
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    // Sicherheitsnetz: falls der Browser das pointerup verschluckt (z. B.
    // Fenster verliert beim Loslassen den Fokus), Drag trotzdem beenden.
    window.addEventListener('blur', onUp);
  });
}

/* ---------- Editor ---------- */
let currentPhotos = [null, null];
let editingId = null;

function setPhotoSlot(idx, dataUrl) {
  currentPhotos[idx] = dataUrl;
  const img = document.getElementById(`photoPreview${idx + 1}`);
  const placeholder = document.getElementById(`photoPlaceholder${idx + 1}`);
  const removeBtn = document.getElementById(`photoRemove${idx + 1}`);
  if (dataUrl) {
    img.src = dataUrl;
    img.classList.remove('hidden');
    placeholder.classList.add('hidden');
    removeBtn.classList.remove('hidden');
  } else {
    img.src = '';
    img.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.add('hidden');
  }
}

function resetEditor() {
  setPhotoSlot(0, null);
  setPhotoSlot(1, null);
  document.getElementById('ortInput').value = '';
  document.getElementById('gattungInput').value = '';
  document.getElementById('rohtextInput').value = '';
  document.getElementById('editorError').classList.add('hidden');
  updateEditorState();
}

function fillEditor(entry) {
  document.getElementById('ortInput').value = entry.ort || '';
  document.getElementById('gattungInput').value = entry.gattung || '';
  document.getElementById('rohtextInput').value = entry.rohtext || '';
  setPhotoSlot(0, entry.photos[0] || null);
  setPhotoSlot(1, entry.photos[1] || null);
}

function openEditor(entry) {
  editingId = entry ? entry.id : null;
  resetEditor();
  if (entry) fillEditor(entry);
  document.getElementById('editorTitle').textContent = entry ? 'Mangel bearbeiten' : 'Neuer Mangel';
  refreshHistoryDatalists();
  updateEditorState();
  showView('editor');
}

function updateEditorState() {
  const hasText = document.getElementById('rohtextInput').value.trim().length > 0;
  document.getElementById('editorSave').disabled = !hasText;
}

document.getElementById('addBtn').addEventListener('click', () => openEditor(null));
document.getElementById('editorCancel').addEventListener('click', () => showView('list'));

[0, 1].forEach(idx => {
  const n = idx + 1;
  document.getElementById(`photoPreviewWrap${n}`).addEventListener('click', (e) => {
    if (e.target.closest('.photo-remove')) return;
    document.getElementById(`photoInput${n}`).click();
  });
  document.getElementById(`photoInput${n}`).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file);
      setPhotoSlot(idx, dataUrl);
    } catch (err) {
      showToast('Foto konnte nicht geladen werden.');
    }
  });
  document.getElementById(`photoRemove${n}`).addEventListener('click', (e) => {
    e.stopPropagation();
    setPhotoSlot(idx, null);
  });
});

document.getElementById('rohtextInput').addEventListener('input', updateEditorState);

document.getElementById('editorSave').addEventListener('click', async () => {
  const ort = document.getElementById('ortInput').value.trim();
  const gattung = document.getElementById('gattungInput').value.trim();
  const rohtext = document.getElementById('rohtextInput').value.trim();
  const existing = editingId ? cache.find(e => e.id === editingId) : null;
  const entry = {
    id: editingId || uid(),
    listId: existing ? (existing.listId || activeListId) : activeListId,
    timestamp: existing ? existing.timestamp : Date.now(),
    order: existing ? existing.order : nextOrder(),
    done: existing ? existing.done : false,
    ort,
    gattung,
    rohtext,
    photos: currentPhotos.filter(Boolean),
  };
  await dbPut(entry);
  addHistory('ml_ortHistory', ort);
  addHistory('ml_gattungHistory', gattung);
  addHistory('ml_rohtextHistory', rohtext);
  const wasEditing = !!editingId;
  editingId = null;
  showView('list');
  refreshList();
  showToast(wasEditing ? 'Mangel aktualisiert.' : 'Mangel gespeichert.');
});

/* ---------- Settings ---------- */
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('emailInput').value = Settings.email;
  document.getElementById('xlsxProtectInput').checked = Settings.xlsxProtect;
  document.getElementById('xlsxPasswordInput').value = Settings.xlsxPassword;
  renderPhotoSizeChooser();
  showView('settings');
});
document.getElementById('settingsCancel').addEventListener('click', () => showView('list'));
document.getElementById('settingsSave').addEventListener('click', () => {
  Settings.email = document.getElementById('emailInput').value.trim();
  Settings.xlsxProtect = document.getElementById('xlsxProtectInput').checked;
  Settings.xlsxPassword = document.getElementById('xlsxPasswordInput').value.trim();
  showView('list');
  showToast('Einstellungen gespeichert.');
});

/* ---------- Export: PDF ---------- */
function buildPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentW = pageW - 2 * margin;
  const photoGap = 8;
  const photoWidth = PHOTO_SIZES[Settings.photoSize].pdfWidth;

  // Gleiche Sortierung/Gruppierung wie in der App (Reihenfolge, nach
  // Ort/Bereich oder alphabetisch) statt immer der Rohreihenfolge.
  const displayEntries = sortMode === 'manual' ? cache : sortedForDisplay(cache, sortMode);
  const doneCount = cache.filter(e => e.done).length;
  const sortLabel = { manual: 'Reihenfolge', ort: 'nach Ort/Bereich gruppiert', text: 'alphabetisch (A–Z)' }[sortMode] || '';

  const NAVY = [30, 41, 59];
  const BLUE = [37, 99, 235];
  const GREEN = [22, 163, 74];
  const MUTED = [100, 116, 139];
  const BORDER = [226, 232, 240];
  const ROOM_BAND = [220, 231, 250];
  const CARD_BG = [250, 251, 253];
  const CARD_BG_DONE = [244, 247, 245];

  const title = activeList && activeList.title ? `Mängelliste – ${activeList.title}` : 'Mängelliste';
  let y = margin;
  let pageNum = 1;
  let lastGroupKey;
  let groupHeaderDrawnOnPage = false;

  function drawFooter() {
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`Seite ${pageNum}`, pageW - margin, pageH - 20, { align: 'right' });
    doc.text(title, margin, pageH - 20);
    doc.setTextColor(20, 20, 20);
  }

  function newPage() {
    drawFooter();
    doc.addPage();
    pageNum++;
    y = margin;
    groupHeaderDrawnOnPage = false;
  }

  function ensureSpace(neededH) {
    if (y + neededH > pageH - margin - 24) newPage();
  }

  function drawTopBanner() {
    doc.setFillColor(...NAVY);
    doc.rect(0, 0, pageW, 46, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont(undefined, 'bold');
    doc.setFontSize(16);
    doc.text(doc.splitTextToSize(title, contentW), margin, 29);

    doc.setFillColor(...BLUE);
    doc.rect(0, 46, pageW, 22, 'F');
    doc.setFont(undefined, 'italic');
    doc.setFontSize(9);
    doc.text(
      `Erstellt am ${new Date().toLocaleDateString('de-DE')} · ${cache.length} Punkt(e) · ${doneCount} erledigt · Sortierung: ${sortLabel}`,
      margin, 61
    );
    doc.setFont(undefined, 'normal');
    doc.setTextColor(20, 20, 20);
    y = 46 + 22 + 18;
  }

  function drawCheckbox(x, top, done) {
    const size = 11;
    doc.setLineWidth(1);
    if (done) {
      doc.setFillColor(...GREEN);
      doc.setDrawColor(...GREEN);
      doc.roundedRect(x, top, size, size, 2, 2, 'FD');
      doc.setDrawColor(255, 255, 255);
      doc.setLineWidth(1.3);
      doc.line(x + 2.3, top + 5.8, x + 4.6, top + 8.2);
      doc.line(x + 4.6, top + 8.2, x + 8.8, top + 3);
    } else {
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(...BORDER);
      doc.roundedRect(x, top, size, size, 2, 2, 'FD');
    }
    doc.setLineWidth(0.5);
    doc.setDrawColor(...BORDER);
  }

  function drawGroupHeader(key, continued) {
    ensureSpace(30);
    doc.setFillColor(...ROOM_BAND);
    doc.rect(margin, y, contentW, 22, 'F');
    doc.setFont(undefined, 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    doc.text(key + (continued ? ' (Fortsetzung)' : ''), margin + 10, y + 15);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(20, 20, 20);
    y += 22 + 10;
    groupHeaderDrawnOnPage = true;
    lastGroupKey = key;
  }

  drawTopBanner();

  displayEntries.forEach((entry, idx) => {
    if (sortMode === 'ort') {
      const groupKey = entry.ort || 'Ohne Ortsangabe';
      if (groupKey !== lastGroupKey) drawGroupHeader(groupKey, false);
      else if (!groupHeaderDrawnOnPage) drawGroupHeader(groupKey, true);
    }

    const photoBlocks = [];
    (entry.photos || []).forEach(p => {
      try {
        const props = doc.getImageProperties(p);
        photoBlocks.push({ photo: p, h: (props.height / props.width) * photoWidth });
      } catch (e) { /* Foto nicht lesbar, überspringen */ }
    });
    const colH = photoBlocks.reduce((sum, b) => sum + b.h, 0) + (photoBlocks.length > 1 ? photoGap : 0);

    const padLeft = 16;
    const checkboxW = 17;
    const textX = margin + padLeft + checkboxW + (photoBlocks.length ? photoWidth + 14 : 0);
    const textW = pageW - margin - padLeft - textX;
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(entry.rohtext, textW);

    const blockH = Math.max(colH, lines.length * 13, 20) + 34;
    ensureSpace(blockH);

    const top = y;
    doc.setFillColor(...(entry.done ? CARD_BG_DONE : CARD_BG));
    doc.roundedRect(margin, top, contentW, blockH, 6, 6, 'F');
    doc.setFillColor(...(entry.done ? GREEN : BLUE));
    doc.roundedRect(margin, top, 4, blockH, 2, 2, 'F');

    drawCheckbox(margin + padLeft, top + 13, entry.done);

    let cy = top + 22;
    doc.setFont(undefined, 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...(entry.done ? MUTED : NAVY));
    const headerParts = [entry.ort || 'Ohne Ortsangabe'];
    if (entry.gattung) headerParts.push(entry.gattung);
    doc.text(`${idx + 1}. ${headerParts.join(' · ')}`, margin + padLeft + checkboxW, cy);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(
      formatDate(entry.timestamp) + (entry.done ? ' · Erledigt' : ''),
      pageW - margin - padLeft, cy, { align: 'right' }
    );

    const textTop = cy + 14;
    doc.setFontSize(11);
    doc.setTextColor(...(entry.done ? MUTED : [20, 20, 20]));
    doc.text(lines, textX, textTop);
    if (entry.done) {
      doc.setDrawColor(...MUTED);
      doc.setLineWidth(0.7);
      lines.forEach((line, li) => {
        const lw = doc.getTextWidth(line);
        const ly = textTop + li * 13 - 3.5;
        doc.line(textX, ly, textX + lw, ly);
      });
    }
    doc.setTextColor(20, 20, 20);

    let imgY = top + 22;
    photoBlocks.forEach(b => {
      try { doc.addImage(b.photo, 'JPEG', margin + padLeft + checkboxW, imgY, photoWidth, b.h); } catch (e) {}
      imgY += b.h + photoGap;
    });

    y = top + blockH + 12;
  });

  drawFooter();
  return doc;
}

function pdfFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = ((activeList && activeList.title) || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  return `${base}_${stamp}.pdf`;
}

document.getElementById('exportPdfBtn').addEventListener('click', () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  const doc = buildPdf();
  doc.save(pdfFileName());
});

/* ---------- Datei-Download-Helfer ---------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function xlsxFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = ((activeList && activeList.title) || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  return `${base}_${stamp}.xlsx`;
}

/* ---------- Export: Excel (mit eingebetteten Fotos) ---------- */
document.getElementById('exportXlsxBtn').addEventListener('click', async () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  showToast('Excel wird erstellt …', 2000);

  // Gleiche Sortierung/Gruppierung wie in der Listenansicht (Reihenfolge,
  // nach Ort/Bereich oder alphabetisch) – nicht immer die Rohreihenfolge.
  const displayEntries = sortMode === 'manual' ? cache : sortedForDisplay(cache, sortMode);

  const imgW = PHOTO_SIZES[Settings.photoSize].xlsxWidth;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mängelliste', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ showGridLines: false }],
  });

  const photoColW = Math.max(10, Math.round(imgW / 7));
  const columns = [
    { key: 'nr', width: 6 },
    { key: 'status', width: 12 },
    { key: 'gattung', width: 16 },
    { key: 'ort', width: 18 },
    { key: 'beschreibung', width: 48 },
    { key: 'foto1', width: photoColW },
    { key: 'foto2', width: photoColW },
    { key: 'datum', width: 12 },
  ];
  ws.columns = columns;
  const colCount = columns.length;
  const colIndexOf = (key) => columns.findIndex(c => c.key === key);

  const NAVY = 'FF1E293B';
  const BLUE = 'FF2563EB';
  const BLUE_LIGHT = 'FFEFF4FF';
  const GREEN = 'FF16A34A';
  const GREEN_LIGHT = 'FFDCFCE7';
  const MUTED = 'FF64748B';
  const ROOM_BAND = 'FFDCE7FA';
  const STRIPE = 'FFF7F9FC';
  const STRIPE_DONE = 'FFF1F5F1';
  const BORDER = 'FFE2E8F0';
  const thinBorder = { style: 'thin', color: { argb: BORDER } };
  const cellBorder = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  ws.mergeCells(1, 1, 1, colCount);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = activeList && activeList.title ? `Mängelliste – ${activeList.title}` : 'Mängelliste';
  titleCell.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 34;
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };

  const sortLabel = { manual: 'Reihenfolge', ort: 'nach Ort/Bereich gruppiert', text: 'alphabetisch (A–Z)' }[sortMode] || '';
  const doneCount = cache.filter(en => en.done).length;
  ws.mergeCells(2, 1, 2, colCount);
  const subCell = ws.getCell(2, 1);
  subCell.value = `Erstellt am ${new Date().toLocaleDateString('de-DE')} · ${cache.length} Punkt(e) · ${doneCount} erledigt · Sortierung: ${sortLabel}`;
  subCell.font = { italic: true, size: 10, color: { argb: 'FFFFFFFF' } };
  subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;
  ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };

  const headerRowIdx = 3;
  const headerRow = ws.getRow(headerRowIdx);
  headerRow.values = ['Nr.', 'Status', 'Arbeitsgattung', 'Ort / Bereich', 'Beschreibung', 'Foto 1', 'Foto 2', 'Datum'];
  headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.getCell(colIndexOf('beschreibung') + 1).alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;
  headerRow.eachCell(cell => { cell.border = cellBorder; });

  ws.views = [{ showGridLines: false, state: 'frozen', ySplit: headerRowIdx }];
  ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: colCount } };
  ws.pageSetup.printTitlesRow = `${headerRowIdx}:${headerRowIdx}`;

  let rowIdx = headerRowIdx;
  let nr = 0;
  let lastGroupKey; // nur relevant bei sortMode === 'ort'

  for (const e of displayEntries) {
    if (sortMode === 'ort') {
      const groupKey = e.ort || 'Ohne Ortsangabe';
      if (groupKey !== lastGroupKey) {
        lastGroupKey = groupKey;
        rowIdx++;
        ws.mergeCells(rowIdx, 1, rowIdx, colCount);
        const groupCell = ws.getCell(rowIdx, 1);
        groupCell.value = `📍 ${groupKey}`;
        groupCell.font = { bold: true, size: 11, color: { argb: NAVY } };
        groupCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        ws.getRow(rowIdx).height = 22;
        ws.getRow(rowIdx).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROOM_BAND } };
      }
    }

    rowIdx++;
    nr++;
    const row = ws.getRow(rowIdx);
    row.values = {
      nr,
      status: e.done ? '✔ Erledigt' : 'Offen',
      gattung: e.gattung || '',
      ort: e.ort || '',
      beschreibung: e.rohtext,
      foto1: e.photos[0] ? '' : '–',
      foto2: e.photos[1] ? '' : '–',
      datum: formatDate(e.timestamp),
    };
    row.alignment = { vertical: 'middle', wrapText: true };
    row.getCell(colIndexOf('nr') + 1).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(colIndexOf('status') + 1).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(colIndexOf('datum') + 1).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(colIndexOf('foto1') + 1).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(colIndexOf('foto2') + 1).alignment = { vertical: 'middle', horizontal: 'center' };
    row.eachCell({ includeEmpty: true }, cell => { cell.border = cellBorder; });
    if (nr % 2 === 0) {
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: e.done ? STRIPE_DONE : STRIPE } };
      });
    }
    if (e.gattung) {
      row.getCell(colIndexOf('gattung') + 1).font = { color: { argb: BLUE }, bold: true, size: 10 };
      row.getCell(colIndexOf('gattung') + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE_LIGHT } };
    }
    const statusCell = row.getCell(colIndexOf('status') + 1);
    if (e.done) {
      statusCell.font = { color: { argb: GREEN }, bold: true, size: 10 };
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_LIGHT } };
      row.getCell(colIndexOf('beschreibung') + 1).font = { strike: true, color: { argb: MUTED } };
    } else {
      statusCell.font = { color: { argb: MUTED }, size: 10 };
    }

    let maxImgH = 20;
    for (const [photoIdx, colKey] of [[0, 'foto1'], [1, 'foto2']]) {
      const photo = e.photos[photoIdx];
      if (!photo) continue;
      try {
        const dims = await getImageDimensions(photo);
        const imgH = imgW * (dims.height / dims.width);
        const imageId = wb.addImage({ base64: photo, extension: 'jpeg' });
        const colIndex = colIndexOf(colKey);
        ws.addImage(imageId, { tl: { col: colIndex, row: rowIdx - 1 }, ext: { width: imgW, height: imgH } });
        maxImgH = Math.max(maxImgH, imgH * 0.75);
      } catch (err) { /* Foto überspringen */ }
    }
    row.height = maxImgH;
  }

  // Schreibschutz: alle Zellen sind in ExcelJS standardmäßig "locked" –
  // erst das Schützen des Arbeitsblatts aktiviert das auch tatsächlich.
  // Kein starker Verschlüsselungsschutz, sondern wie Excels "Blatt schützen".
  let usedPassword = null;
  if (Settings.xlsxProtect) {
    usedPassword = Settings.xlsxPassword || DEFAULT_XLSX_PASSWORD;
    await ws.protect(usedPassword, {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatCells: false,
      formatColumns: false,
      formatRows: false,
      insertColumns: false,
      insertRows: false,
      insertHyperlinks: false,
      deleteColumns: false,
      deleteRows: false,
      sort: false,
      autoFilter: true,
      pivotTables: false,
      objects: false,
      scenarios: false,
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  downloadBlob(blob, xlsxFileName());
  showToast(usedPassword
    ? `Excel-Datei gespeichert – schreibgeschützt (Passwort: ${usedPassword}).`
    : 'Excel-Datei mit Fotos gespeichert.', 4500);
});

/* ---------- Backup: Sichern (JSON inkl. Fotos) ---------- */
function backupFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = ((activeList && activeList.title) || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  return `${base}_Backup_${stamp}.json`;
}

document.getElementById('backupSaveBtn').addEventListener('click', () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  const payload = {
    type: 'maengelliste-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: cache,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  downloadBlob(blob, backupFileName());
  showToast('Backup gespeichert (inkl. Fotos).');
});

/* ---------- Export: E-Mail (mit Anbieter-Auswahl) ---------- */
document.getElementById('exportEmailBtn').addEventListener('click', () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  document.getElementById('emailChooser').classList.remove('hidden');
});
document.getElementById('emailChooserCancel').addEventListener('click', () => {
  document.getElementById('emailChooser').classList.add('hidden');
});
document.getElementById('emailChooser').addEventListener('click', (e) => {
  if (e.target.id === 'emailChooser') document.getElementById('emailChooser').classList.add('hidden');
});
document.querySelectorAll('.modal-option').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.getElementById('emailChooser').classList.add('hidden');
    await sendEmail(btn.dataset.mode);
  });
});

async function sendEmail(mode) {
  const doc = buildPdf();
  const fileName = pdfFileName();
  const subject = activeList && activeList.title ? `Mängelliste – ${activeList.title}` : 'Mängelliste';
  const bodyEntries = sortMode === 'manual' ? cache : sortedForDisplay(cache, sortMode);
  const bodyLines = bodyEntries.map((e, i) =>
    `${i + 1}. [${e.done ? 'x' : ' '}] ${e.ort ? e.ort + ': ' : ''}${e.rohtext}`);
  const body = bodyLines.join('\n');

  if (mode === 'share') {
    const blob = doc.output('blob');
    const file = new File([blob], fileName, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: subject, text: body });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    showToast('Teilen ist auf diesem Gerät nicht verfügbar. Bitte eine andere Option wählen.', 4000);
    return;
  }

  // Gmail/Outlook/Standard-Mail-App können über einen Link keinen Anhang setzen -> PDF vorher herunterladen
  doc.save(fileName);
  showToast('PDF heruntergeladen – bitte in der E-Mail manuell anhängen.', 4000);

  const encSub = encodeURIComponent(subject);
  const encBody = encodeURIComponent(body + '\n\n(Bitte die heruntergeladene PDF-Datei manuell anhängen.)');
  const encTo = encodeURIComponent(Settings.email);

  if (mode === 'gmail') {
    window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encTo}&su=${encSub}&body=${encBody}`, '_blank');
  } else if (mode === 'outlook') {
    window.open(`https://outlook.live.com/mail/0/deeplink/compose?to=${encTo}&subject=${encSub}&body=${encBody}`, '_blank');
  } else {
    window.location.href = `mailto:${encTo}?subject=${encSub}&body=${encBody}`;
  }
}

/* ---------- Import: Excel ---------- */
function parseGermanDate(str) {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec((str || '').trim());
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return isNaN(d.getTime()) ? null : d.getTime();
}

function cellValue(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importInput').click();
});

document.getElementById('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  try {
    if (/\.json$/i.test(file.name)) {
      await importBackup(file);
    } else {
      await importExcel(file);
    }
  } catch (err) {
    showToast('Import fehlgeschlagen: ' + err.message, 4000);
  }
});

async function importExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];

  // Unsere Excel-Exporte haben ein Titelbanner über den echten Spaltenköpfen -
  // die Kopfzeile automatisch finden, damit auch ältere Exporte (ohne Banner) funktionieren.
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const headerRowIndex = rawRows.findIndex(r => r.some(cell => String(cell).trim() === 'Beschreibung'));
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', range: headerRowIndex >= 0 ? headerRowIndex : 0 });

  const base = nextOrder();
  let imported = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rohtext = cellValue(row, 'Beschreibung', 'Freundliche Formulierung', 'Ursprüngliche Notiz');
    if (!rohtext) continue;
    const ort = cellValue(row, 'Ort / Bereich', 'Ort');
    const gattung = cellValue(row, 'Arbeitsgattung', 'Gattung');
    const dateStr = cellValue(row, 'Datum');
    const timestamp = parseGermanDate(dateStr) ?? (Date.now() + imported);
    const done = /erledigt/i.test(cellValue(row, 'Status'));

    const entry = { id: uid(), listId: activeListId, timestamp, order: base + imported, done, ort, gattung, rohtext, photos: [] };
    await dbPut(entry);
    addHistory('ml_ortHistory', ort);
    addHistory('ml_gattungHistory', gattung);
    addHistory('ml_rohtextHistory', rohtext);
    imported++;
  }

  refreshList();
  showToast(imported > 0 ? `${imported} Eintrag/Einträge importiert (ohne Fotos).` : 'Keine passenden Zeilen in der Datei gefunden.', 3500);
}

async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const entries = Array.isArray(data) ? data : (data.entries || []);

  const base = nextOrder();
  let imported = 0;
  for (const e of entries) {
    if (!e || !e.rohtext) continue;
    const photos = Array.isArray(e.photos) ? e.photos.filter(Boolean).slice(0, 2) : (e.photo ? [e.photo] : []);
    const entry = {
      id: uid(),
      listId: activeListId,
      timestamp: e.timestamp || Date.now(),
      order: base + imported,
      done: !!e.done,
      ort: e.ort || '',
      gattung: e.gattung || '',
      rohtext: e.rohtext,
      photos,
    };
    await dbPut(entry);
    addHistory('ml_ortHistory', entry.ort);
    addHistory('ml_gattungHistory', entry.gattung);
    addHistory('ml_rohtextHistory', entry.rohtext);
    imported++;
  }

  refreshList();
  showToast(imported > 0 ? `${imported} Eintrag/Einträge aus Backup geladen (inkl. Fotos).` : 'Keine Einträge im Backup gefunden.', 3500);
}

/* ---------- Init ---------- */
(async () => {
  await loadActiveList();
  refreshList();
})();
