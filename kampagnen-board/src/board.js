'use strict';
/* ================================================================
   Kampagnen Board
   Daten: "boards/{b}", "boards/{b}/items/{i}", "boards/{b}/links/{l}"
   Live:  Presence je Person { pid, cur:[x,y], sel:[ids], drag:[[id,x,y,w,h]], edit }
   ================================================================ */
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/g, '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'gray', 'white'];
const CHECK_SVG = '<svg viewBox="0 0 12 12"><path d="m2.5 6.2 2.3 2.3 4.7-5"/></svg>';

/* ---------------- Zustand ---------------- */
const S = {
  boards: new Map(), boardId: null,
  items: new Map(), links: new Map(),
  view: { x: 0, y: 0, z: 1 },
  sel: new Set(), selLink: null, editing: null,
  readOnly: false, online: false,
  undo: [], redo: [],
  peers: [], peerDrag: new Map(), // itemId -> {x,y,w,h,t}
  me: { id: null, name: '', color: '#0071e3', avatar: '' },
  profiles: {},
};
let B = null; // Speicher-Backend: claude.ai, lokal oder Cloud (siehe backend-*.js)

/* ---------------- Speicher-Schicht ----------------
   Alle Backends liefern dieselbe Schnittstelle, die Oberfläche kennt nur `store`. */
const store = {
  watchBoards: (cb) => B.watchColl('boards', cb),
  watchColl: (path, cb) => B.watchColl(path, cb),
  getColl: (path) => B.getColl(path),
  set: (path, data) => B.set(path, data),
  del: (path) => B.del(path),
  upload: (file) => B.upload(file),
};
const mediaURL = (src) => !src ? '' : B.mediaURL(src);
function guessType(f) {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf' }[ext] || f.type;
}

/* ---------------- Schreib-Warteschlange ----------------
   Pro Dokument höchstens ein Schreibvorgang gleichzeitig; schnelle Änderungen werden zusammengefasst. */
const W = new Map();   // path -> {data, timer, busy}
const dirty = new Map(); // path -> data | null (noch nicht bestätigt)
function write(path, data, delay = 0) {
  if (S.readOnly) return;
  const w = W.get(path) || {}; W.set(path, w);
  w.data = data; dirty.set(path, data);
  clearTimeout(w.timer); w.timer = setTimeout(() => flush(path), delay);
  syncState();
}
async function flush(path) {
  const w = W.get(path); if (!w || w.busy || w.data === undefined) return;
  const data = w.data; w.data = undefined; w.busy = true;
  try { data === null ? await store.del(path) : await store.set(path, data); }
  catch (e) { writeFail(e); }
  w.busy = false;
  if (w.data !== undefined) flush(path);
  else { W.delete(path); dirty.delete(path); syncState(); }
}
// Beim Schließen alles Wartende sofort schreiben.
window.addEventListener('beforeunload', () => {
  if (S.editing) endEdit();
  for (const [path, w] of W) {
    if (w.data === undefined) continue;
    clearTimeout(w.timer); const d = w.data; w.data = undefined;
    try { d === null ? store.del(path) : store.set(path, d); } catch {}
  }
});
function writeFail(e) {
  const c = e && e.code;
  if (c === 'invalid_argument' && !S.readOnlyHinted) { S.readOnlyHinted = true; setReadOnly(true); toast('Du kannst dieses Board nur ansehen. Bitte die Person, die es geteilt hat, dich als „Bearbeiter“ einzuladen.'); }
  else if (c === 'quota_exceeded') toast('Der Speicher ist voll. Lösche alte Boards oder Elemente, dann geht es weiter.');
  else if (c === 'resource_exhausted') toast('Gerade zu viele Änderungen auf einmal. Kurz warten, dann geht es weiter.');
  else if (Date.now() - (writeFail.t || 0) > 8000) { writeFail.t = Date.now(); toast('Eine Änderung konnte nicht gespeichert werden. Prüfe die Internetverbindung, dann einfach weiterarbeiten.'); }
}
function syncState() {
  const s = $('#sync');
  const pending = W.size > 0;
  if (!B) return;
  s.className = 'sync' + (pending ? ' saving' : '') + (B.connected === false ? ' off' : '');
  s.querySelector('span').textContent = S.readOnly ? 'Nur ansehen' : B.connected === false ? 'Offline' : pending ? 'Speichert …' : B.savedLabel;
}

/* ---------------- Board-Pfade ---------------- */
const bPath = (b) => 'boards/' + b;
const iPath = (id, b = S.boardId) => `boards/${b}/items/${id}`;
const lPath = (id, b = S.boardId) => `boards/${b}/links/${id}`;

