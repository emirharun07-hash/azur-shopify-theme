'use strict';
/* Eigene Cloud (Supabase): Tabelle kb_docs für Boards, Speicher "kb-media" für Dateien,
   Realtime für Live-Änderungen und Anwesenheit (Cursor, Auswahl). Einrichtung: supabase/setup.sql */
window.KBCloud = function KBCloud({ url, key, me, base }) {
  const sb = window.supabase.createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 40 } },
  });
  const TABLE = 'kb_docs', BUCKET = 'kb-media';
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const idOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const cache = new Map();    // parent -> Map(id -> data)
  const watchers = new Map(); // parent -> Set(cb)
  const emit = (parent) => { const m = cache.get(parent); if (m) for (const cb of watchers.get(parent) || []) cb([...m.entries()]); };
  const api = { connected: true };

  async function load(parent) {
    const out = new Map(); let from = 0;
    for (;;) {
      const { data, error } = await sb.from(TABLE).select('path,data').eq('parent', parent).range(from, from + 999);
      if (error) throw error;
      for (const r of data) out.set(idOf(r.path), r.data);
      if (data.length < 1000) break; from += 1000;
    }
    return out;
  }
  async function refresh(parent) {
    try {
      const fresh = await load(parent); const old = cache.get(parent);
      const same = old && old.size === fresh.size && JSON.stringify([...old]) === JSON.stringify([...fresh]);
      cache.set(parent, fresh); if (!same) emit(parent); setConn(true);
    }
    catch { setConn(false); }
  }
  function setConn(v) { if (api.connected !== v) { api.connected = v; syncState(); } }

  // Änderungen anderer, live. Blockiert ein Netzwerk WebSockets, wird stattdessen alle 4 Sekunden nachgefragt.
  let wasDown = false, live = false;
  const setLive = (v) => { if (live !== v) { live = v; syncState(); } };
  sb.channel('kb-docs')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, (p) => {
      const row = p.eventType === 'DELETE' ? p.old : p.new;
      if (!row?.path) return;
      const parent = parentOf(row.path), m = cache.get(parent); if (!m) return;
      if (p.eventType === 'DELETE') m.delete(idOf(row.path)); else m.set(idOf(row.path), row.data);
      emit(parent);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') { setLive(true); if (wasDown) for (const parent of watchers.keys()) refresh(parent); wasDown = false; }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { wasDown = true; setLive(false); }
    });
  // Sicherheitsnetz, falls ein Ereignis verloren geht
  setInterval(() => { if (document.visibilityState === 'visible') for (const parent of watchers.keys()) refresh(parent); }, 60000);
  setInterval(() => { if (!live && document.visibilityState === 'visible') for (const parent of watchers.keys()) refresh(parent); }, 4000);
  window.addEventListener('focus', () => { for (const parent of watchers.keys()) refresh(parent); });

  // Anwesenheit: jede offene App sendet ihren Zustand (Cursor, Board, Auswahl)
  const peerId = Math.random().toString(36).slice(2, 12);
  const state = {}; const peers = new Map(); let peersCb = null;
  const room = sb.channel('kb-room', { config: { presence: { key: peerId }, broadcast: { self: false } } });
  const selfPeer = () => ({ peer: peerId, self: true, mine: true, key: 'me', name: me.name, color: me.color, avatar: '', presence: { ...state }, updatedAt: Date.now() });
  const notify = () => { if (peersCb) peersCb([selfPeer(), ...peers.values()]); };
  let sendT = 0, lastSend = 0, joined = false;
  const send = () => {
    if (!joined) return;
    lastSend = Date.now();
    room.send({ type: 'broadcast', event: 'p', payload: { peer: peerId, name: me.name, color: me.color, state } }).catch(() => {});
  };
  const sendSoon = () => { clearTimeout(sendT); const wait = Math.max(0, 40 - (Date.now() - lastSend)); sendT = setTimeout(send, wait); };
  room.on('broadcast', { event: 'p' }, ({ payload }) => {
    if (!payload || payload.peer === peerId || typeof payload.peer !== 'string') return;
    peers.set(payload.peer, { peer: payload.peer, self: false, mine: false, key: payload.peer, name: String(payload.name || '').slice(0, 60), color: String(payload.color || ''), avatar: '', presence: payload.state || {}, updatedAt: Date.now() });
    notify();
  });
  room.on('presence', { event: 'sync' }, () => {
    const online = room.presenceState(); let changed = false;
    for (const k of [...peers.keys()]) if (!online[k]) { peers.delete(k); changed = true; }
    for (const [k, metas] of Object.entries(online)) if (k !== peerId && !peers.has(k)) {
      const m = metas[0] || {}; peers.set(k, { peer: k, self: false, mine: false, key: k, name: m.name || '', color: m.color || '', avatar: '', presence: {}, updatedAt: Date.now() }); changed = true;
    }
    if (changed) { notify(); send(); }
  });
  room.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') { joined = true; try { await room.track({ name: me.name, color: me.color }); } catch {} send(); }
  });
  setInterval(() => { if (joined) send(); }, 10000);

  return Object.assign(api, {
    kind: 'cloud', desktop: true, me, canWrite: true,
    get savedLabel() { return live ? 'Live verbunden' : 'Gespeichert · Live getrennt'; },
    accepts: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf'],
    acceptLabel: 'JPG, PNG, GIF, WebP, SVG, MP4, MOV, WebM und PDF',
    maxBytes: 50 * 1024 * 1024,
    externalImages: true,
    footHTML: '<b>Mit eurer Cloud verbunden.</b> Alle, die die App mit dieser Cloud nutzen, sehen diese Boards und arbeiten live mit.',
    watchColl(parent, cb) {
      if (!watchers.has(parent)) watchers.set(parent, new Set());
      watchers.get(parent).add(cb);
      if (cache.has(parent)) setTimeout(() => cb([...cache.get(parent).entries()]));
      else refresh(parent);
      return () => watchers.get(parent)?.delete(cb);
    },
    async getColl(parent) { return [...(await load(parent)).entries()]; },
    async set(path, data) {
      const parent = parentOf(path);
      cache.get(parent)?.set(idOf(path), data);
      const { error } = await sb.from(TABLE).upsert({ path, parent, data, updated_at: new Date().toISOString() });
      if (error) { setConn(false); throw { code: 'unavailable', message: error.message }; }
      setConn(true);
    },
    async del(path) {
      cache.get(parentOf(path))?.delete(idOf(path));
      const { error } = await sb.from(TABLE).delete().eq('path', path);
      if (error) { setConn(false); throw { code: 'unavailable', message: error.message }; }
    },
    async upload(file) {
      const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(name, file, { contentType: file.kbType || file.type || undefined, upsert: false });
      if (error) throw { code: /size|large/i.test(error.message) ? 'too_large' : 'upstream_error', message: error.message };
      return 'sb:' + name;
    },
    mediaURL(src) {
      if (src.startsWith('sb:')) return sb.storage.from(BUCKET).getPublicUrl(src.slice(3)).data.publicUrl;
      if (src.startsWith('file:') && base?.mediaURL) return base.mediaURL(src);
      return src;
    },
    presence(patch) { Object.assign(state, patch); for (const k in patch) if (patch[k] === null) delete state[k]; sendSoon(); },
    onPeers(cb) { peersCb = cb; notify(); },
    linkMeta: base?.linkMeta,
    shareUI: base?.shareUI,
    client: sb,
  });
};

