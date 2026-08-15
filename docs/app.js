'use strict';

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

/* ---------- Settings (localStorage) ---------- */
const Settings = {
  get apiKey() { return localStorage.getItem('ml_apiKey') || ''; },
  set apiKey(v) { localStorage.setItem('ml_apiKey', v || ''); },
  get email() { return localStorage.getItem('ml_email') || ''; },
  set email(v) { localStorage.setItem('ml_email', v || ''); },
  get firma() { return localStorage.getItem('ml_firma') || ''; },
  set firma(v) { localStorage.setItem('ml_firma', v || ''); },
};

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
let lastMainView = 'list';
function showView(name) {
  if (!views.editor.classList.contains('hidden')) lastMainView = 'editor';
  else if (!views.list.classList.contains('hidden')) lastMainView = 'list';

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
        <p class="entry-text">${escapeHtml(entry.friendly || entry.rohtext)}</p>
        <div class="entry-meta">${formatDate(entry.timestamp)}</div>
      </div>
      <div class="entry-actions">
        <button data-action="delete" title="Löschen">🗑️</button>
      </div>`;
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

function resetEditor() {
  currentPhotoDataUrl = null;
  document.getElementById('photoPreview').classList.add('hidden');
  document.getElementById('photoPreview').src = '';
  document.getElementById('photoPlaceholder').classList.remove('hidden');
  document.getElementById('ortInput').value = '';
  document.getElementById('rohtextInput').value = '';
  document.getElementById('friendlyInput').value = '';
  document.getElementById('friendlyWrap').classList.add('hidden');
  document.getElementById('editorError').classList.add('hidden');
  updateEditorState();
}

function updateEditorState() {
  const hasText = document.getElementById('rohtextInput').value.trim().length > 0;
  document.getElementById('rephraseBtn').disabled = !hasText;
  const hasFriendly = document.getElementById('friendlyInput').value.trim().length > 0;
  document.getElementById('editorSave').disabled = !(hasText || hasFriendly);
}

document.getElementById('addBtn').addEventListener('click', () => {
  resetEditor();
  showView('editor');
});
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
document.getElementById('friendlyInput').addEventListener('input', updateEditorState);

document.getElementById('rephraseBtn').addEventListener('click', async () => {
  const rohtext = document.getElementById('rohtextInput').value.trim();
  const ort = document.getElementById('ortInput').value.trim();
  const errEl = document.getElementById('editorError');
  errEl.classList.add('hidden');

  if (!Settings.apiKey) {
    showView('settings');
    showToast('Bitte zuerst deinen API-Key eintragen.');
    return;
  }

  const btn = document.getElementById('rephraseBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = '⏳ Formuliere...';

  try {
    const friendly = await rephraseText(rohtext, ort);
    document.getElementById('friendlyInput').value = friendly;
    document.getElementById('friendlyWrap').classList.remove('hidden');
    updateEditorState();
  } catch (err) {
    errEl.textContent = 'Fehler bei der Umformulierung: ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '✨ Freundlich formulieren';
  }
});

async function rephraseText(rohtext, ort) {
  const locationHint = ort ? ` (Bereich: ${ort})` : '';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': Settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Du hilfst dabei, kurze Mangel-Notizen von einer Begehung (z.B. Bau, Wohnung, Miete) in eine einzige freundliche, höfliche Frage an die zuständige Person umzuformulieren, die um Prüfung/Behebung bittet. Antworte AUSSCHLIESSLICH mit der umformulierten Frage auf Deutsch, ohne Anführungszeichen, ohne Erklärung, ohne Anrede.',
      messages: [{ role: 'user', content: `Mangel-Notiz${locationHint}: ${rohtext}` }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('API-Key ungültig. Bitte in den Einstellungen prüfen.');
    throw new Error(`API-Fehler ${res.status}. ${body.slice(0, 120)}`);
  }
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('').trim();
}

document.getElementById('editorSave').addEventListener('click', async () => {
  const entry = {
    id: uid(),
    timestamp: Date.now(),
    ort: document.getElementById('ortInput').value.trim(),
    rohtext: document.getElementById('rohtextInput').value.trim(),
    friendly: document.getElementById('friendlyInput').value.trim(),
    photo: currentPhotoDataUrl,
  };
  await dbPut(entry);
  showView('list');
  refreshList();
  showToast('Mangel gespeichert.');
});

/* ---------- Settings ---------- */
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('apiKeyInput').value = Settings.apiKey;
  document.getElementById('emailInput').value = Settings.email;
  document.getElementById('firmaInput').value = Settings.firma;
  showView('settings');
});
document.getElementById('settingsCancel').addEventListener('click', () => showView(lastMainView));
document.getElementById('settingsSave').addEventListener('click', () => {
  Settings.apiKey = document.getElementById('apiKeyInput').value.trim();
  Settings.email = document.getElementById('emailInput').value.trim();
  Settings.firma = document.getElementById('firmaInput').value.trim();
  showView(lastMainView);
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
        const lines = doc.splitTextToSize(entry.friendly || entry.rohtext, textW);
        doc.text(lines, textX, y + 12);
        y += Math.max(h, lines.length * 13) + 20;
      } catch (e) {
        doc.setFontSize(11);
        const lines = doc.splitTextToSize(entry.friendly || entry.rohtext, pageW - 2 * margin);
        doc.text(lines, margin, y + 12);
        y += lines.length * 13 + 20;
      }
    } else {
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(entry.friendly || entry.rohtext, pageW - 2 * margin);
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
    'Freundliche Formulierung': e.friendly || e.rohtext,
    'Ursprüngliche Notiz': e.rohtext,
    'Foto vorhanden': e.photo ? 'Ja' : 'Nein',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 18 }, { wch: 50 }, { wch: 40 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mängelliste');
  const stamp = new Date().toISOString().slice(0, 10);
  const base = (Settings.firma || 'Maengelliste').replace(/[^a-z0-9äöüß_\- ]/gi, '').trim() || 'Maengelliste';
  XLSX.writeFile(wb, `${base}_${stamp}.xlsx`);
  showToast('Hinweis: Fotos sind nur im PDF-Export enthalten.', 4000);
});

/* ---------- Export: E-Mail ---------- */
document.getElementById('exportEmailBtn').addEventListener('click', async () => {
  if (cache.length === 0) return showToast('Keine Einträge vorhanden.');
  const doc = buildPdf();
  const fileName = pdfFileName();
  const blob = doc.output('blob');
  const file = new File([blob], fileName, { type: 'application/pdf' });

  const subject = Settings.firma ? `Mängelliste – ${Settings.firma}` : 'Mängelliste';
  const bodyLines = cache.map((e, i) => `${i + 1}. ${e.ort ? e.ort + ': ' : ''}${e.friendly || e.rohtext}`);
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

/* ---------- Init ---------- */
refreshList();