/* ---------------- Änderungen + Rückgängig ---------------- */
// change = { kind: 'item'|'link', id, before, after }  (null = existiert nicht)
function apply(changes, { record = true, delay = 0 } = {}) {
  if (!changes.length || S.readOnly) return;
  for (const c of changes) {
    const map = c.kind === 'item' ? S.items : S.links;
    if (c.after) map.set(c.id, c.after); else map.delete(c.id);
    write(c.kind === 'item' ? iPath(c.id) : lPath(c.id), c.after || null, delay);
  }
  if (record) { S.undo.push({ b: S.boardId, changes }); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
  touchBoard();
  render();
}
function undo() {
  const op = S.undo.pop(); if (!op || op.b !== S.boardId) { if (op) S.undo = []; return; }
  apply(op.changes.slice().reverse().map(c => ({ ...c, before: c.after, after: c.before })), { record: false });
  S.redo.push(op);
  pruneSel();
}
function redo() {
  const op = S.redo.pop(); if (!op || op.b !== S.boardId) return;
  apply(op.changes, { record: false });
  S.undo.push(op);
  pruneSel();
}
let touchTimer = 0;
function touchBoard() {
  const b = S.boards.get(S.boardId); if (!b) return;
  const now = Date.now();
  if (now - (b.updatedAt || 0) < 15000) return;
  const nb = { ...b, updatedAt: now, updatedBy: S.me.id || null };
  S.boards.set(S.boardId, nb);
  clearTimeout(touchTimer); touchTimer = setTimeout(() => write(bPath(S.boardId), nb), 600);
}
function pruneSel() {
  for (const id of [...S.sel]) if (!S.items.has(id)) S.sel.delete(id);
  if (S.selLink && !S.links.has(S.selLink)) S.selLink = null;
  render();
}
const itemChange = (id, after) => ({ kind: 'item', id, before: S.items.get(id) || null, after });
const nextZ = () => { let m = 0; for (const it of S.items.values()) m = Math.max(m, it.z || 0); return m + 1; };

/* ---------------- Boards ---------------- */
function boardsSnapshot(list) {
  S.boards = new Map(list);
  for (const [p, d] of dirty) { const seg = p.split('/'); if (seg.length === 2) { if (d) S.boards.set(seg[1], d); else S.boards.delete(seg[1]); } }
  renderBoards();
  if (!S.boardId || !S.boards.has(S.boardId)) {
    const want = lsGet('kb-last', null);
    const first = (want && S.boards.has(want)) ? want : sortedBoards()[0]?.[0];
    if (first) openBoard(first); else showEmpty();
  } else updateTitle();
}
const sortedBoards = () => [...S.boards.entries()].sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

let unsubItems = null, unsubLinks = null;
function openBoard(id) {
  if (S.boardId === id && unsubItems) return;
  endEdit();
  if (unsubItems) unsubItems(); if (unsubLinks) unsubLinks();
  S.boardId = id; lsSet('kb-last', id);
  S.items = new Map(); S.links = new Map(); S.sel.clear(); S.selLink = null; S.undo = []; S.redo = [];
  for (const e of itemEls.values()) e.remove(); itemEls.clear();
  S.view = lsGet('kb-view-' + id, null) || { x: 0, y: 0, z: 1 };
  S.firstLoad = !lsGet('kb-view-' + id, null);
  unsubItems = store.watchColl(`boards/${id}/items`, (docs) => itemsSnapshot(docs));
  unsubLinks = store.watchColl(`boards/${id}/links`, (docs) => linksSnapshot(docs));
  $('#empty')?.remove();
  updateTitle(); renderBoards(); applyView(); render();
  presence({ pid: id, sel: [], drag: null, edit: null });
  if (window.innerWidth <= 760) $('#app').classList.remove('side-open');
}
function mergeDirty(map, kind, docs) {
  const fresh = new Map(docs);
  const prefix = `boards/${S.boardId}/${kind}/`;
  for (const [p, d] of dirty) if (p.startsWith(prefix)) { const id = p.slice(prefix.length); if (d) fresh.set(id, d); else fresh.delete(id); }
  return fresh;
}
function itemsSnapshot(docs) {
  const fresh = mergeDirty(S.items, 'items', docs);
  // Der Text, den ich gerade tippe, bleibt meiner.
  if (S.editing && S.items.has(S.editing) && fresh.has(S.editing)) fresh.set(S.editing, S.items.get(S.editing));
  if (drag && drag.kind === 'move' && drag.starts) for (const id of drag.starts.keys()) if (S.items.has(id) && fresh.has(id)) fresh.set(id, S.items.get(id));
  for (const [id, it] of fresh) { const pd = S.peerDrag.get(id); if (pd && pd.x === it.x && pd.y === it.y) S.peerDrag.delete(id); }
  S.items = fresh;
  pruneSelQuiet();
  render();
  if (S.firstLoad && S.items.size) { S.firstLoad = false; requestAnimationFrame(() => fitView(false)); }
}
function linksSnapshot(docs) { S.links = mergeDirty(S.links, 'links', docs); renderWires(); }
function pruneSelQuiet() { for (const id of [...S.sel]) if (!S.items.has(id)) S.sel.delete(id); }

async function createBoard(template) {
  if (S.readOnly) return;
  const id = uid(); const now = Date.now();
  const b = { name: template ? 'Kampagne Sommer-Drop' : 'Neues Board', createdAt: now, updatedAt: now, createdBy: S.me.id || null };
  S.boards.set(id, b); write(bPath(id), b);
  openBoard(id);
  if (template) {
    const changes = templateItems().map(([kind, obj]) => ({ kind, id: obj.id, before: null, after: obj }));
    apply(changes, { record: false });
    requestAnimationFrame(() => fitView(false));
  } else {
    S.view = { x: vpRect().width / 2, y: vpRect().height / 2.4, z: 1 }; applyView();
    renameBoardInline(id);
  }
}
function templateItems() {
  const I = (o) => ['item', { id: uid(), z: 1, ...o }];
  const center = I({ type: 'text', size: 'h', x: -190, y: -40, w: 380, text: 'Sommer-Drop 2027' });
  const ziel = I({ type: 'note', color: 'blue', x: -620, y: -230, w: 250, text: 'Zielgruppe\n18 bis 30, urban, kauft über Instagram und TikTok.' });
  const msg = I({ type: 'note', color: 'yellow', x: 330, y: -250, w: 260, text: 'Kernbotschaft\nEin Satz, den jeder nach 3 Sekunden versteht.' });
  const mood = I({ type: 'frame', x: -660, y: 140, w: 480, h: 280, title: 'Moodboard' });
  const moodN = I({ type: 'note', color: 'gray', x: -630, y: 175, w: 210, text: 'Bilder hier hineinziehen\noder einfügen (Strg + V).' });
  const kan = I({ type: 'check', x: 330, y: 120, w: 270, title: 'Kanäle', items: [
    { id: uid(), t: 'Instagram Reels', d: true }, { id: uid(), t: 'TikTok Teaser', d: false }, { id: uid(), t: 'Newsletter', d: false }, { id: uid(), t: 'Pop-up Event', d: false }] });
  const ref = I({ type: 'link', x: -150, y: 220, w: 300, url: 'https://www.apple.com/de/', title: 'Referenz: Apple Design' });
  const L = (a, b) => ['link', { id: uid(), from: a[1].id, to: b[1].id }];
  return [center, ziel, msg, mood, moodN, kan, ref, L(center, ziel), L(center, msg), L(center, mood), L(center, kan), L(center, ref)];
}
async function deleteBoard(id) {
  const ok = await confirmBox('Board löschen?', `„${S.boards.get(id)?.name || 'Board'}“ wird für alle gelöscht, die es geteilt haben.`, 'Löschen');
  if (!ok) return;
  const wasOpen = S.boardId === id;
  // Inhalte zuerst entfernen.
  const take = async (coll) => {
    return (await store.getColl(`boards/${id}/${coll}`)).map(([did]) => did);
  };
  try {
    for (const lid of await take('links')) write(`boards/${id}/links/${lid}`, null);
    for (const iid of await take('items')) write(`boards/${id}/items/${iid}`, null);
  } catch {}
  S.boards.delete(id); write(bPath(id), null);
  if (wasOpen) {
    if (unsubItems) unsubItems(); if (unsubLinks) unsubLinks(); unsubItems = unsubLinks = null;
    S.boardId = null; S.items.clear(); S.links.clear(); render();
    const next = sortedBoards()[0]; if (next) openBoard(next[0]); else showEmpty();
  }
  renderBoards();
}
async function duplicateBoard(id) {
  const src = S.boards.get(id); if (!src) return;
  const nid = uid(); const now = Date.now();
  const b = { ...src, name: src.name + ' Kopie', createdAt: now, updatedAt: now, createdBy: S.me.id || null };
  let items = [], links = [];
  if (id === S.boardId) { items = [...S.items.values()]; links = [...S.links.values()]; }
  else {
    items = (await store.getColl(`boards/${id}/items`)).map(([did, d]) => ({ ...d, id: did }));
    links = (await store.getColl(`boards/${id}/links`)).map(([did, d]) => ({ ...d, id: did }));
  }
  write(bPath(nid), b); S.boards.set(nid, b);
  const map = new Map(items.map(it => [it.id, uid()]));
  for (const it of items) write(iPath(map.get(it.id), nid), { ...it, id: map.get(it.id) });
  for (const l of links) if (map.has(l.from) && map.has(l.to)) { const lid = uid(); write(lPath(lid, nid), { id: lid, from: map.get(l.from), to: map.get(l.to) }); }
  renderBoards(); openBoard(nid);
}

/* ---------------- Ansicht ---------------- */
const vp = $('#vp'), world = $('#world'), wires = $('#wires');
const vpRect = () => vp.getBoundingClientRect();
function applyView() {
  const { x, y, z } = S.view;
  world.style.transform = `translate(${x}px,${y}px) scale(${z})`;
  let g = 24 * z; while (g < 12) g *= 2;
  vp.style.backgroundSize = `${g}px ${g}px`;
  vp.style.backgroundPosition = `${x}px ${y}px`;
  $('#zVal').textContent = Math.round(z * 100) + ' %';
  clearTimeout(applyView.t); applyView.t = setTimeout(() => S.boardId && lsSet('kb-view-' + S.boardId, S.view), 300);
  renderCursors(); placeFbar();
}
const toWorld = (cx, cy) => { const r = vpRect(); return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z }; };
function zoomAt(cx, cy, nz) {
  const r = vpRect(); nz = clamp(nz, 0.1, 4);
  const px = cx - r.left, py = cy - r.top;
  S.view.x = px - (px - S.view.x) * (nz / S.view.z);
  S.view.y = py - (py - S.view.y) * (nz / S.view.z);
  S.view.z = nz; applyView();
}
function zoomBy(f) { const r = vpRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.z * f); }
function bounds(ids) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const id of ids) { const r = rectOf(id); if (!r) continue; x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function fitView(anim = true) {
  const b = bounds([...S.items.keys()]); const r = vpRect();
  if (!b) { S.view = { x: r.width / 2, y: r.height / 2.4, z: 1 }; applyView(); return; }
  const pad = 110;
  const z = clamp(Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h), 0.15, 1.25);
  const to = { z, x: r.width / 2 - (b.x + b.w / 2) * z, y: r.height / 2 - (b.y + b.h / 2) * z + 10 };
  animateView(to, anim);
}
function animateView(to, anim = true) {
  if (!anim || matchMedia('(prefers-reduced-motion: reduce)').matches) { S.view = to; applyView(); return; }
  const from = { ...S.view }, t0 = performance.now(), dur = 380;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    S.view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e }; applyView();
    if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function viewCenter() { const r = vpRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }

/* ---------------- Darstellung ---------------- */
const itemEls = new Map();
function effective(it) {
  const pd = S.peerDrag.get(it.id);
  if (pd && Date.now() - pd.t < 4000) return { ...it, x: pd.x, y: pd.y, w: pd.w ?? it.w, h: pd.h ?? it.h };
  return it;
}
function rectOf(id) {
  const it = S.items.get(id); if (!it) return null;
  const e = effective(it); const node = itemEls.get(id);
  return { x: e.x, y: e.y, w: node ? node.offsetWidth : e.w, h: node ? node.offsetHeight : (e.h || 60) };
}
function render() {
  const seen = new Set();
  for (const it of S.items.values()) {
    let node = itemEls.get(it.id);
    if (!node || node.dataset.type !== it.type) { node?.remove(); node = buildItem(it); itemEls.set(it.id, node); world.appendChild(node); }
    updateItem(node, it); seen.add(it.id);
  }
  for (const [id, node] of itemEls) if (!seen.has(id)) { node.remove(); itemEls.delete(id); }
  renderWires(); renderPeerMarks(); placeFbar();
  $('#canvasHint').hidden = !(S.boardId && S.items.size === 0 && S.loadedOnce !== false);
  $('#app').classList.toggle('readonly', S.readOnly);
}
function ports(n) { for (const s of ['t', 'r', 'b', 'l']) { const p = el('div', 'port'); p.dataset.side = s; n.appendChild(p); } }
function buildItem(it) {
  const n = el('div', 'item t-' + it.type); n.dataset.id = it.id; n.dataset.type = it.type;
  n.appendChild(el('div', 'ring'));
  switch (it.type) {
    case 'text': n.appendChild(el('div', 'txt')).dataset.ph = 'Text'; break;
    case 'note': n.appendChild(el('div', 'txt')).dataset.ph = 'Notiz'; break;
    case 'check': {
      const h = el('div', 'ck-head'); const t = el('div', 'txt'); t.dataset.ph = 'Checkliste'; t.dataset.role = 'title';
      h.append(t, el('span', 'ck-count')); n.append(h, el('div', 'ck-bar', '<i></i>'), el('ul', 'ck-list'));
      const add = el('button', 'ck-add', '+ Punkt'); add.dataset.act = 'ck-add'; n.appendChild(add); break;
    }
    case 'link': {
      const img = el('img', 'lk-img'); img.alt = ''; img.draggable = false; img.onerror = () => { img.removeAttribute('src'); n.classList.remove('has-img'); };
      const m = el('div', 'lk-mark'); const b = el('div', 'lk-body');
      const t = el('div', 'lk-title txt'); t.dataset.role = 'title'; t.dataset.ph = 'Titel';
      const u = el('div', 'lk-url txt'); u.dataset.role = 'url'; u.dataset.ph = 'https://…';
      b.append(t, u);
      const a = el('a', 'lk-open', '<svg class="i" viewBox="0 0 24 24"><path d="M8 16 16 8M9.5 8H16v6.5"/></svg>'); a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = 'Im Browser öffnen'; a.setAttribute('aria-label', 'Link öffnen');
      n.append(img, m, b, a); break;
    }
    case 'image': { const img = el('img'); img.alt = ''; img.draggable = false; img.onerror = () => missing(n); n.appendChild(img); break; }
    case 'video': {
      const v = el('video'); v.playsInline = true; v.preload = 'metadata'; v.loop = true; v.onerror = () => missing(n);
      const p = el('button', 'v-play', '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9.5-5.5z"/></svg>'); p.dataset.act = 'play'; p.setAttribute('aria-label', 'Abspielen');
      const snd = el('button', 'v-sound', '<svg class="i" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="w" d="M15.5 9.6a3.4 3.4 0 0 1 0 4.8"/></svg>'); snd.dataset.act = 'sound'; snd.setAttribute('aria-label', 'Ton');
      const s = el('div', 'v-scrub', '<i></i>'); s.dataset.act = 'scrub';
      v.addEventListener('timeupdate', () => { s.firstChild.style.width = (v.duration ? v.currentTime / v.duration * 100 : 0) + '%'; });
      v.addEventListener('play', () => p.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>');
      v.addEventListener('pause', () => p.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9.5-5.5z"/></svg>');
      n.append(v, p, snd, s); break;
    }
    case 'pdf': {
      const a = el('a', 'lk-open', '<svg class="i" viewBox="0 0 24 24"><path d="M8 16 16 8M9.5 8H16v6.5"/></svg>'); a.target = '_blank'; a.rel = 'noopener'; a.title = 'PDF öffnen';
      n.append(el('div', 'pdf-mark', 'PDF'), el('div', 'lk-body', '<div class="lk-title"></div><div class="lk-url">PDF-Dokument</div>'), a); break;
    }
    case 'frame': { const t = el('div', 'fr-title txt'); t.dataset.ph = 'Bereich'; t.dataset.role = 'title'; n.appendChild(t); break; }
  }
  if (it.type !== 'frame') ports(n);
  n.appendChild(el('div', 'resize'));
  return n;
}
function missing(n) { if (!n.querySelector('.media-missing')) n.appendChild(el('div', 'media-missing', 'Datei nicht verfügbar')); }
function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function hueColor(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 48%)`; }
function updateItem(n, it0) {
  const it = effective(it0);
  n.style.left = it.x + 'px'; n.style.top = it.y + 'px';
  n.style.zIndex = (it.type === 'frame' ? 0 : 100000) + (it.z || 0);
  if (it.w) n.style.width = it.w + 'px';
  n.classList.toggle('sel', S.sel.has(it.id));
  n.classList.toggle('solo', S.sel.size === 1);
  const editing = S.editing === it.id;
  n.classList.toggle('editing', editing);
  switch (it.type) {
    case 'text': n.dataset.size = it.size || 'p'; if (!editing) setText(n.querySelector('.txt'), it.text || ''); break;
    case 'note': n.dataset.color = it.color || 'yellow'; n.style.minHeight = (it.h || 0) + 'px'; if (!editing) setText(n.querySelector('.txt'), it.text || ''); break;
    case 'check': {
      const list = it.items || [];
      if (!editing) {
        setText(n.querySelector('[data-role=title]'), it.title || '');
        const ul = n.querySelector('.ck-list'); const key = JSON.stringify(list);
        if (ul.dataset.key !== key) {
          ul.dataset.key = key; ul.innerHTML = '';
          for (const r of list) {
            const li = el('li', 'ck-row' + (r.d ? ' done' : '')); li.dataset.rid = r.id;
            const b = el('button', 'ck-box', CHECK_SVG); b.dataset.act = 'ck'; b.setAttribute('aria-label', r.d ? 'Erledigt' : 'Offen');
            const t = el('div', 'txt'); t.textContent = r.t; t.dataset.ph = 'Punkt';
            li.append(b, t); ul.appendChild(li);
          }
        }
      }
      const done = list.filter(r => r.d).length;
      n.querySelector('.ck-count').textContent = list.length ? `${done}/${list.length}` : '';
      n.querySelector('.ck-bar i').style.width = (list.length ? done / list.length * 100 : 0) + '%';
      break;
    }
    case 'link': {
      const host = hostOf(it.url || '');
      if (!editing) { setText(n.querySelector('[data-role=title]'), it.title || host || ''); setText(n.querySelector('[data-role=url]'), it.url || ''); }
      const m = n.querySelector('.lk-mark'); m.textContent = (host || '?')[0].toUpperCase(); m.style.setProperty('--lk', hueColor(host || 'x'));
      const a = n.querySelector('.lk-open'); if (/^https?:\/\//i.test(it.url || '')) a.href = it.url; else a.removeAttribute('href');
      const img = n.querySelector('.lk-img'); const show = !!(B?.externalImages && it.image);
      if (show && img.getAttribute('src') !== it.image) img.src = it.image;
      n.classList.toggle('has-img', show && !!img.getAttribute('src'));
      break;
    }
    case 'image': case 'video': {
      n.style.height = (it.w * (it.ar || 0.75)) + 'px';
      const m = n.querySelector(it.type === 'image' ? 'img' : 'video'); const u = mediaURL(it.src);
      if (m.getAttribute('src') !== u) { n.querySelector('.media-missing')?.remove(); m.src = u; }
      break;
    }
    case 'pdf': { setText(n.querySelector('.lk-title'), it.name || 'Dokument.pdf'); n.querySelector('.lk-open').href = mediaURL(it.src); break; }
    case 'frame': n.style.height = it.h + 'px'; if (!editing) setText(n.querySelector('.txt'), it.title || ''); break;
  }
}

/* ---------------- Verbindungen ---------------- */
function anchors(a, b) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  if (Math.abs(dx) / (a.w + b.w) >= Math.abs(dy) / (a.h + b.h)) {
    const s = Math.sign(dx) || 1;
    return [{ x: s > 0 ? a.x + a.w : a.x, y: ca.y, nx: s, ny: 0 }, { x: s > 0 ? b.x : b.x + b.w, y: cb.y, nx: -s, ny: 0 }];
  }
  const s = Math.sign(dy) || 1;
  return [{ x: ca.x, y: s > 0 ? a.y + a.h : a.y, nx: 0, ny: s }, { x: cb.x, y: s > 0 ? b.y : b.y + b.h, nx: 0, ny: -s }];
}
function curve(p1, p2) {
  const d = clamp(Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.45, 30, 260);
  return `M${p1.x},${p1.y} C${p1.x + p1.nx * d},${p1.y + p1.ny * d} ${p2.x + (p2.nx || 0) * d},${p2.y + (p2.ny || 0) * d} ${p2.x},${p2.y}`;
}
function renderWires() {
  let html = '';
  for (const l of S.links.values()) {
    const a = rectOf(l.from), b = rectOf(l.to); if (!a || !b) continue;
    const [p1, p2] = anchors(a, b); const d = curve(p1, p2);
    html += `<g class="wire-g${S.selLink === l.id ? ' on' : ''}" data-link="${l.id}"><path class="wire" d="${d}"/><path class="wire-hit" d="${d}"/><circle class="wire-end" cx="${p1.x}" cy="${p1.y}" r="4"/><circle class="wire-end" cx="${p2.x}" cy="${p2.y}" r="4"/></g>`;
  }
  if (drag && drag.kind === 'link' && drag.p2) html += `<path class="wire-temp" d="${curve(drag.p1, drag.p2)}"/>`;
  wires.innerHTML = html;
}

/* ---------------- Formatleiste ---------------- */
const fbar = el('div', 'fbar glass'); fbar.hidden = true; $('#stage').appendChild(fbar);
function placeFbar() {
  if (S.readOnly || drag || (!S.sel.size && !S.selLink)) { fbar.hidden = true; return; }
  let b;
  if (S.selLink) {
    const l = S.links.get(S.selLink); const a = l && rectOf(l.from), c = l && rectOf(l.to);
    if (!a || !c) { fbar.hidden = true; return; }
    const [p1, p2] = anchors(a, c); b = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 10, w: 0, h: 0 };
  } else b = bounds([...S.sel]);
  if (!b) { fbar.hidden = true; return; }
  const key = S.selLink ? 'L' + S.selLink : [...S.sel].join(',') + '|' + [...S.sel].map(id => { const i = S.items.get(id); return i && (i.color + i.size); }).join();
  if (fbar.dataset.key !== key) { fbar.dataset.key = key; fbar.innerHTML = fbarHTML(); }
  let top = S.view.y + b.y * S.view.z - 14;
  const one = S.sel.size === 1 && S.items.get([...S.sel][0]);
  if (one && one.type === 'frame') top -= 30;
  fbar.style.left = clamp(S.view.x + (b.x + b.w / 2) * S.view.z, 160, vpRect().width - 160) + 'px';
  fbar.style.top = Math.max(top, 110) + 'px';
  fbar.hidden = false;
}
const trashSVG = '<svg class="i" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
function fbarHTML() {
  if (S.selLink) return `<button class="del" data-f="del" title="Verbindung löschen">${trashSVG}</button>`;
  const its = [...S.sel].map(id => S.items.get(id)).filter(Boolean);
  const types = new Set(its.map(i => i.type));
  let h = '';
  if (types.size === 1 && types.has('note')) {
    const cur = its[0].color || 'yellow';
    h += NOTE_COLORS.map(c => `<button class="sw${cur === c ? ' on' : ''}" data-f="color" data-v="${c}" title="${c}"><i style="background:${c === 'white' ? 'var(--surface)' : 'var(--n-' + c + ')'}"></i></button>`).join('') + '<span class="sep"></span>';
  }
  if (types.size === 1 && types.has('text')) {
    const cur = its[0].size || 'p';
    h += [['h', 'Titel'], ['s', 'Untertitel'], ['p', 'Text']].map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-f="size" data-v="${v}">${l}</button>`).join('') + '<span class="sep"></span>';
  }
  if (its.length === 1 && ['text', 'note', 'check', 'link', 'frame'].includes(its[0].type)) h += '<button data-f="edit" title="Bearbeiten (Enter)">Bearbeiten</button>';
  if (its.length === 1 && its[0].type === 'link' && /^https?:/.test(its[0].url || '')) h += `<button data-f="open" title="Link öffnen">Öffnen</button>`;
  h += `<button data-f="dup" title="Duplizieren (Strg + D)"><svg class="i" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2.5"/><path d="M5 15V7a2 2 0 0 1 2-2h8"/></svg></button>`;
  h += `<button class="del" data-f="del" title="Löschen (Entf)">${trashSVG}</button>`;
  return h;
}
fbar.addEventListener('pointerdown', (e) => e.stopPropagation());
fbar.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const f = b.dataset.f, v = b.dataset.v;
  if (f === 'del') deleteSelection();
  else if (f === 'dup') duplicateSelection();
  else if (f === 'edit') startEdit([...S.sel][0]);
  else if (f === 'color' || f === 'size') {
    apply([...S.sel].map(id => { const it = S.items.get(id); return itemChange(id, { ...it, [f]: v }); }));
  }
});
// Link-"Öffnen" über echten Anker, weil window.open nicht überall erlaubt ist.
fbar.addEventListener('click', (e) => { if (e.target.closest('[data-f=open]')) { const it = S.items.get([...S.sel][0]); const a = el('a'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; a.click(); e.stopImmediatePropagation(); } }, true);

/* ---------------- Elemente anlegen ---------------- */
function addItem(type, at, extra = {}) {
  if (S.readOnly || !S.boardId) return null;
  const c = at || viewCenter();
  const W0 = { text: 320, note: 240, check: 260, link: 300, frame: 520 }[type] || 260;
  const it = { id: uid(), type, x: Math.round(c.x - (at ? 0 : W0 / 2)), y: Math.round(c.y - (at ? 0 : 40)), w: W0, z: nextZ(), ...extra };
  if (type === 'text') it.size = it.size || 'p', it.text = it.text ?? '';
  if (type === 'note') it.color = it.color || 'yellow', it.text = it.text ?? '';
  if (type === 'check') { it.title = it.title ?? ''; it.items = it.items || [{ id: uid(), t: '', d: false }]; }
  if (type === 'link') { it.url = it.url ?? ''; it.title = it.title ?? ''; }
  if (type === 'frame') { it.h = it.h || 340; it.title = it.title ?? 'Bereich'; it.z = 1; if (!at) it.y = Math.round(c.y - 170); }
  if (!at) { // nicht exakt übereinander stapeln
    for (let k = 0; k < 12 && [...S.items.values()].some(o => Math.abs(o.x - it.x) < 8 && Math.abs(o.y - it.y) < 8); k++) { it.x += 28; it.y += 28; }
  }
  apply([itemChange(it.id, it)]);
  S.sel = new Set([it.id]); S.selLink = null; render();
  return it;
}
// Titel und Vorschaubild einer Webseite holen (nur wo das Backend das kann).
async function enrichLink(id) {
  const it = S.items.get(id); if (!it || it.type !== 'link' || !B.linkMeta || !/^https?:\/\//.test(it.url || '')) return;
  if (it.metaFor === it.url) return;
  const meta = await B.linkMeta(it.url).catch(() => null);
  const cur = S.items.get(id); if (!cur || cur.url !== it.url) return;
  const next = { ...cur, metaFor: cur.url };
  if (meta?.title && (!cur.title || cur.title === hostOf(cur.url))) next.title = meta.title.slice(0, 160);
  if (meta?.image) next.image = meta.image; else delete next.image;
  apply([itemChange(id, next)], { record: false });
}
function addAndEdit(type) { const it = addItem(type); if (it && type !== 'frame') requestAnimationFrame(() => startEdit(it.id, true)); }

$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]'); if (!b) return;
  if (S.readOnly) return toast('Du kannst dieses Board nur ansehen.');
  if (!S.boardId) return toast('Lege zuerst links ein Board an.');
  const t = b.dataset.add;
  if (t === 'media') return $('#fileIn').click();
  if (t === 'frame') { addItem('frame'); return; }
  addAndEdit(t);
});
$('#fileIn').addEventListener('change', (e) => { addFiles([...e.target.files], viewCenter()); e.target.value = ''; });