/* Verbindung prüfen, bevor die App umschaltet. Gibt eine verständliche Fehlermeldung zurück oder null. */
window.KBCloudCheck = async function (url, key) {
  try {
    const sb = window.supabase.createClient(url, key, { auth: { persistSession: false } });
    const { error } = await sb.from('kb_docs').select('path').limit(1);
    if (!error) {
      const s = await sb.storage.from('kb-media').list('', { limit: 1 });
      if (s.error) return 'Der Speicher für Dateien fehlt. Bitte Schritt 2 (SQL ausführen) wiederholen.';
      return null;
    }
    if (/relation|does not exist|schema cache/i.test(error.message)) return 'Die Tabelle fehlt noch. Bitte Schritt 2 (SQL ausführen) machen.';
    if (/fetch|network|Load failed/i.test(error.message)) return 'Keine Verbindung. Prüfe die Project URL (endet auf .supabase.co) und deine Internetverbindung.';
    if (/Invalid API key|JWT|apikey/i.test(error.message)) return 'Der Schlüssel passt nicht. Nimm den „anon public“-Schlüssel aus Project Settings → API.';
    return 'Verbindung fehlgeschlagen: ' + error.message;
  } catch (e) {
    return 'Keine Verbindung. Prüfe die Project URL (beginnt mit https:// und endet auf .supabase.co).';
  }
};
