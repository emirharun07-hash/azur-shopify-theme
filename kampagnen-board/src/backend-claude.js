'use strict';
/* claude.ai: geteilte Speicherung (db), Live-Anwesenheit (room), Dateien (assets), Personen (user).
   Ohne claude.ai (lokale Vorschau im Browser) wird im Browser-Speicher gearbeitet. */
window.KB_BACKEND = async function () {
  const has = typeof window.claude?.use === 'function';
  const [db, room, assets, user] = has
    ? await Promise.all(['db', 'room', 'assets', 'user'].map(n => window.claude.use(n).catch(() => null)))
    : [null, null, null, null];
  const ACCEPTS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'application/pdf'];
  const ACCEPT_LABEL = 'JPG, PNG, GIF, WebP, SVG, MP4, WebM und PDF';

  if (!db) {
    let docs = {};
    try { docs = JSON.parse(localStorage.getItem('kb-local') || '{}'); } catch {}
    return window.KBLocal({
      docs,
      save: (d) => { try { localStorage.setItem('kb-local', JSON.stringify(d)); } catch {} },
      upload: (file) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); }),
      mediaURL: (src) => src,
      accepts: ACCEPTS, acceptLabel: ACCEPT_LABEL, maxBytes: 4 * 1024 * 1024,
      savedLabel: 'Nur in diesem Browser',
      footHTML: '<b>Vorschau-Modus:</b> Ohne claude.ai wird nur in diesem Browser gespeichert und nicht geteilt.',
      shareUI: (box) => { box.innerHTML = '<h3>Vorschau-Modus</h3><p>Geteilt wird nur in der Version auf claude.ai oder in der Windows-App.</p>'; },
    });
  }

  let me = { id: null, name: '', color: '#0071e3', avatar: '' };
  let canWrite = null;
  if (user) {
    try { const m = await user.me(); me = { id: m.id, name: m.name, color: m.color, avatar: m.avatarUrl }; } catch {}
    try { canWrite = await user.can('data.write'); } catch {}
  }
  const fail = (e) => {
    if (e && e.code === 'revoked') setReadOnly(true);
    toast('Verbindung zur Speicherung unterbrochen. Lade die Seite neu, falls Änderungen fehlen.');
  };
  const profiles = {};

  return {
    kind: 'claude',
    me, canWrite,
    connected: true,
    savedLabel: 'Gespeichert',
    accepts: ACCEPTS, acceptLabel: ACCEPT_LABEL, maxBytes: 20 * 1024 * 1024,
    footHTML: '<b>Zu zweit arbeiten:</b> Teile diese Seite über „Teilen“ in claude.ai. Wer drin ist, erscheint live mit eigenem Cursor.',
    externalImages: false,
    watchColl: (path, cb) => db.collection(path).onSnapshot(q => cb(q.docs.map(d => [d.id, d.data()])), fail),
    getColl: async (path) => (await db.collection(path).get()).docs.map(d => [d.id, d.data()]),
    set: (path, data) => db.doc(path).set(data),
    del: (path) => db.doc(path).delete(),
    async upload(file) {
      if (!assets) throw { code: 'not_granted' };
      const type = file.kbType || file.type;
      const r = await assets.upload(file, file.type === type ? undefined : { type });
      return 'blob:' + r.id;
    },
    mediaURL: (src) => src.startsWith('blob:') ? '/_blob/' + src.slice(5) : src,
    presence(patch) { if (room) room.presence(patch).catch(() => {}); },
    onPeers(cb) {
      if (!room) return;
      room.onPeers(async (ch) => {
        const list = ch.peers.filter(p => p.kind === 'viewer');
        const ids = [...new Set(list.map(p => p.by).filter(Boolean))];
        if (user && ids.length) { try { Object.assign(profiles, await user.profiles(ids)); } catch {} }
        cb(list.map(p => ({
          peer: p.peer, self: p.sameTab, mine: p.isMe, key: p.by || p.peer,
          name: profiles[p.by]?.name || '', color: profiles[p.by]?.color || p.presence?.color || '',
          avatar: profiles[p.by]?.avatarUrl || '', presence: p.presence || {}, updatedAt: p.updatedAt,
        })));
      }, () => {});
    },
    shareUI(box, close) {
      box.innerHTML = `<h3>Board zu zweit nutzen</h3>
        <p>Alle Boards hier sind geteilt. Wer diese Seite geöffnet hat, sieht Änderungen sofort und erscheint mit eigenem Cursor.</p>
        <ol>
          <li>Oben in claude.ai auf <b>Teilen</b> klicken.</li>
          <li>Die Person per E-Mail einladen, mit dem Recht <b>Bearbeiter</b>. Nur so kann sie mitschreiben.</li>
          <li>Sie öffnet den Link und ist live dabei.</li>
        </ol>
        <div class="row"><button class="ok">Verstanden</button></div>`;
      box.querySelector('.ok').onclick = close;
    },
  };
};