async function mediaInfo(file) {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      const img = new Image(); img.src = url; await img.decode().catch(() => {});
      return { w: img.naturalWidth || 400, h: img.naturalHeight || 300 };
    }
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video'); v.preload = 'metadata'; v.src = url;
      await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 4000); });
      return { w: v.videoWidth || 16, h: v.videoHeight || 9 };
    }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return null;
}
async function addFiles(files, at) {
  if (S.readOnly) return toast('Du kannst dieses Board nur ansehen.');
  if (!S.boardId) return;
  files = files.filter(Boolean);
  if (!files.length) return;
  let i = 0; const made = [];
  for (const f of files) {
    const type = B.accepts.includes(f.type) ? f.type : guessType(f);
    if (!B.accepts.includes(type)) { toast(`„${f.name}“ geht nicht. Möglich sind ${B.acceptLabel}.${/\.mov$/i.test(f.name) ? ' MOV-Videos bitte als MP4 exportieren.' : ''}`); continue; }
    if (f.size > B.maxBytes) { toast(`„${f.name}“ ist größer als ${Math.round(B.maxBytes / 1048576)} MB. Längere Videos am besten als Link einfügen (YouTube, Vimeo, Drive).`); continue; }
    toast(`Lädt „${f.name}“ hoch …`, 60000);
    try {
      const info = await mediaInfo(f);
      const src = await store.upload(Object.defineProperty(f, 'kbType', { value: type, configurable: true }));
      const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'pdf';
      const w = kind === 'pdf' ? 280 : Math.round(Math.min(kind === 'video' ? 420 : 360, info?.w || 360));
      const extra = { src, name: f.name.slice(0, 120), w };
      if (info) extra.ar = +(info.h / info.w).toFixed(4);
      const it = addItem(kind, { x: Math.round(at.x - w / 2 + i * 32), y: Math.round(at.y - (extra.ar ? w * extra.ar / 2 : 30) + i * 32) }, extra);
      if (it) made.push(it.id); i++;
      hideToast();
    } catch (e) {
      const c = e && e.code;
      toast(c === 'too_large' ? `„${f.name}“ ist zu groß (maximal ${Math.round(B.maxBytes / 1048576)} MB).` : c === 'unsupported_type' ? `Das Format von „${f.name}“ wird nicht unterstützt.` : c === 'quota_or_state' ? 'Der Speicher für Dateien ist voll. Lösche nicht mehr gebrauchte Medien.' : c === 'not_granted' ? 'Hochladen ist für dich hier nicht freigegeben.' : `„${f.name}“ konnte nicht hochgeladen werden. Bitte nochmal versuchen.`);
    }
  }
  if (made.length) { S.sel = new Set(made); render(); }
}

