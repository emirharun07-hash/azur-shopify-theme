'use strict';
/* Lokale Speicherung: ein Objekt { pfad: daten }.
   `adapter` sagt, wohin gespeichert wird (Browser-Speicher oder Datei der Windows-App). */
window.KBLocal = function KBLocal(adapter) {
  const docs = adapter.docs || {};
  const watchers = new Map();
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const list = (parent) => Object.entries(docs).filter(([p]) => parentOf(p) === parent).map(([p, d]) => [p.slice(p.lastIndexOf('/') + 1), d]);
  const emit = (parent) => { for (const cb of watchers.get(parent) || []) cb(list(parent)); };
  let t = 0;
  const persist = () => { clearTimeout(t); t = setTimeout(() => adapter.save(docs), 250); };
  window.addEventListener('beforeunload', () => { clearTimeout(t); (adapter.saveNow || adapter.save)(docs); });
  return {
    kind: 'local',
    desktop: !!adapter.desktop,
    me: adapter.me,
    canWrite: true,
    connected: true,
    savedLabel: adapter.savedLabel || 'Gespeichert',
    accepts: adapter.accepts,
    acceptLabel: adapter.acceptLabel,
    maxBytes: adapter.maxBytes,
    footHTML: adapter.footHTML,
    externalImages: !!adapter.desktop,
    watchColl(parent, cb) {
      if (!watchers.has(parent)) watchers.set(parent, new Set());
      watchers.get(parent).add(cb);
      setTimeout(() => cb(list(parent)));
      return () => watchers.get(parent)?.delete(cb);
    },
    getColl: async (parent) => list(parent),
    async set(path, data) { docs[path] = JSON.parse(JSON.stringify(data)); persist(); emit(parentOf(path)); },
    async del(path) { delete docs[path]; persist(); emit(parentOf(path)); },
    upload: (file) => adapter.upload(file),
    mediaURL: (src) => adapter.mediaURL(src),
    linkMeta: adapter.linkMeta,
    shareUI: adapter.shareUI,
    allDocs: () => docs,
  };
};
