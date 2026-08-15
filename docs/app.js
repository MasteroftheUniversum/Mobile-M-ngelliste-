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
  get photoSize() { return localStorage.getItem('ml_photoSize') || 'mittel'; },
  set photoSize(v) { localStorage.setItem('ml_photoSize', v); },
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

function normalizeEntry(e) {
  const photos = Array.isArray(e.photos) ? e.photos.filter(Boolean).slice(0, 2) : (e.photo ? [e.photo] : []);
  return {
    ...e,
    photos,
    gattung: e.gattung || '',
    order: typeof e.order === 'number' ? e.order : e.timestamp,
  };
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
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
  cache.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'entry-card';
    li.dataset.id = entry.id;
    const photosHtml = entry.photos.map(p => `<img src="${p}" alt="">`).join('');
    li.innerHTML = `
      <span class="drag-handle" title="Ziehen zum Verschieben" aria-label="Ziehen zum Verschieben">≡</span>
      ${photosHtml ? `<div class="entry-photos">${photosHtml}</div>` : ''}
      <div class="entry-body">
        <div class="entry-tags">
          ${entry.ort ? `<span class="entry-ort">${escapeHtml(entry.ort)}</span>` : ''}
          ${entry.gattung ? `<span class="entry-gattung">${escapeHtml(entry.gattung)}</span>` : ''}
        </div>
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
    makeDraggable(li);
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

function makeDraggable(li) {
  const handle = li.querySelector('.drag-handle');
  let startY = 0;
  let pointerId = null;

  function onMove(e) {
    if (pointerId === null) return;
    const dy = e.clientY - startY;
    li.style.transform = `translateY(${dy}px)`;

    li.style.pointerEvents = 'none';
    const centerX = li.getBoundingClientRect().left + 30;
    const target = document.elementFromPoint(centerX, e.clientY)?.closest('.entry-card');
    li.style.pointerEvents = '';

    if (target && target !== li && target.parentElement === li.parentElement) {
      const rect = target.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      target.parentElement.insertBefore(li, before ? target : target.nextSibling);
      startY = e.clientY;
      li.style.transform = 'translateY(0px)';
    }
  }

  function onUp() {
    if (pointerId === null) return;
    try { handle.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    li.classList.remove('dragging');
    li.style.transform = '';
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    persistNewOrder();
  }

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointerId = e.pointerId;
    startY = e.clientY;
    li.classList.add('dragging');
    handle.setPointerCapture(pointerId);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
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
    timestamp: existing ? existing.timestamp : Date.now(),
    order: existing ? existing.order : nextOrder(),
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
  document.getElementById('firmaInput').value = Settings.firma;
  renderPhotoSizeChooser();
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

  const photoWidth = PHOTO_SIZES[Settings.photoSize].pdfWidth;

  const title = Settings.firma ? `Mängelliste – ${Settings.firma}` : 'Mängelliste';
  doc.setFontSize(18);
  const titleLines = doc.splitTextToSize(title, pageW - 2 * margin);
  doc.text(titleLines, margin, y);
  y += titleLines.length * 21;
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Erstellt am ${new Date().toLocaleDateString('de-DE')} · ${cache.length} Punkt(e)`, margin, y);
  doc.setTextColor(20);
  y += 26;

  const photoGap = 8;

  cache.forEach((entry, idx) => {
    const photoBlocks = [];
    (entry.photos || []).forEach(p => {
      try {
        const props = doc.getImageProperties(p);
        photoBlocks.push({ photo: p, h: (props.height / props.width) * photoWidth });
      } catch (e) { /* Foto nicht lesbar, überspringen */ }
    });
    const colH = photoBlocks.reduce((sum, b) => sum + b.h, 0) + (photoBlocks.length > 1 ? photoGap : 0);

    const estBlockH = 30 + colH + 60;
    if (y + estBlockH > pageH - margin) { doc.addPage(); y = margin; }

    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    const headerParts = [entry.ort || 'Ohne Ortsangabe'];
    if (entry.gattung) headerParts.push(entry.gattung);
    doc.text(`${idx + 1}. ${headerParts.join(' · ')}`, margin, y);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(130);
    doc.text(formatDate(entry.timestamp), pageW - margin, y, { align: 'right' });
    doc.setTextColor(20);
    y += 14;

    const textX = photoBlocks.length ? margin + photoWidth + 14 : margin;
    const textW = pageW - margin - textX;
    doc.setFontSize(11);
    const lines = doc.splitTextToSize(entry.rohtext, textW);
    doc.text(lines, textX, y + 12);

    let imgY = y;
    photoBlocks.forEach(b => {
      try { doc.addImage(b.photo, 'JPEG', margin, imgY, photoWidth, b.h); } catch (e) {}
      imgY += b.h + photoGap;
    });

    y += Math.max(colH, lines.length * 13) + 20;

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
  const base = (Settings.firma || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  return `${base}_${stamp}.xlsx`;
}

/* ---------- Export: Excel (mit eingebetteten Fotos) ---------- */
document.getElementById('exportXlsxBtn').addEventListener('click', async () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  showToast('Excel wird erstellt …', 2000);

  const imgW = PHOTO_SIZES[Settings.photoSize].xlsxWidth;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mängelliste', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const photoColW = Math.max(10, Math.round(imgW / 7));
  const columns = [
    { key: 'nr', width: 6 },
    { key: 'gattung', width: 16 },
    { key: 'ort', width: 18 },
    { key: 'beschreibung', width: 45 },
    { key: 'foto1', width: photoColW },
    { key: 'foto2', width: photoColW },
    { key: 'datum', width: 12 },
  ];
  ws.columns = columns;
  const colCount = columns.length;

  ws.mergeCells(1, 1, 1, colCount);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = Settings.firma ? `Mängelliste – ${Settings.firma}` : 'Mängelliste';
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 28;
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };

  ws.mergeCells(2, 1, 2, colCount);
  const subCell = ws.getCell(2, 1);
  subCell.value = `Erstellt am ${new Date().toLocaleDateString('de-DE')} · ${cache.length} Punkt(e)`;
  subCell.font = { italic: true, size: 10, color: { argb: 'FFFFFFFF' } };
  subCell.alignment = { vertical: 'middle' };
  ws.getRow(2).height = 18;
  ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };

  const headerRowIdx = 3;
  const headerRow = ws.getRow(headerRowIdx);
  headerRow.values = ['Nr.', 'Arbeitsgattung', 'Ort / Bereich', 'Beschreibung', 'Foto 1', 'Foto 2', 'Datum'];
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
  headerRow.alignment = { vertical: 'middle' };
  headerRow.height = 20;

  ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
  ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: colCount } };

  const thinBorder = { style: 'thin', color: { argb: 'FFE2E8F0' } };

  for (let i = 0; i < cache.length; i++) {
    const e = cache[i];
    const rowIdx = headerRowIdx + 1 + i;
    const row = ws.getRow(rowIdx);
    row.values = {
      nr: i + 1,
      gattung: e.gattung || '',
      ort: e.ort || '',
      beschreibung: e.rohtext,
      foto1: e.photos[0] ? '' : '–',
      foto2: e.photos[1] ? '' : '–',
      datum: formatDate(e.timestamp),
    };
    row.alignment = { vertical: 'middle', wrapText: true };
    row.eachCell({ includeEmpty: true }, cell => {
      cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
    });
    if (i % 2 === 1) {
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6FB' } };
      });
    }

    let maxImgH = 20;
    for (const [photoIdx, colKey] of [[0, 'foto1'], [1, 'foto2']]) {
      const photo = e.photos[photoIdx];
      if (!photo) continue;
      try {
        const dims = await getImageDimensions(photo);
        const imgH = imgW * (dims.height / dims.width);
        const imageId = wb.addImage({ base64: photo, extension: 'jpeg' });
        const colIndex = columns.findIndex(c => c.key === colKey);
        ws.addImage(imageId, { tl: { col: colIndex, row: rowIdx - 1 }, ext: { width: imgW, height: imgH } });
        maxImgH = Math.max(maxImgH, imgH * 0.75);
      } catch (err) { /* Foto überspringen */ }
    }
    row.height = maxImgH;
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  downloadBlob(blob, xlsxFileName());
  showToast('Excel-Datei mit Fotos gespeichert.');
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
  const subject = Settings.firma ? `Mängelliste – ${Settings.firma}` : 'Mängelliste';
  const bodyLines = cache.map((e, i) => `${i + 1}. ${e.ort ? e.ort + ': ' : ''}${e.rohtext}`);
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

    const entry = { id: uid(), timestamp, order: base + imported, ort, gattung, rohtext, photos: [] };
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
      timestamp: e.timestamp || Date.now(),
      order: base + imported,
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
refreshList();
