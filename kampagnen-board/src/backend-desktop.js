'use strict';
/* Windows-App: entscheidet zwischen lokaler Speicherung und eigener Cloud
   und baut den Dialog „Live zu zweit“ (Name, Cloud einrichten, Einladungscode). */
const KB_SETUP_SQL = /*SETUP_SQL*/'';
const KB_COLORS = ['#0071e3', '#bf5af2', '#ff375f', '#ff9f0a', '#30b0c7', '#34c759', '#5e5ce6', '#ac8e68'];

window.KB_BACKEND = async function () {
  const D = window.desktop;
  const settings = await D.getSettings();
  const info = await D.info();
  if (!settings.me?.name) {
    const name = info.username ? info.username[0].toUpperCase() + info.username.slice(1) : 'Ich';
    let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    settings.me = { name, color: KB_COLORS[h % KB_COLORS.length] };
    await D.setSettings(settings);
  }
  const me = settings.me;
  const local = await D.loadLocal();
  const ACCEPTS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf'];
  const localMedia = (src) => src.startsWith('file:') ? local.assetsBase + encodeURIComponent(src.slice(5)) : src;
  const shareUI = (box, close) => desktopShareUI(box, close, settings);

  // Ist im Installer eine Cloud hinterlegt, verbindet sich die App von selbst (außer man hat sie getrennt).
  if (!settings.cloud && !settings.noDefaultCloud && info.defaultCloud?.url && info.defaultCloud?.key) {
    settings.cloud = { url: info.defaultCloud.url, key: info.defaultCloud.key };
    const hasLocal = Object.keys(local.docs).some(p => p.split('/').length === 2);
    if (hasLocal) { try { await migrate(settings.cloud, local.docs); } catch (e) { console.error('Übertragen fehlgeschlagen', e); } }
    await D.setSettings(settings);
  }
  if (settings.cloud?.url && settings.cloud?.key) {
    return window.KBCloud({ url: settings.cloud.url, key: settings.cloud.key, me, base: { mediaURL: localMedia, linkMeta: D.linkMeta, shareUI } });
  }
  return window.KBLocal({
    desktop: true, me, docs: local.docs,
    save: (docs) => D.saveLocal(JSON.stringify(docs)),
    saveNow: (docs) => D.saveLocalSync(JSON.stringify(docs)),
    upload: async (file) => (await D.assetFromFile(file)) || D.assetFromBytes(new Uint8Array(await file.arrayBuffer()), (file.name.split('.').pop() || 'bin')),
    mediaURL: localMedia,
    linkMeta: D.linkMeta,
    accepts: ACCEPTS, acceptLabel: 'JPG, PNG, GIF, WebP, SVG, MP4, MOV, WebM und PDF', maxBytes: 1024 * 1024 * 1024,
    savedLabel: 'Auf diesem PC gespeichert',
    footHTML: '<b>Nur auf diesem PC.</b> Über „Teilen“ verbindest du die App mit deiner Cloud und arbeitest live zu zweit.',
    shareUI,
  });
};