/* ---------------- Bearbeiten von Text ---------------- */
let editStart = null;
function editables(n) { return [...n.querySelectorAll('.txt')]; }
function startEdit(id, selectAll = false) {
  if (S.readOnly) return;
  const it = S.items.get(id); if (!it || !['text', 'note', 'check', 'link', 'frame'].includes(it.type)) return;
  if (S.editing === id) return;
  endEdit();
  S.editing = id; editStart = JSON.parse(JSON.stringify(it));
  S.sel = new Set([id]); S.selLink = null;
  const n = itemEls.get(id); render();
  for (const t of editables(n)) t.contentEditable = 'plaintext-only';
  if (n.querySelector('.txt').contentEditable !== 'plaintext-only') for (const t of editables(n)) t.contentEditable = 'true';
  let target = n.querySelector('.txt');
  if (it.type === 'link' && !it.url) target = n.querySelector('[data-role=url]');
  if (it.type === 'check' && it.title && it.items?.length) { const rows = n.querySelectorAll('.ck-row .txt'); if (rows.length && !rows[rows.length - 1].textContent) target = rows[rows.length - 1]; }
  focusEnd(target, selectAll);
  presence({ edit: id });
  fbar.hidden = true;
}
function focusEnd(node, selectAll) {
  node.focus();
  const r = document.createRange(); r.selectNodeContents(node); if (!selectAll) r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function readEdit(id) {
  const it = S.items.get(id), n = itemEls.get(id); if (!it || !n) return null;
  const txt = (q) => (n.querySelector(q)?.innerText || '').replace(/\n$/, '');
  switch (it.type) {
    case 'text': case 'note': return { ...it, text: txt('.txt') };
    case 'frame': return { ...it, title: txt('.txt') };
    case 'link': { let url = txt('[data-role=url]').trim(); if (url && !/^[a-z]+:\/\//i.test(url)) url = 'https://' + url; return { ...it, title: txt('[data-role=title]'), url }; }
    case 'check': {
      const items = [...n.querySelectorAll('.ck-row')].map(li => { const old = (it.items || []).find(r => r.id === li.dataset.rid); return { id: li.dataset.rid, t: li.querySelector('.txt').innerText.replace(/\n/g, ' ').trim(), d: !!(old && old.d) }; });
      return { ...it, title: txt('[data-role=title]'), items };
    }
  }
}
function onEditInput() {
  if (!S.editing) return;
  const next = readEdit(S.editing); if (!next) return;
  S.items.set(next.id, next);
  write(iPath(next.id), next, 450);
  renderWires(); renderPeerMarks();
}
function endEdit() {
  if (!S.editing) return;
  const id = S.editing; const n = itemEls.get(id);
  let next = readEdit(id);
  S.editing = null;
  if (n) for (const t of editables(n)) t.removeAttribute('contenteditable');
  getSelection()?.removeAllRanges?.();
  presence({ edit: null });
  if (!next) return render();
  if (next.type === 'check') next = { ...next, items: next.items.filter(r => r.t) };
  if (next.type === 'link' && !next.title) next = { ...next, title: hostOf(next.url) };
  const emptyText = (next.type === 'text' && !next.text.trim()) || (next.type === 'note' && !next.text.trim() && !editStart?.text);
  const linkGone = next.type === 'link' && !next.url && !next.title;
  if (emptyText || linkGone) {
    // Leer gelassenes Element wieder entfernen, samt seiner Verbindungen.
    S.items.set(id, editStart);
    const ls = [...S.links.values()].filter(l => l.from === id || l.to === id).map(l => ({ kind: 'link', id: l.id, before: l, after: null }));
    const top = S.undo[S.undo.length - 1];
    const fresh = top && top.changes.some(c => c.id === id && !c.before);
    apply([{ kind: 'item', id, before: editStart, after: null }, ...ls], { record: !fresh });
    if (fresh) S.undo.pop();
    S.sel.delete(id);
    return render();
  }
  if (JSON.stringify(next) !== JSON.stringify(editStart)) {
    S.items.set(id, editStart);
    apply([{ kind: 'item', id, before: editStart, after: next }]);
    if (next.type === 'link') enrichLink(id);
  } else { S.items.set(id, next); render(); }
}
world.addEventListener('input', onEditInput);
world.addEventListener('keydown', (e) => {
  if (!S.editing) return;
  const it = S.items.get(S.editing); const n = itemEls.get(S.editing);
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); endEdit(); return; }
  if (it.type === 'check') {
    const cur = e.target.closest('.txt'); const row = cur?.closest('.ck-row');
    if (e.key === 'Enter') {
      e.preventDefault();
      const li = newCheckRow(); const ul = n.querySelector('.ck-list');
      if (row) row.after(li); else ul.prepend(li);
      focusEnd(li.querySelector('.txt')); onEditInput();
    } else if (e.key === 'Backspace' && row && !cur.textContent) {
      e.preventDefault(); const prev = row.previousElementSibling; row.remove();
      focusEnd(prev ? prev.querySelector('.txt') : n.querySelector('[data-role=title]')); onEditInput();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const all = editables(n); const k = all.indexOf(cur) + (e.key === 'ArrowUp' ? -1 : 1);
      if (all[k]) { e.preventDefault(); focusEnd(all[k]); }
    }
  } else if (it.type === 'link' || it.type === 'frame') {
    if (e.key === 'Enter') { e.preventDefault(); const all = editables(n); const k = all.indexOf(e.target.closest('.txt')) + 1; if (all[k]) focusEnd(all[k]); else endEdit(); }
  }
  e.stopPropagation();
});
function newCheckRow() {
  const li = el('li', 'ck-row'); li.dataset.rid = uid();
  const b = el('button', 'ck-box', CHECK_SVG); b.dataset.act = 'ck';
  const t = el('div', 'txt'); t.dataset.ph = 'Punkt'; t.contentEditable = 'plaintext-only';
  if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
  li.append(b, t); return li;
}
world.addEventListener('focusout', (e) => {
  if (!S.editing) return;
  const n = itemEls.get(S.editing);
  setTimeout(() => { if (S.editing && n && !n.contains(document.activeElement)) endEdit(); }, 0);
});
world.addEventListener('paste', (e) => {
  if (!S.editing) return;
  // Nur reinen Text übernehmen.
  const t = e.clipboardData?.getData('text/plain'); if (t == null) return;
  e.preventDefault(); e.stopPropagation(); document.execCommand('insertText', false, t);
});

/* ---------------- Maus / Touch ---------------- */
let drag = null;
const pointers = new Map();
vp.addEventListener('pointerdown', onDown);
function onDown(e) {
  if (e.button === 2) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { startPinch(); return; }
  closeMenus();
  const t = e.target;
  const itemNode = t.closest('.item');
  const id = itemNode?.dataset.id;

  // Klicks innerhalb des Elements, das gerade bearbeitet wird
  if (S.editing && itemNode && id === S.editing && (t.closest('[contenteditable]') || t.closest('.ck-add'))) {
    if (t.closest('.ck-add')) { e.preventDefault(); const li = newCheckRow(); itemNode.querySelector('.ck-list').appendChild(li); focusEnd(li.querySelector('.txt')); onEditInput(); }
    return;
  }
  if (S.editing && id !== S.editing) endEdit();

  const w = toWorld(e.clientX, e.clientY);
  const base = { pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };

  if (t.classList.contains('port') && !S.readOnly) {
    const r = rectOf(id); const s = t.dataset.side;
    const p1 = { x: r.x + (s === 'l' ? 0 : s === 'r' ? r.w : r.w / 2), y: r.y + (s === 't' ? 0 : s === 'b' ? r.h : r.h / 2), nx: s === 'l' ? -1 : s === 'r' ? 1 : 0, ny: s === 't' ? -1 : s === 'b' ? 1 : 0 };
    drag = { ...base, kind: 'link', from: id, p1, p2: null };
    $('#app').classList.add('linking');
  } else if (t.classList.contains('resize') && !S.readOnly) {
    const it = S.items.get(id);
    drag = { ...base, kind: 'resize', id, orig: it, w0: it.w || itemNode.offsetWidth, h0: it.h || itemNode.offsetHeight };
  } else if (itemNode) {
    const it = S.items.get(id); if (!it) return;
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'ck' && !S.readOnly && S.editing !== id) { e.preventDefault(); toggleCheck(id, t.closest('.ck-row').dataset.rid); return; }
    if (act === 'play' || act === 'sound' || act === 'scrub') { e.preventDefault(); mediaAct(itemNode, act, e); return; }
    if (t.closest('a.lk-open')) return; // Link normal öffnen lassen
    if (e.shiftKey) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.selLink = null; render(); syncSelPresence(); }
    else if (!S.sel.has(id)) { S.sel = new Set([id]); S.selLink = null; render(); syncSelPresence(); }
    if (S.readOnly) return;
    drag = { ...base, kind: 'move', ids: new Set(S.sel), w0: w, starts: null };
  } else if (t.closest('.wire-g')) {
    S.selLink = t.closest('.wire-g').dataset.link; S.sel.clear(); render(); syncSelPresence();
    return;
  } else {
    if (e.shiftKey) drag = { ...base, kind: 'marquee', w0: w, keep: new Set(S.sel) };
    else drag = { ...base, kind: 'pan', vx: S.view.x, vy: S.view.y };
  }
  e.preventDefault();
  vp.setPointerCapture(e.pointerId);
}
vp.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const w = toWorld(e.clientX, e.clientY);
  presence({ cur: [Math.round(w.x), Math.round(w.y)] });
  if (pinch) { doPinch(); return; }
  if (!drag || drag.pid !== e.pointerId) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  if (!drag.moved) { drag.moved = true; dragBegin(); }
  switch (drag.kind) {
    case 'pan': S.view.x = drag.vx + dx; S.view.y = drag.vy + dy; applyView(); break;
    case 'move': {
      const ox = (dx) / S.view.z, oy = (dy) / S.view.z;
      const out = [];
      for (const [id, s] of drag.starts) {
        const it = S.items.get(id); if (!it) continue;
        const nx = Math.round(s.x + ox), ny = Math.round(s.y + oy);
        S.items.set(id, { ...it, x: nx, y: ny }); out.push([id, nx, ny]);
        const n = itemEls.get(id); if (n) { n.style.left = nx + 'px'; n.style.top = ny + 'px'; }
      }
      renderWires(); renderPeerMarks();
      presence({ drag: out.slice(0, 40) });
      break;
    }
    case 'resize': {
      const it = S.items.get(drag.id); if (!it) break;
      const nw = Math.round(clamp(drag.w0 + dx / S.view.z, it.type === 'text' ? 60 : 140, 2400));
      const nh = Math.round(clamp(drag.h0 + dy / S.view.z, 60, 2400));
      const next = { ...it, w: nw };
      if (it.type === 'frame') next.h = Math.max(nh, 120);
      if (it.type === 'note') next.h = nh;
      S.items.set(it.id, next); updateItem(itemEls.get(it.id), next); renderWires(); placeFbar();
      presence({ drag: [[it.id, next.x, next.y, next.w, next.h ?? null]] });
      break;
    }
    case 'link': {
      drag.p2 = { x: w.x, y: w.y, nx: 0, ny: 0 };
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.item');
      for (const n of itemEls.values()) n.classList.toggle('drop', n === over && n.dataset.id !== drag.from && n.dataset.type !== 'frame');
      renderWires(); break;
    }
    case 'marquee': {
      const x1 = Math.min(drag.w0.x, w.x), y1 = Math.min(drag.w0.y, w.y), x2 = Math.max(drag.w0.x, w.x), y2 = Math.max(drag.w0.y, w.y);
      const r = vpRect();
      Object.assign(marquee.style, { left: (Math.min(drag.sx, e.clientX) - r.left) + 'px', top: (Math.min(drag.sy, e.clientY) - r.top) + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
      marquee.hidden = false;
      S.sel = new Set(drag.keep);
      for (const id of S.items.keys()) { const b = rectOf(id); if (b.x < x2 && b.x + b.w > x1 && b.y < y2 && b.y + b.h > y1) S.sel.add(id); }
      for (const [id, n] of itemEls) n.classList.toggle('sel', S.sel.has(id));
      break;
    }
  }
});
function dragBegin() {
  fbar.hidden = true;
  if (drag.kind === 'pan') vp.classList.add('panning');
  if (drag.kind === 'move') {
    // Bereiche nehmen mit, was in ihnen liegt.
    const ids = new Set(drag.ids);
    for (const id of drag.ids) {
      const f = S.items.get(id); if (!f || f.type !== 'frame') continue;
      const fr = rectOf(id);
      for (const [oid] of S.items) { if (ids.has(oid)) continue; const r = rectOf(oid); if (r.x >= fr.x && r.y >= fr.y && r.x + r.w <= fr.x + fr.w && r.y + r.h <= fr.y + fr.h) ids.add(oid); }
    }
    const z0 = nextZ(); let k = 0;
    drag.before = new Map(); drag.starts = new Map();
    for (const id of ids) {
      const it = S.items.get(id); drag.before.set(id, it); drag.starts.set(id, { x: it.x, y: it.y });
      if (it.type !== 'frame' && S.sel.has(id)) S.items.set(id, { ...it, z: z0 + k++ });
    }
    render();
  }
}
const marquee = el('div', 'marquee'); marquee.hidden = true; $('#stage').appendChild(marquee);
vp.addEventListener('pointerup', onUp);
vp.addEventListener('pointercancel', onUp);
function onUp(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  if (!drag || drag.pid !== e.pointerId) return;
  const d = drag; drag = null;
  vp.classList.remove('panning'); $('#app').classList.remove('linking'); marquee.hidden = true;
  if (d.kind === 'pan' && !d.moved) { if (S.sel.size || S.selLink) { S.sel.clear(); S.selLink = null; syncSelPresence(); } }
  if (d.kind === 'move' && d.moved) {
    const changes = [];
    for (const [id, before] of d.before) { const after = S.items.get(id); if (after && (after.x !== before.x || after.y !== before.y || after.z !== before.z)) changes.push({ kind: 'item', id, before, after }); }
    for (const c of changes) S.items.set(c.id, c.before);
    apply(changes);
    presence({ drag: null });
  }
  if (d.kind === 'resize' && d.moved) {
    const after = S.items.get(d.id);
    S.items.set(d.id, d.orig);
    if (after) apply([{ kind: 'item', id: d.id, before: d.orig, after }]);
    presence({ drag: null });
  }
  if (d.kind === 'link') {
    for (const n of itemEls.values()) n.classList.remove('drop');
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.item');
    const to = over?.dataset.id;
    if (to && to !== d.from && S.items.get(to)?.type !== 'frame') {
      const exists = [...S.links.values()].some(l => (l.from === d.from && l.to === to) || (l.from === to && l.to === d.from));
      if (!exists) { const l = { id: uid(), from: d.from, to }; apply([{ kind: 'link', id: l.id, before: null, after: l }]); }
    } else if (!to && d.moved) {
      // Ins Leere gezogen: neue Notiz an dieser Stelle, direkt verbunden.
      const w = toWorld(e.clientX, e.clientY);
      const it = { id: uid(), type: 'note', color: S.items.get(d.from)?.color || 'yellow', text: '', x: Math.round(w.x - 120), y: Math.round(w.y - 30), w: 240, z: nextZ() };
      const l = { id: uid(), from: d.from, to: it.id };
      apply([itemChange(it.id, it), { kind: 'link', id: l.id, before: null, after: l }]);
      S.sel = new Set([it.id]); requestAnimationFrame(() => startEdit(it.id));
    }
    renderWires();
  }
  render(); syncSelPresence();
}
vp.addEventListener('dblclick', (e) => {
  if (S.readOnly) return;
  const n = e.target.closest('.item');
  if (n) { if (e.target.closest('[data-act], a')) return; startEdit(n.dataset.id); return; }
  if (e.target.closest('.wire-g')) return;
  const w = toWorld(e.clientX, e.clientY);
  const it = addItem('text', { x: Math.round(w.x - 8), y: Math.round(w.y - 14) });
  if (it) requestAnimationFrame(() => startEdit(it.id));
});
vp.addEventListener('pointerleave', () => presence({ cur: null }));

