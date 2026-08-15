'use strict';

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

/* ---------- Settings (localStorage) ---------- */
const Settings = {
  get email() { return localStorage.getItem('ml_email') || ''; },
  set email(v) { localStorage.setItem('ml_email', v || ''); },
  get firma() { return localStorage.getItem('ml_firma') || ''; },
  set firma(v) { localStorage.setItem('ml_firma', v || ''); },
};

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
}

/* ---------- IndexedDB ---------- */
const DB_NAME = 'maengelliste';
const STORE = 'entries';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.timestamp - b.timestamp));
    req.onerror = () => reject(req.error);
  });
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

async function refreshList() {
  cache = await dbAll();
  const list = document.getElementById('entryList');
  const empty = document.getElementById('emptyState');
  const exportBar = document.getElementById('exportBar');
  list.innerHTML = '';
  document.getElementById('addBtn').classList.toggle('raised', cache.length > 0);
  if (cache.length === 0) {
    empty.classList.remove('hidden');
    exportBar.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  exportBar.classList.remove('hidden');
  cache.slice().reverse().forEach(entry => {
    const li = document.createElement('li');
    li.className = 'entry-card';
    li.innerHTML = `
      ${entry.photo ? `<img src="${entry.photo}" alt="">` : ''}
      <div class="entry-body">
        ${entry.ort ? `<div class="entry-ort">${escapeHtml(entry.ort)}</div>` : ''}
        <p class="entry-text">${escapeHtml(entry.rohtext)}</p>
        <div class="entry-meta">${formatDate(entry.timestamp)}</div>
      </div>
      <div class="entry-actions">
        <button data-action="edit" title="Bearbeiten">✏️</button>
        <button data-action="delete" title="Löschen">🗑️</button>
      </div>`;
    li.querySelector('[data-action="edit"]').addEventListener('click', () => openEditor(entry));
    li.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (confirm('Diesen Mangel wirklich löschen?')) {
        await dbDelete(entry.id);
        refreshList();
      }
    });
    list.appendChild(li);
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Editor ---------- */
let currentPhotoDataUrl = null;
let editingId = null;

function resetEditor() {
  currentPhotoDataUrl = null;
  document.getElementById('photoPreview').classList.add('hidden');
  document.getElementById('photoPreview').src = '';
  document.getElementById('photoPlaceholder').classList.remove('hidden');
  document.getElementById('ortInput').value = '';
  document.getElementById('rohtextInput').value = '';
  document.getElementById('editorError').classList.add('hidden');
  updateEditorState();
}

function fillEditor(entry) {
  document.getElementById('ortInput').value = entry.ort || '';
  document.getElementById('rohtextInput').value = entry.rohtext || '';
  currentPhotoDataUrl = entry.photo || null;
  const img = document.getElementById('photoPreview');
  const placeholder = document.getElementById('photoPlaceholder');
  if (currentPhotoDataUrl) {
    img.src = currentPhotoDataUrl;
    img.classList.remove('hidden');
    placeholder.classList.add('hidden');
  }
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

document.getElementById('photoPreviewWrap').addEventListener('click', () => {
  document.getElementById('photoInput').click();
});
document.getElementById('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    currentPhotoDataUrl = await resizeImage(file);
    const img = document.getElementById('photoPreview');
    img.src = currentPhotoDataUrl;
    img.classList.remove('hidden');
    document.getElementById('photoPlaceholder').classList.add('hidden');
  } catch (err) {
    showToast('Foto konnte nicht geladen werden.');
  }
});

document.getElementById('rohtextInput').addEventListener('input', updateEditorState);

document.getElementById('editorSave').addEventListener('click', async () => {
  const ort = document.getElementById('ortInput').value.trim();
  const rohtext = document.getElementById('rohtextInput').value.trim();
  const existing = editingId ? cache.find(e => e.id === editingId) : null;
  const entry = {
    id: editingId || uid(),
    timestamp: existing ? existing.timestamp : Date.now(),
    ort,
    rohtext,
    photo: currentPhotoDataUrl,
  };
  await dbPut(entry);
  addHistory('ml_ortHistory', ort);
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
  document.getElementById('firmaInput').value = Settings.firma;
  showView('settings');
});
document.getElementById('settingsCancel').addEventListener('click', () => showView('list'));
document.getElementById('settingsSave').addEventListener('click', () => {
  Settings.email = document.getElementById('emailInput').value.trim();
  Settings.firma = document.getElementById('firmaInput').value.trim();
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
  let y = margin;

  const title = Settings.firma ? `Mängelliste – ${Settings.firma}` : 'Mängelliste';
  doc.setFontSize(18);
  doc.text(title, margin, y);
  y += 18;
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Erstellt am ${new Date().toLocaleDateString('de-DE')} · ${cache.length} Punkt(e)`, margin, y);
  doc.setTextColor(20);
  y += 26;

  cache.forEach((entry, idx) => {
    const blockPhotoH = entry.photo ? 160 : 0;
    const estBlockH = 30 + blockPhotoH + 60;
    if (y + estBlockH > pageH - margin) { doc.addPage(); y = margin; }

    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text(`${idx + 1}. ${entry.ort || 'Ohne Ortsangabe'}`, margin, y);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(formatDate(entry.timestamp), pageW - margin, y, { align: 'right' });
    doc.setTextColor(20);
    y += 14;

    if (entry.photo) {
      try {
        const props = doc.getImageProperties(entry.photo);
        const maxW = 160;
        const w = maxW;
        const h = (props.height / props.width) * w;
        doc.addImage(entry.photo, 'JPEG', margin, y, w, h);
        const textX = margin + w + 14;
        const textW = pageW - margin - textX;
        doc.setFontSize(11);
        const lines = doc.splitTextToSize(entry.rohtext, textW);
        doc.text(lines, textX, y + 12);
        y += Math.max(h, lines.length * 13) + 20;
      } catch (e) {
        doc.setFontSize(11);
        const lines = doc.splitTextToSize(entry.rohtext, pageW - 2 * margin);
        doc.text(lines, margin, y + 12);
        y += lines.length * 13 + 20;
      }
    } else {
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(entry.rohtext, pageW - 2 * margin);
      doc.text(lines, margin, y + 12);
      y += lines.length * 13 + 20;
    }

    doc.setDrawColor(225);
    doc.line(margin, y - 8, pageW - margin, y - 8);
  });

  return doc;
}

function pdfFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (Settings.firma || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  return `${base}_${stamp}.pdf`;
}

document.getElementById('exportPdfBtn').addEventListener('click', () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  const doc = buildPdf();
  doc.save(pdfFileName());
});

/* ---------- Export: Excel ---------- */
document.getElementById('exportXlsxBtn').addEventListener('click', () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  const rows = cache.map((e, i) => ({
    'Nr.': i + 1,
    'Datum': formatDate(e.timestamp),
    'Ort / Bereich': e.ort || '',
    'Beschreibung': e.rohtext,
    'Foto vorhanden': e.photo ? 'Ja' : 'Nein',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 18 }, { wch: 60 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mängelliste');
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (Settings.firma || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  XLSX.writeFile(wb, `${base}_${stamp}.xlsx`);
  showToast('Hinweis: Fotos sind nur im PDF-Export enthalten.', 4000);
});

/* ---------- Backup: Sichern (JSON inkl. Fotos) ---------- */
function backupFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (Settings.firma || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Backup gespeichert (inkl. Fotos).');
});

/* ---------- Export: E-Mail ---------- */
document.getElementById('exportEmailBtn').addEventListener('click', async () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  const doc = buildPdf();
  const fileName = pdfFileName();
  const blob = doc.output('blob');
  const file = new File([blob], fileName, { type: 'application/pdf' });

  const subject = Settings.firma ? `Mängelliste – ${Settings.firma}` : 'Mängelliste';
  const bodyLines = cache.map((e, i) => `${i + 1}. ${e.ort ? e.ort + ': ' : ''}${e.rohtext}`);
  const body = bodyLines.join('\n');

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: subject, text: body });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fall through to mailto fallback below
    }
  }

  showToast('Teilen per Foto/PDF nicht verfügbar – PDF wird heruntergeladen, E-Mail wird vorbereitet.', 4500);
  doc.save(fileName);
  const mailto = `mailto:${encodeURIComponent(Settings.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body + '\n\n(Bitte die heruntergeladene PDF-Datei manuell anhängen.)')}`;
  window.location.href = mailto;
});

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
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let imported = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rohtext = cellValue(row, 'Beschreibung', 'Freundliche Formulierung', 'Ursprüngliche Notiz');
    if (!rohtext) continue;
    const ort = cellValue(row, 'Ort / Bereich', 'Ort');
    const dateStr = cellValue(row, 'Datum');
    const timestamp = parseGermanDate(dateStr) ?? (Date.now() + i);

    const entry = { id: uid(), timestamp, ort, rohtext, photo: null };
    await dbPut(entry);
    addHistory('ml_ortHistory', ort);
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

  let imported = 0;
  for (const e of entries) {
    if (!e || !e.rohtext) continue;
    const entry = {
      id: uid(),
      timestamp: e.timestamp || Date.now(),
      ort: e.ort || '',
      rohtext: e.rohtext,
      photo: e.photo || null,
    };
    await dbPut(entry);
    addHistory('ml_ortHistory', entry.ort);
    addHistory('ml_rohtextHistory', entry.rohtext);
    imported++;
  }

  refreshList();
  showToast(imported > 0 ? `${imported} Eintrag/Einträge aus Backup geladen (inkl. Fotos).` : 'Keine Einträge im Backup gefunden.', 3500);
}

/* ---------- Init ---------- */
refreshList();