const encodeInvite = (url, key) => 'KB1.' + btoa(unescape(encodeURIComponent(JSON.stringify({ u: url, k: key })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decodeInvite(code) {
  try {
    const s = code.trim().replace(/^KB1\./, '').replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(decodeURIComponent(escape(atob(s))));
    return o.u && o.k ? { url: o.u, key: o.k } : null;
  } catch { return null; }
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function desktopShareUI(box, close, settings) {
  const connected = !!settings.cloud?.url;
  box.classList.add('share-desk');
  const nameRow = `<label class="fld"><span>Dein Name, so sehen dich andere</span>
      <span class="fld-row"><input id="meName" value="${esc(settings.me.name)}" maxlength="40" autocomplete="off">
      <span class="swatches">${KB_COLORS.map(c => `<button class="swc${c === settings.me.color ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}</span></span></label>`;
  if (connected) {
    const code = encodeInvite(settings.cloud.url, settings.cloud.key);
    box.innerHTML = `<h3>Live zu zweit</h3>
      <p class="ok-line"><i></i>Verbunden mit deiner Cloud <b>${esc(new URL(settings.cloud.url).hostname.split('.')[0])}</b></p>
      <label class="fld"><span>Einladungscode für deinen Partner</span>
        <span class="fld-row"><input id="invite" value="${esc(code)}" readonly><button class="btn-s" id="copyInvite">Kopieren</button></span></label>
      <p class="note">Wer diesen Code in seiner App eingibt, sieht alle Boards und arbeitet live mit. Teile ihn nur mit Leuten, denen du vertraust.</p>
      ${nameRow}
      <div class="row"><button class="link-danger" id="disconnect">Verbindung trennen</button><span class="spacer"></span><button class="ok" id="saveMe">Fertig</button></div>`;
  } else {
    box.innerHTML = `<h3>Live zu zweit</h3>
      <p>Verbinde die App mit einer Cloud. Dann seht ihr Änderungen und Cursor des anderen sofort.</p>
      <div class="seg" role="tablist"><button class="on" data-tab="code">Ich habe einen Code</button><button data-tab="setup">Cloud einrichten</button></div>
      <div data-pane="code">
        <label class="fld"><span>Einladungscode</span><input id="inviteIn" placeholder="KB1.…" autocomplete="off" spellcheck="false"></label>
        <p class="note">Den Code bekommst du von der Person, die die Cloud eingerichtet hat.</p>
      </div>
      <div data-pane="setup" hidden>
        <ol class="steps">
          <li>Auf <b>supabase.com</b> kostenlos registrieren und ein <b>New project</b> anlegen. Region am besten Frankfurt. Das Passwort brauchst du hier nicht.</li>
          <li>Links <b>SQL Editor</b> öffnen, das Einrichtungs-SQL einfügen und auf <b>Run</b> klicken. <button class="btn-s" id="copySql">SQL kopieren</button></li>
          <li>Unter <b>Project Settings → API</b> die <b>Project URL</b> und den <b>anon public</b>-Schlüssel hier einfügen.</li>
        </ol>
        <label class="fld"><span>Project URL</span><input id="sbUrl" placeholder="https://xyz.supabase.co" autocomplete="off" spellcheck="false"></label>
        <label class="fld"><span>anon public key</span><input id="sbKey" placeholder="eyJhbGciOi…" autocomplete="off" spellcheck="false"></label>
      </div>
      ${nameRow}
      <label class="chk"><input type="checkbox" id="migrate" checked> Meine Boards von diesem PC mitnehmen</label>
      <p class="err" id="err" hidden></p>
      <div class="row"><button class="link" id="cancel">Abbrechen</button><span class="spacer"></span><button class="ok primary" id="connect">Verbinden</button></div>`;
    const hasLocal = Object.keys(B.allDocs?.() || {}).some(p => p.split('/').length === 2);
    box.querySelector('#migrate').closest('label').hidden = !hasLocal;
    box.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
      box.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
      box.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.tab);
    });
    box.querySelector('#copySql').onclick = (e) => copy(KB_SETUP_SQL, e.target, 'SQL kopiert');
    box.querySelector('#cancel').onclick = close;
    box.querySelector('#connect').onclick = async (e) => {
      const err = box.querySelector('#err'); err.hidden = true;
      const tab = box.querySelector('.seg .on').dataset.tab;
      let cfg;
      if (tab === 'code') { cfg = decodeInvite(box.querySelector('#inviteIn').value); if (!cfg) { err.textContent = 'Der Code ist unvollständig. Kopiere ihn bitte komplett, er beginnt mit KB1.'; err.hidden = false; return; } }
      else {
        let url = box.querySelector('#sbUrl').value.trim().replace(/\/+$/, '');
        if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
        cfg = { url, key: box.querySelector('#sbKey').value.trim() };
        if (!cfg.url || !cfg.key) { err.textContent = 'Bitte Project URL und Schlüssel eintragen.'; err.hidden = false; return; }
      }
      e.target.disabled = true; e.target.textContent = 'Prüfe …';
      const problem = await window.KBCloudCheck(cfg.url, cfg.key);
      if (problem) { err.textContent = problem; err.hidden = false; e.target.disabled = false; e.target.textContent = 'Verbinden'; return; }
      readMe(box, settings);
      if (box.querySelector('#migrate').checked && hasLocal) {
        e.target.textContent = 'Überträgt Boards …';
        try { await migrate(cfg, B.allDocs()); } catch (x) { err.textContent = 'Übertragen fehlgeschlagen: ' + (x.message || x); err.hidden = false; e.target.disabled = false; e.target.textContent = 'Verbinden'; return; }
      }
      settings.cloud = cfg; delete settings.noDefaultCloud; await window.desktop.setSettings(settings);
      location.reload();
    };
  }
  box.querySelectorAll('.swc').forEach(b => b.onclick = () => { box.querySelectorAll('.swc').forEach(x => x.classList.toggle('on', x === b)); });
  if (connected) {
    box.querySelector('#copyInvite').onclick = (e) => copy(box.querySelector('#invite').value, e.target, 'Kopiert');
    box.querySelector('#saveMe').onclick = async () => {
      const before = JSON.stringify(settings.me); readMe(box, settings);
      if (JSON.stringify(settings.me) !== before) { await window.desktop.setSettings(settings); location.reload(); } else close();
    };
    box.querySelector('#disconnect').onclick = async () => {
      const ok = await confirmBox('Verbindung trennen?', 'Die Boards bleiben in der Cloud. Die App zeigt danach wieder die Boards auf diesem PC.', 'Trennen');
      if (!ok) return;
      delete settings.cloud; settings.noDefaultCloud = true; await window.desktop.setSettings(settings); location.reload();
    };
  }
}
function readMe(box, settings) {
  const n = box.querySelector('#meName').value.trim().slice(0, 40);
  const c = box.querySelector('.swc.on')?.dataset.c;
  if (n) settings.me.name = n;
  if (c) settings.me.color = c;
}
async function copy(text, btn, done) {
  try { await navigator.clipboard.writeText(text); } catch { const t = el('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  const old = btn.textContent; btn.textContent = done; setTimeout(() => btn.textContent = old, 1600);
}
// Lokale Boards (inklusive Bilder und Videos) in die Cloud übertragen.
async function migrate(cfg, localDocs) {
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
  const docs = JSON.parse(JSON.stringify(localDocs));
  for (const [path, d] of Object.entries(docs)) {
    if (typeof d.src === 'string' && d.src.startsWith('file:')) {
      const bytes = await window.desktop.assetRead(d.src);
      if (!bytes) continue;
      const name = d.src.slice(5);
      const type = guessType({ name, type: '' }) || 'application/octet-stream';
      const { error } = await sb.storage.from('kb-media').upload(name, new Blob([bytes], { type }), { contentType: type, upsert: true });
      if (error) throw new Error(`${d.name || name}: ${error.message}`);
      docs[path] = { ...d, src: 'sb:' + name };
    }
  }
  const rows = Object.entries(docs).map(([path, data]) => ({ path, parent: path.slice(0, path.lastIndexOf('/')), data, updated_at: new Date().toISOString() }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from('kb_docs').upsert(rows.slice(i, i + 200));
    if (error) throw new Error(error.message);
  }
}