// Zwei-Finger-Zoom auf Touch-Geräten
let pinch = null;
function startPinch() {
  drag = null; const [a, b] = [...pointers.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.view.z, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: S.view.x, vy: S.view.y };
}
function doPinch() {
  const [a, b] = [...pointers.values()]; if (!a || !b) return;
  const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  S.view.x = pinch.vx + (cx - pinch.cx); S.view.y = pinch.vy + (cy - pinch.cy); S.view.z = pinch.z;
  zoomAt(cx, cy, pinch.z * d / pinch.d);
}

vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || e.metaKey || mouseWheel) {
    const k = e.deltaMode === 1 ? 0.05 : mouseWheel ? 0.0015 : 0.01;
    zoomAt(e.clientX, e.clientY, S.view.z * Math.exp(-e.deltaY * k));
  } else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView(); }
}, { passive: false });

function toggleCheck(id, rid) {
  const it = S.items.get(id); if (!it) return;
  apply([itemChange(id, { ...it, items: it.items.map(r => r.id === rid ? { ...r, d: !r.d } : r) })]);
}
function mediaAct(n, act, e) {
  const v = n.querySelector('video'); if (!v) return;
  if (act === 'play') v.paused ? v.play().catch(() => {}) : v.pause();
  if (act === 'sound') { v.muted = !v.muted; n.querySelector('.v-sound .w').style.opacity = v.muted ? 0 : 1; }
  if (act === 'scrub') { const r = e.target.closest('.v-scrub').getBoundingClientRect(); if (v.duration) v.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * v.duration; }
}

/* ---------------- Auswahl-Aktionen ---------------- */
function deleteSelection() {
  if (S.readOnly) return;
  if (S.selLink) { const l = S.links.get(S.selLink); S.selLink = null; if (l) apply([{ kind: 'link', id: l.id, before: l, after: null }]); return; }
  if (!S.sel.size) return;
  const ids = new Set(S.sel);
  const changes = [...ids].map(id => ({ kind: 'item', id, before: S.items.get(id), after: null })).filter(c => c.before);
  for (const l of S.links.values()) if (ids.has(l.from) || ids.has(l.to)) changes.push({ kind: 'link', id: l.id, before: l, after: null });
  S.sel.clear(); apply(changes); syncSelPresence();
}
function cloneItems(list, links, dx = 32, dy = 32) {
  const map = new Map(); const changes = []; let z = nextZ();
  for (const it of list) { const nid = uid(); map.set(it.id, nid); changes.push({ kind: 'item', id: nid, before: null, after: { ...it, id: nid, x: Math.round(it.x + dx), y: Math.round(it.y + dy), z: it.type === 'frame' ? it.z : z++ } }); }
  for (const l of links) if (map.has(l.from) && map.has(l.to)) { const lid = uid(); changes.push({ kind: 'link', id: lid, before: null, after: { id: lid, from: map.get(l.from), to: map.get(l.to) } }); }
  apply(changes);
  S.sel = new Set(map.values()); S.selLink = null; render(); syncSelPresence();
}
function duplicateSelection() {
  if (!S.sel.size || S.readOnly) return;
  cloneItems([...S.sel].map(id => S.items.get(id)).filter(Boolean), [...S.links.values()]);
}

/* ---------------- Tastatur ---------------- */
document.addEventListener('keydown', (e) => {
  if (S.editing || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); S.sel = new Set(S.items.keys()); S.selLink = null; render(); syncSelPresence(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if (mod && k === '0') { e.preventDefault(); fitView(); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomBy(1.2); return; }
  if (mod && k === '-') { e.preventDefault(); zoomBy(1 / 1.2); return; }
  if (mod) return;
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelection(); return; }
  if (k === 'escape') { S.sel.clear(); S.selLink = null; closeMenus(); render(); syncSelPresence(); return; }
  if (k === 'enter' && S.sel.size === 1) { e.preventDefault(); startEdit([...S.sel][0]); return; }
  if (k.startsWith('arrow') && S.sel.size && !S.readOnly) {
    e.preventDefault(); const st = e.shiftKey ? 20 : 2;
    const dx = k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0, dy = k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0;
    apply([...S.sel].map(id => { const it = S.items.get(id); return itemChange(id, { ...it, x: it.x + dx, y: it.y + dy }); }), { delay: 300 });
    return;
  }
  if (!S.boardId || S.readOnly) return;
  const add = { t: 'text', n: 'note', c: 'check', l: 'link' }[k];
  if (add) { e.preventDefault(); addAndEdit(add); }
  if (k === 'b') { e.preventDefault(); addItem('frame'); }
});

/* ---------------- Zwischenablage + Drag & Drop ---------------- */
const CLIP = 'kampagnenboard:';
document.addEventListener('copy', (e) => {
  if (S.editing || e.target.closest?.('input, [contenteditable]') || !S.sel.size) return;
  const list = [...S.sel].map(id => S.items.get(id)).filter(Boolean);
  const ids = new Set(list.map(i => i.id));
  e.clipboardData.setData('text/plain', CLIP + JSON.stringify({ items: list, links: [...S.links.values()].filter(l => ids.has(l.from) && ids.has(l.to)) }));
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (S.editing || e.target.closest?.('input, [contenteditable]') || !S.sel.size) return;
  const list = [...S.sel].map(id => S.items.get(id)).filter(Boolean); const ids = new Set(list.map(i => i.id));
  e.clipboardData.setData('text/plain', CLIP + JSON.stringify({ items: list, links: [...S.links.values()].filter(l => ids.has(l.from) && ids.has(l.to)) }));
  e.preventDefault(); deleteSelection();
});
document.addEventListener('paste', (e) => {
  if (S.editing || e.target.closest?.('input, textarea, [contenteditable]') || !S.boardId || S.readOnly) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files, viewCenter()); return; }
  const text = (e.clipboardData?.getData('text/plain') || '').trim(); if (!text) return;
  e.preventDefault();
  if (text.startsWith(CLIP)) {
    try {
      const d = JSON.parse(text.slice(CLIP.length)); const b = { x: Math.min(...d.items.map(i => i.x)), y: Math.min(...d.items.map(i => i.y)) };
      const c = viewCenter(); const known = d.items.every(i => !S.items.has(i.id));
      cloneItems(d.items, d.links, known ? c.x - b.x - 100 : 32, known ? c.y - b.y - 60 : 32);
    } catch {}
    return;
  }
  if (/^https?:\/\/\S+$/i.test(text)) { const it = addItem('link', null, { url: text, title: hostOf(text) }); if (it) enrichLink(it.id); return; }
  addItem(text.length > 80 || text.includes('\n') ? 'note' : 'text', null, { text });
});
let dragDepth = 0; const veil = el('div', 'drop-veil', 'Loslassen zum Einfügen'); veil.hidden = true; $('#stage').appendChild(veil);
$('#stage').addEventListener('dragenter', (e) => { if (!S.boardId || S.readOnly) return; e.preventDefault(); dragDepth++; veil.hidden = false; });
$('#stage').addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; veil.hidden = true; } });
$('#stage').addEventListener('dragover', (e) => { e.preventDefault(); });
$('#stage').addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; veil.hidden = true;
  if (!S.boardId || S.readOnly) return;
  const at = toWorld(e.clientX, e.clientY);
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) return addFiles(files, at);
  const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').trim().split('\n')[0];
  if (/^https?:\/\//i.test(url)) { const it = addItem('link', { x: Math.round(at.x - 150), y: Math.round(at.y - 32) }, { url, title: hostOf(url) }); if (it) enrichLink(it.id); }
  else if (url) addItem('note', { x: Math.round(at.x - 120), y: Math.round(at.y - 30) }, { text: url });
});

/* ---------------- Seitenleiste ---------------- */
function relTime(t) {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'Heute, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Gestern';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}
function renderBoards() {
  const ul = $('#boards'); ul.innerHTML = '';
  const where = new Map();
  for (const p of S.peers) if (!p.self && p.presence?.pid) { if (!where.has(p.presence.pid)) where.set(p.presence.pid, []); where.get(p.presence.pid).push(peerColor(p)); }
  for (const [id, b] of sortedBoards()) {
    const li = el('li', 'board' + (id === S.boardId ? ' on' : '')); li.dataset.id = id; li.tabIndex = 0;
    const main = el('div'); main.style.minWidth = '0';
    const nm = el('div', 'b-name'); nm.textContent = b.name || 'Ohne Namen';
    const meta = el('div', 'b-meta'); const time = el('span'); time.textContent = relTime(b.updatedAt || b.createdAt); meta.appendChild(time);
    if (where.has(id)) { const dots = el('span', 'b-dots'); for (const c of where.get(id).slice(0, 4)) { const i = el('i'); i.style.background = c; dots.appendChild(i); } meta.appendChild(dots); }
    main.append(nm, meta);
    const more = el('button', 'b-more', '<svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/></svg>');
    more.setAttribute('aria-label', 'Board-Optionen'); more.hidden = S.readOnly;
    li.append(main, more); ul.appendChild(li);
  }
}
$('#boards').addEventListener('click', (e) => {
  const li = e.target.closest('.board'); if (!li) return;
  if (e.target.closest('.b-more')) { e.stopPropagation(); boardMenu(li.dataset.id, e.target.closest('.b-more')); return; }
  if (!e.target.closest('input')) openBoard(li.dataset.id);
});
$('#boards').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('board')) openBoard(e.target.dataset.id); });
$('#boards').addEventListener('dblclick', (e) => { const li = e.target.closest('.board'); if (li && !S.readOnly) renameBoardInline(li.dataset.id); });
function renameBoardInline(id) {
  const li = $(`.board[data-id="${id}"]`); if (!li) return;
  const nm = li.querySelector('.b-name'); const inp = el('input', 'b-rename'); inp.value = S.boards.get(id)?.name || '';
  inp.id = 'rename-' + id; nm.replaceWith(inp); inp.focus(); inp.select();
  const done = (save) => { if (!inp.isConnected) return; if (save) renameBoard(id, inp.value); renderBoards(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
  inp.addEventListener('blur', () => done(true));
}
function renameBoard(id, name) {
  name = name.trim().slice(0, 80) || 'Ohne Namen';
  const b = S.boards.get(id); if (!b || b.name === name) return;
  const nb = { ...b, name, updatedAt: Date.now() }; S.boards.set(id, nb); write(bPath(id), nb);
  renderBoards(); updateTitle();
}
function updateTitle() { const b = S.boards.get(S.boardId); const t = $('#title'); if (document.activeElement !== t) t.value = b ? b.name : ''; t.disabled = !b || S.readOnly; }
$('#title').addEventListener('change', (e) => renameBoard(S.boardId, e.target.value));
$('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { updateTitle(); e.target.blur(); } });
$('#newBoard').addEventListener('click', (e) => {
  if (S.readOnly) return toast('Du kannst hier nur ansehen.');
  openMenu(e.currentTarget, [['Leeres Board', () => createBoard(false)], ['Mit Kampagnen-Vorlage', () => createBoard(true)]]);
});
function boardMenu(id, anchor) {
  openMenu(anchor, [
    ['Umbenennen', () => renameBoardInline(id)],
    ['Duplizieren', () => duplicateBoard(id)],
    null,
    ['Löschen', () => deleteBoard(id), 'danger'],
  ]);
}
$('#hideSide').addEventListener('click', () => setSide(false));
$('#showSide').addEventListener('click', () => setSide(true));
function setSide(show) {
  const app = $('#app');
  if (window.innerWidth <= 760) app.classList.toggle('side-open', show);
  else { app.classList.toggle('side-hidden', !show); lsSet('kb-side', show); }
  $('#showSide').hidden = window.innerWidth > 760 && show;
}
if (window.innerWidth > 760 && lsGet('kb-side', true) === false) setSide(false);
if (window.innerWidth <= 760) $('#showSide').hidden = false;

/* ---------------- Menüs, Dialoge, Hinweise ---------------- */
let menuEl = null;
function closeMenus() { menuEl?.remove(); menuEl = null; $('#sharePop')?.remove(); }
function openMenu(anchor, entries) {
  closeMenus();
  menuEl = el('div', 'menu glass'); menuEl.setAttribute('role', 'menu');
  for (const en of entries) {
    if (!en) { menuEl.appendChild(el('hr')); continue; }
    const b = el('button', en[2] || ''); b.textContent = en[0]; b.setAttribute('role', 'menuitem');
    b.onclick = () => { closeMenus(); en[1](); }; menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  const r = anchor.getBoundingClientRect();
  menuEl.style.left = clamp(r.left, 8, innerWidth - menuEl.offsetWidth - 8) + 'px';
  menuEl.style.top = clamp(r.bottom + 6, 8, innerHeight - menuEl.offsetHeight - 8) + 'px';
  menuEl.querySelector('button')?.focus();
}
document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenus(); if ($('#sharePop') && !e.target.closest('#sharePop, #shareBtn')) $('#sharePop').remove(); }, true);
function confirmBox(title, text, okLabel) {
  return new Promise((res) => {
    const c = el('div', 'confirm'); const box = el('div', 'box glass');
    const h = el('h3'); h.textContent = title; const p = el('p'); p.textContent = text;
    const row = el('div', 'row'); const no = el('button'); no.textContent = 'Abbrechen'; const yes = el('button', 'danger'); yes.textContent = okLabel;
    row.append(no, yes); box.append(h, p, row); c.appendChild(box); document.body.appendChild(c); yes.focus();
    const done = (v) => { c.remove(); res(v); };
    no.onclick = () => done(false); yes.onclick = () => done(true); c.onclick = (e) => { if (e.target === c) done(false); };
    c.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
  });
}
let toastEl = null, toastT = 0;
function toast(msg, ms = 4200) {
  if (!toastEl) { toastEl = el('div', 'toast glass'); toastEl.setAttribute('role', 'status'); $('#stage').appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(hideToast, ms);
}
function hideToast() { if (toastEl) toastEl.hidden = true; }
$('#shareBtn').addEventListener('click', () => {
  if ($('#sharePop')) return $('#sharePop').remove();
  const p = el('div', 'pop glass'); p.id = 'sharePop';
  $('#stage').appendChild(p);
  B.shareUI(p, () => p.remove());
});
function showEmpty() {
  if ($('#empty')) return;
  S.boardId = null; updateTitle(); render();
  const e = el('div', 'empty'); e.id = 'empty';
  e.innerHTML = `<div class="empty-in"><h2>Dein erstes Kampagnen-Board</h2>
    <p>Texte, Notizen, Checklisten, Links, Bilder und Videos frei anordnen und mit Linien verbinden. Zu zweit, live.</p>
    <div class="row"><button class="btn primary" data-t="1">Mit Vorlage starten</button><button class="btn" data-t="0">Leeres Board</button></div></div>`;
  e.addEventListener('click', (ev) => { const b = ev.target.closest('[data-t]'); if (!b) return; if (S.readOnly) return toast('Du kannst hier nur ansehen.'); e.remove(); createBoard(b.dataset.t === '1'); });
  $('#stage').appendChild(e);
}
function setReadOnly(v) {
  S.readOnly = v; $('#tools').hidden = v; $('#newBoard').hidden = v; updateTitle(); renderBoards(); render();
  if (v) { endEdit(); $('#sync span').textContent = 'Nur ansehen'; }
}
$('#zIn').onclick = () => zoomBy(1.2);
$('#zOut').onclick = () => zoomBy(1 / 1.2);
$('#zVal').onclick = () => fitView();
window.addEventListener('resize', () => { placeFbar(); renderCursors(); });

/* ---------------- Live: Mitarbeitende ---------------- */
let presState = {};
function presence(patch) {
  Object.assign(presState, patch);
  if (B?.presence) B.presence(patch);
}
function syncSelPresence() { presence({ sel: [...S.sel].slice(0, 60), pid: S.boardId }); }
// Jede Person: { peer, self, mine, key, name, color, avatar, presence, updatedAt }
const peerColor = (p) => p.color || hueColor(p.peer);
const peerName = (p) => p.name || 'Gast';
function onPeers(peers) {
  S.peers = peers;
  // Live-Bewegungen anderer übernehmen
  const now = Date.now(); const touched = new Set();
  for (const p of S.peers) {
    if (p.self || p.presence?.pid !== S.boardId || !Array.isArray(p.presence.drag)) continue;
    for (const d of p.presence.drag) { if (!Array.isArray(d)) continue; const [id, x, y, w, h] = d; if (typeof id !== 'string' || !S.items.has(id) || (drag && drag.starts?.has(id))) continue;
      S.peerDrag.set(id, { x: +x, y: +y, w: w == null ? undefined : +w, h: h == null ? undefined : +h, t: now }); touched.add(id); }
  }
  for (const id of touched) { const n = itemEls.get(id); if (n) updateItem(n, S.items.get(id)); }
  if (touched.size) renderWires();
  renderCursors();
  const sig = JSON.stringify(S.peers.map(p => [p.peer, p.name, p.color, p.presence?.pid, p.presence?.sel, p.presence?.edit]));
  if (sig !== onPeers.sig) { onPeers.sig = sig; renderAvatars(); renderPeerMarks(); if (!document.querySelector('.b-rename')) renderBoards(); }
}
function others() { return S.peers.filter(p => !p.self); }
function renderAvatars() {
  const box = $('#avatars'); box.innerHTML = '';
  const seen = new Set(); const list = [];
  for (const p of [...S.peers].sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0))) { const key = p.key || p.peer; if (seen.has(key)) continue; seen.add(key); list.push(p); }
  for (const p of list.slice(0, 6)) {
    const b = el('button'); b.style.setProperty('--pc', peerColor(p));
    const name = p.self || p.mine ? 'Du' : peerName(p);
    const here = p.presence?.pid === S.boardId;
    b.title = name + (p.self ? '' : here ? ' – in diesem Board' : ' – in einem anderen Board');
    b.setAttribute('aria-label', b.title);
    if (p.avatar) { const img = el('img'); img.src = p.avatar; img.alt = ''; b.appendChild(img); }
    else b.textContent = ((p.self ? p.name : name) || '?')[0].toUpperCase();
    if (!p.self) b.onclick = () => followPeer(p.peer);
    if (!here && !p.self) b.style.opacity = .5;
    box.appendChild(b);
  }
  $('#people').querySelector('.avatars').hidden = list.length === 0;
}
function followPeer(peer) {
  const p = S.peers.find(x => x.peer === peer); if (!p) return;
  if (p.presence?.pid && p.presence.pid !== S.boardId && S.boards.has(p.presence.pid)) openBoard(p.presence.pid);
  const c = p.presence?.cur; if (!Array.isArray(c)) return;
  const r = vpRect(); animateView({ z: S.view.z, x: r.width / 2 - c[0] * S.view.z, y: r.height / 2 - c[1] * S.view.z });
}
const curEls = new Map();
const CURSOR_SVG = '<svg viewBox="0 0 18 22"><path d="M1.5 1.5v16.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.4h6z" fill="var(--pc)" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
function renderCursors() {
  const box = $('#cursors'); const live = new Set();
  for (const p of others()) {
    const c = p.presence?.cur;
    if (p.presence?.pid !== S.boardId || !Array.isArray(c)) continue;
    live.add(p.peer);
    let n = curEls.get(p.peer);
    if (!n) { n = el('div', 'cursor', CURSOR_SVG + '<span></span>'); curEls.set(p.peer, n); box.appendChild(n); }
    n.style.setProperty('--pc', peerColor(p));
    n.querySelector('span').textContent = peerName(p);
    n.style.transform = `translate(${S.view.x + (+c[0]) * S.view.z}px, ${S.view.y + (+c[1]) * S.view.z}px)`;
    n.style.opacity = Date.now() - p.updatedAt > 60000 ? .4 : 1;
  }
  for (const [k, n] of curEls) if (!live.has(k)) { n.remove(); curEls.delete(k); }
}
function renderPeerMarks() {
  for (const n of itemEls.values()) { n.querySelectorAll('.peer-ring, .peer-tag').forEach(x => x.remove()); }
  for (const p of others()) {
    if (p.presence?.pid !== S.boardId) continue;
    const ids = new Set([...(Array.isArray(p.presence.sel) ? p.presence.sel : []), p.presence.edit].filter(x => typeof x === 'string'));
    let tagged = false;
    for (const id of ids) {
      const n = itemEls.get(id); if (!n) continue;
      const ring = el('div', 'peer-ring'); ring.style.setProperty('--pc', peerColor(p)); n.appendChild(ring);
      if (!tagged) { const t = el('div', 'peer-tag'); t.style.setProperty('--pc', peerColor(p)); t.textContent = peerName(p) + (p.presence.edit === id ? ' schreibt …' : ''); n.appendChild(t); tagged = true; }
    }
  }
}
setInterval(() => { // abgelaufene Live-Positionen aufräumen
  const now = Date.now(); let ch = false;
  for (const [id, d] of S.peerDrag) if (now - d.t > 4000) { S.peerDrag.delete(id); ch = true; }
  if (ch) render();
}, 2000);

/* ---------------- Start ---------------- */
async function boot() {
  applyView();
  B = await window.KB_BACKEND();
  if (B.desktop) document.documentElement.classList.add('desktop');
  S.me = { id: B.me?.id || null, name: B.me?.name || '', color: B.me?.color || '#0071e3' };
  if (B.me?.name) $('#whoami').textContent = B.me.name;
  if (B.canWrite === false) setReadOnly(true);
  $('#fileIn').accept = B.accepts.join(',');
  $('#sideFoot').innerHTML = B.footHTML;
  if (B.onPeers) B.onPeers(onPeers);
  presence({ ...presState, color: S.me.color || null });
  syncState();
  store.watchBoards((list) => boardsSnapshot(list));
}
boot();
