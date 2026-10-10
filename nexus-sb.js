/* NEXUS · standalone edition — Supabase adapter + sign-in.
   Gives the app the same db / user / assets / sample / downloads interfaces it used inside Claude,
   so the main app code stays almost unchanged. */
(function () {
  'use strict';
  const CFG = window.NEXUS_CONFIG || {};
  const CLOUD = !!CFG.cloud;   // NEXUS Cloud: many companies in one system (database v300)
  const sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'nexus-auth' }
  });
  window.NX_SB = sb;
  let profile = null, session = null;

  /* ---------------- small helpers ---------------- */
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clean = o => JSON.parse(JSON.stringify(o ?? {}));
  function mapErr(e) {
    const msg = e?.message || String(e || 'error');
    const err = new Error(msg);
    if (e?.code === '42501' || e?.code === 'P0002' || /row-level security|not allowed|permission/i.test(msg)) err.code = 'invalid_argument';
    else if (/quota|exceed|too large|payload/i.test(msg)) err.code = 'quota_exceeded';
    else if (/fetch|network|Failed to fetch/i.test(msg)) err.message = 'No connection to the NEXUS server. Check the internet and try again.';
    return err;
  }
  function splitPath(p) {
    const m = /^data\/users\/([^/]+)\/notif$/.exec(p);
    if (m) return ['notif', m[1]];
    const i = p.lastIndexOf('/');
    return [p.slice(0, i), p.slice(i + 1)];
  }

  /* ---------------- database: collections + documents with live updates ---------------- */
  const colSubs = new Map();   // col -> Set<{cb, cache:Map, limit}>
  const docSubs = new Map();   // "col/id" -> Set<cb>
  let channel = null, wasDown = false;

  const colSnap = cache => ({ docs: [...cache.values()].map(r => ({ id: r.id, data: () => r.data })) });
  const docSnap = (id, r) => ({ id, exists: !!r, data: () => (r ? r.data : undefined) });

  function applyRow(col, id, data /* null = deleted */) {
    const subs = colSubs.get(col);
    if (subs) for (const s of subs) {
      if (data === null) s.cache.delete(id); else s.cache.set(id, { id, data });
      try { s.cb(colSnap(s.cache)); } catch (e) { console.warn(e); }
    }
    if (col === 'system' && id === 'sync') lastSyncSeen = data?.last_sync || '';
    const ds = docSubs.get(col + '/' + id);
    if (ds) for (const cb of ds) { try { cb(docSnap(id, data === null ? null : { data })); } catch (e) { console.warn(e); } }
  }
  function ensureChannel() {
    if (channel) return;
    channel = sb.channel('nexus-docs')
      .on('postgres_changes', { event: '*', schema: 'public', table: CLOUD ? 'docs_all' : 'docs' }, p => {
        if (p.eventType === 'DELETE') { const o = p.old || {}; if (o.col) applyRow(o.col, o.id, null); }
        else { const n = p.new || {}; if (n.col) applyRow(n.col, n.id, n.data); }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') { if (wasDown) { wasDown = false; resyncAll(); } setLive(true); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { wasDown = true; setLive(false); }
      });
  }
  function setLive(ok) { const el = document.getElementById('syncState'); if (el) el.textContent = ok ? 'Live · synced' : 'Reconnecting…'; }

  async function fetchCol(col, limit) {
    // v195: the server returns at most 1000 rows per request – read in pages so large collections (vouchers) are complete
    const max = limit || 1000, out = [], PG = 1000;
    for (let from = 0; from < max; from += PG) {
      const to = Math.min(from + PG, max) - 1;
      const { data, error } = await sb.from('docs').select('id,data').eq('col', col).order('updated_at', { ascending: false }).order('id', { ascending: true }).range(from, to);
      if (error) throw mapErr(error);
      out.push(...(data || []));
      if (!data || data.length < to - from + 1) break;
    }
    return out;
  }
  async function fetchDoc(col, id) {
    const { data, error } = await sb.from('docs').select('data').eq('col', col).eq('id', id).maybeSingle();
    if (error) throw mapErr(error);
    return data;
  }
  async function resyncAll() {
    for (const [col, subs] of colSubs) for (const s of subs) {
      try { const rows = await fetchCol(col, s.limit); s.cache = new Map(rows.map(r => [r.id, r])); s.cb(colSnap(s.cache)); } catch (e) { console.warn(e); }
    }
    for (const [key, cbs] of docSubs) {
      const [col, id] = splitPath(key);
      try { const r = await fetchDoc(col, id); if (key === 'system/sync') lastSyncSeen = r?.data?.last_sync || ''; for (const cb of cbs) cb(docSnap(id, r)); } catch (e) { console.warn(e); }
    }
  }
  // v159: the live connection can die silently (computer asleep, network switch) – then the app shows old data
  // ("Sync stopped"). Re-read everything after the app was hidden > 2 min, and every 4 min compare the server's
  // last sync time with ours: if they differ, live updates were missed → reload data and reconnect.
  let lastSyncSeen = '', hiddenAt = 0;
  function restartChannel() { try { if (channel) sb.removeChannel(channel); } catch (_) {} channel = null; if (colSubs.size || docSubs.size) ensureChannel(); }
  window.addEventListener('online', () => { resyncAll(); restartChannel(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (wasDown || (hiddenAt && Date.now() - hiddenAt > 120e3)) { resyncAll(); if (!wasDown) restartChannel(); }
  });
  setInterval(async () => {
    if (document.hidden || !docSubs.has('system/sync')) return;
    try { const r = await fetchDoc('system', 'sync'); const ls = r?.data?.last_sync || '';
      if (ls && lastSyncSeen && ls !== lastSyncSeen && Date.now() - Date.parse(ls) > 90e3) { console.warn('NEXUS: live updates were missed – reloading'); await resyncAll(); restartChannel(); }
      else if (ls) lastSyncSeen = ls; } catch (_) { /* offline */ }
  }, 240e3);

  const db = {
    collection(col) {
      const q = { _limit: 1000 };
      q.limit = n => { q._limit = n; return q; };
      q.get = async () => colSnap(new Map((await fetchCol(col, q._limit)).map(r => [r.id, r])));
      q.onSnapshot = (cb, onErr) => {
        const s = { cb, cache: new Map(), limit: q._limit };
        if (!colSubs.has(col)) colSubs.set(col, new Set());
        colSubs.get(col).add(s);
        ensureChannel();
        fetchCol(col, q._limit).then(rows => { s.cache = new Map(rows.map(r => [r.id, r])); cb(colSnap(s.cache)); })
          .catch(e => onErr && onErr(e));
        return () => colSubs.get(col)?.delete(s);
      };
      return q;
    },
    doc(path) {
      const [col, id] = splitPath(path);
      return {
        id,
        async get() { return docSnap(id, await fetchDoc(col, id)); },
        async set(obj) {
          const data = clean(obj);
          const { error } = await sb.from('docs').upsert({ col, id, data }, CLOUD ? { onConflict: 'tenant_id,col,id' } : undefined);
          if (error) throw mapErr(error);
          applyRow(col, id, data);
        },
        async update(obj) {
          const patch = clean(obj);
          const { error } = await sb.rpc('doc_merge', { c: col, i: id, patch });
          if (error) throw mapErr(error);
          const r = await fetchDoc(col, id).catch(() => null);
          if (r) applyRow(col, id, r.data);
        },
        async delete() {
          const { error } = await sb.from('docs').delete().eq('col', col).eq('id', id);
          if (error) throw mapErr(error);
          applyRow(col, id, null);
        },
        onSnapshot(cb, onErr) {
          const key = col + '/' + id;
          if (!docSubs.has(key)) docSubs.set(key, new Set());
          docSubs.get(key).add(cb);
          ensureChannel();
          fetchDoc(col, id).then(r => { if (key === 'system/sync') lastSyncSeen = r?.data?.last_sync || ''; cb(docSnap(id, r)); }).catch(e => onErr && onErr(e));
          return () => docSubs.get(key)?.delete(cb);
        }
      };
    }
  };

  /* ---------------- user ---------------- */
  const user = {
    async me() { return { id: session.user.id, name: profile?.name || session.user.email, email: session.user.email, avatarUrl: '', role: profile?.role }; },
    async canEdit() { return profile?.role === 'admin'; },
    async can(what) { if (what === 'data.write') return profile?.role !== 'viewer'; return true; },
    async isFinance() { return profile?.role === 'finance'; },
    async isProcurement() { return profile?.role === 'procurement'; },
    async isQS() { return profile?.role === 'qs'; },
    async people() { const { data, error } = await sb.from('profiles').select('user_id,name,email,role,active,pending'); if (error) return []; return (data || []).filter(p => p.active !== false && !p.pending).map(p => ({ id: p.user_id, name: p.name || '', email: p.email || '', role: p.role, roleTxt: ROLE_TXT[p.role] || p.role })); }
  };

  /* ---------------- files (site photos, tender documents) ---------------- */
  const TEN_YEARS = 60 * 60 * 24 * 365 * 10;
  const assets = {
    async upload(blob, opts = {}) {
      const type = opts.type || blob.type || 'application/octet-stream';
      const name = (blob.name || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const ext = name.includes('.') ? '' : ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' }[type] || '');
      const d = new Date();
      const path = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${uid()}-${name || 'file'}${ext}`;
      const up = await sb.storage.from('files').upload(path, blob, { contentType: type, upsert: false });
      if (up.error) throw mapErr(up.error);
      const s = await sb.storage.from('files').createSignedUrl(path, TEN_YEARS);
      if (s.error) throw mapErr(s.error);
      return { url: s.data.signedUrl, path };
    }
  };

  /* ---------------- AI (Gemini through the "ai" server function) ---------------- */
  // v180: never wait forever – 140 s ceiling, clear 'took too long' message, one quick retry with a single AI
  async function callAI1(payload) {
    const ctl = new AbortController(); let tm;
    const tooLong = () => { const e = new Error('The AI took too long to answer. Please try again.'); e.code = 'timeout'; return e; };
    const inv = sb.functions.invoke('ai', { body: payload, signal: ctl.signal });
    let r;
    try { r = await Promise.race([inv, new Promise((_, rej) => { tm = setTimeout(() => { try { ctl.abort(); } catch (_) {} rej(tooLong()); }, 140000); })]); }
    catch (err) { if (err && err.code === 'timeout') throw err; if (/abort/i.test(String(err && (err.name || err.message)))) throw tooLong(); throw err; }
    finally { clearTimeout(tm); }
    const { data, error } = r;
    if (error) {
      const st = error.context && error.context.status;
      let body = null; try { body = await error.context?.json(); } catch (_) {}
      if (st === 546 || st === 504 || body?.error === 'timeout' || /timed? ?out|abort/i.test(error.message || '')) throw tooLong();
      const e = new Error(body?.message || body?.error || (st >= 500 ? 'The AI service had a problem (' + st + '). Please try again.' : error.message));
      if (body?.error === 'rate_limited') e.code = 'rate_limited';
      e.status = st; throw e;
    }
    return data;
  }
  async function callAI(payload) {
    const p = { ...payload, kind: window.NX_AI_KIND || '' }, t0 = Date.now();
    try { return await callAI1(p); }
    catch (e) {
      // the slow 3-AI check failed: ask one AI straight away (only if that still makes sense time-wise)
      const retry = p.panel !== false && (e.code === 'timeout' || (e.status >= 500 && e.code !== 'rate_limited')) && Date.now() - t0 < 60000;
      if (!retry) throw e;
      return await callAI1({ ...p, panel: false });
    }
  }
  const toPayload = x => Array.isArray(x) ? { turns: x } : { prompt: String(x) };
  // AI answers are shown as plain text: remove markdown marks (**bold**, # headings, * bullets)
  const plain = t => String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s*/gm, '').replace(/^\s*[*•]\s+/gm, '- ').replace(/`([^`]+)`/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  // v148: every AI request goes to the AI panel (2 AIs answer, a 3rd checks); the agreement comes back as d.panel
  const sample = async (x, o = {}) => {
    const att = o && ((o.files && o.files.length) || (o.links && o.links.length)) ? { ...(o.files && o.files.length ? { files: o.files } : {}), ...(o.links && o.links.length ? { links: o.links } : {}) } : null;
    const d = await callAI({ ...toPayload(x), ...(o && o.web && !att ? { web: true } : {}), ...(o && o.panel === false ? { panel: false } : {}), ...(att || {}) });
    if (d.panel) window.NX_AI_PANEL = d.panel;
    return { text: plain(d.text), sources: Array.isArray(d.sources) ? d.sources : [], web: !!d.web, ...(d.panel ? { panel: d.panel } : {}) };
  };
  sample.json = async (x, o = {}) => {
    const d = await callAI({ ...toPayload(x), json: true, ...(o && o.max_tokens ? { max_tokens: o.max_tokens } : {}), ...(o && o.panel === false ? { panel: false } : {}), ...(o && o.files && o.files.length ? { files: o.files } : {}) });
    if (d.panel) window.NX_AI_PANEL = d.panel;
    const t = String(d.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let v; try { v = JSON.parse(t); } catch (_) { const e = new Error('invalid json'); e.code = 'invalid_json'; throw e; }
    if (d.panel && v && typeof v === 'object' && !Array.isArray(v)) v._ai = d.panel;
    return v;
  };

  /* ---------------- downloads ---------------- */
  const downloads = {
    async save({ filename, data, type }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || (typeof data === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream') });
      if (window.NX_NATIVE_SAVE) return window.NX_NATIVE_SAVE(filename, blob);   // set by the Android app wrapper
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'download';
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    }
  };

  /* ---------------- v151 · project document library: private bucket "projfiles", folder = project id ---------------- */
  window.NX_PF = {
    async upload(pid, blob, name, type) {
      const clean = String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-90);
      const path = `${String(pid).replace(/[^A-Za-z0-9_-]+/g, '_')}/${new Date().toISOString().slice(0, 10)}-${uid()}-${clean}`;
      const up = await sb.storage.from('projfiles').upload(path, blob, { contentType: type || blob.type || 'application/octet-stream', upsert: false });
      if (up.error) throw mapErr(up.error);
      return { path };
    },
    async url(path, download) { const s = await sb.storage.from('projfiles').createSignedUrl(path, 3600, download ? { download: typeof download === 'string' ? download : true } : undefined); if (s.error) throw mapErr(s.error); return s.data.signedUrl; },
    async blob(path) { const { data, error } = await sb.storage.from('projfiles').download(path); if (error) throw mapErr(error); return data; },
    async remove(paths) { if (paths && paths.length) { const r = await sb.storage.from('projfiles').remove(paths); if (r.error) throw mapErr(r.error); } }
  };

  /* ---------------- v150 · Ask NEXUS attachments: private bucket "askfiles", folder = own login id ---------------- */
  window.NX_ASKF = {
    async upload(blob, name, type) {
      const { data: { user } } = await sb.auth.getUser(); if (!user) throw new Error('Please sign in again.');
      const clean = String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const path = `${user.id}/${new Date().toISOString().slice(0, 10)}/${uid()}-${clean}`;
      const up = await sb.storage.from('askfiles').upload(path, blob, { contentType: type || blob.type || 'application/octet-stream', upsert: false });
      if (up.error) throw mapErr(up.error);
      return { path };
    },
    async url(path) { const s = await sb.storage.from('askfiles').createSignedUrl(path, 3600); if (s.error) throw mapErr(s.error); return s.data.signedUrl; },
    async remove(paths) { if (paths && paths.length) await sb.storage.from('askfiles').remove(paths); }
  };

  /* ---------------- Office Records: private files (bucket "records", path <record id>/...), audit log ---------------- */
  window.NX_REC = {
    async upload(recId, file, v) {
      const name = (file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const path = `${recId}/v${v || 1}-${uid()}-${name}`;
      const up = await sb.storage.from('records').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (up.error) throw mapErr(up.error);
      return { path, name: file.name || name, size: file.size || 0, type: file.type || '' };
    },
    async url(path, download) {
      const s = await sb.storage.from('records').createSignedUrl(path, 3600, download ? { download: true } : undefined);
      if (s.error) throw mapErr(s.error);
      return s.data.signedUrl;
    },
    async remove(paths) { const r = await sb.storage.from('records').remove(paths); if (r.error) throw mapErr(r.error); },
    async log(rec, act) { try { await sb.rpc('rec_log', { rec: String(rec), act: String(act) }); } catch (_) {} },
    async history(rec) { const { data, error } = await sb.rpc('rec_history', { rec: String(rec) }); if (error) throw mapErr(error); return data || []; }
  };

  window.claude = { use: async n => ({ db, user, sample, assets, downloads })[n] || null };

  /* ================= sign-in screens ================= */
  const css = `
  .nxa{position:fixed;inset:0;z-index:200;background:#182340;display:grid;place-items:center;align-items:safe center;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px;font:14px/1.5 "IBM Plex Sans",system-ui,sans-serif;color:#182340}
  .nxa .box{background:#FAFBFC;border-radius:10px;width:min(400px,100%);padding:26px 24px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,.35)}
  .nxa .hz{height:8px;margin:-26px -24px 8px;border-radius:10px 10px 0 0;background:repeating-linear-gradient(-45deg,#F2A900 0 12px,#182340 12px 24px)}
  .nxa h1{font:700 30px/1 "Barlow Condensed",Arial,sans-serif;letter-spacing:.04em;margin:0;text-transform:uppercase}
  .nxa h1 span{color:#539FDC}.nxa p{margin:0;color:#5A6580;font-size:13px}
  .nxa label{font-size:12px;font-weight:600;color:#5A6580;display:flex;flex-direction:column;gap:4px}
  .nxa .seg2{display:flex;gap:6px}.nxa .seg2 label{flex:1;flex-direction:row;align-items:center;gap:6px;border:1px solid #D4DAE3;border-radius:6px;padding:8px;color:#182340;cursor:pointer}.nxa .seg2 label:has(input:checked){border-color:#2E75B6;background:#EEF3FA}
  .nxa input,.nxa select{font:inherit;border:1px solid #D4DAE3;border-radius:6px;padding:9px 11px;background:#fff;color:#182340}
  .nxa button{font:inherit;cursor:pointer;border-radius:6px;padding:10px 14px;border:1px solid #D4DAE3;background:#fff;color:#182340}
  .nxa button.pri{background:#539FDC;border-color:#539FDC;color:#0E1830;font-weight:600}
  .nxa .err{color:#B8402A;font-size:13px;min-height:1em}
  .nxa .lnk{background:none;border:0;padding:0;color:#2F6DB5;text-align:left;font-size:13px}
  .nxa .logo{display:flex;align-items:center;gap:10px}.nxa .logo img{height:36px}
  .nxpw{position:relative;display:block}.nxpw input{width:100%;box-sizing:border-box;padding-right:44px!important}
  .nxpw .eye{all:unset;position:absolute;right:6px;top:50%;transform:translateY(-50%);width:32px;height:32px;display:grid;place-items:center;cursor:pointer;color:#5A6580;border-radius:6px}
  .nxpw .eye:hover{background:rgba(0,0,0,.06)}.nxpw .eye:focus-visible{outline:2px solid #539FDC}.nxpw .eye svg{width:20px;height:20px}
  .nxm{position:fixed;inset:0;z-index:150;background:rgba(12,17,21,.5);display:grid;place-items:center;padding:16px}
  .nxm .box{background:var(--panel,#fff);color:var(--ink,#182340);border-radius:8px;width:min(760px,100%);max-height:90vh;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
  .nxm table{width:100%;border-collapse:collapse;font-size:13px}.nxm td,.nxm th{padding:7px 6px;border-bottom:1px solid var(--line,#D4DAE3);text-align:left;vertical-align:middle}
  .nxm input,.nxm select{font:inherit;border:1px solid var(--line,#D4DAE3);border-radius:5px;padding:6px 8px;background:var(--panel,#fff);color:inherit;min-width:0}
  .nxm .row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.nxm .row label{display:flex;flex-direction:column;font-size:12px;gap:3px;flex:1;min-width:140px}
  .nxw{position:fixed;z-index:120;background:var(--panel,#fff);color:var(--ink,#182340);border:1px solid var(--line,#D4DAE3);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:8px;display:flex;flex-direction:column;min-width:220px}
  .nxw button{all:unset;cursor:pointer;padding:8px 10px;border-radius:5px;font-size:13px}.nxw button:hover{background:var(--panel2,#F0F3F7)}
  .nxw .who2{padding:6px 10px 10px;border-bottom:1px solid var(--line,#D4DAE3);margin-bottom:4px;font-size:12.5px}`;
  const st = document.createElement('style'); st.textContent = css; document.head.append(st);

  const logoSrc = () => document.querySelector('#brandMark img')?.src || '';
  function screen(inner) {
    let w = document.getElementById('nxAuth');
    if (!w) { w = document.createElement('div'); w.id = 'nxAuth'; w.className = 'nxa'; document.body.append(w); }
    w.innerHTML = `<form class="box" autocomplete="on" novalidate><div class="hz"></div><div class="logo"><img alt="" src="${logoSrc()}"><h1>Demo <span>Nexus</span></h1></div>${inner}</form>`;
    const fm = w.querySelector('form'); addEyes(fm); return fm;
  }
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>';
  function addEyes(root) {
    root.querySelectorAll('input[type=password]').forEach(inp => {
      if (inp.parentElement.classList.contains('nxpw')) return;
      const wrap = document.createElement('span'); wrap.className = 'nxpw'; inp.replaceWith(wrap); wrap.append(inp);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'eye'; b.innerHTML = EYE; b.title = 'Show password'; b.setAttribute('aria-label', 'Show password'); b.setAttribute('aria-pressed', 'false');
      b.onclick = () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; b.innerHTML = show ? EYE_OFF : EYE; const t = show ? 'Hide password' : 'Show password'; b.title = t; b.setAttribute('aria-label', t); b.setAttribute('aria-pressed', String(show)); inp.focus(); };
      wrap.append(b);
    });
  }
  const closeScreen = () => document.getElementById('nxAuth')?.remove();

  function loginScreen(msg) {
    return new Promise(res => {
      const f = screen(`<p>Sign in with your NEXUS email and password.</p>
        <label>Email<input name="email" type="email" autocomplete="username" required></label>
        <label>Password<input name="pw" type="password" autocomplete="current-password" required></label>
        <div class="err" role="alert">${h(msg || '')}</div>
        <button class="pri" type="submit">Sign in</button>
        <button class="lnk" type="button" data-forgot>Forgot password?</button>
        <p style="border-top:1px solid #D4DAE3;padding-top:10px;margin-top:4px">New to NEXUS? <button class="lnk" type="button" data-register>Sign up</button></p>
        ${/NordicNexusAndroid/.test(navigator.userAgent) ? '' : '<p class="small" style="margin:0;color:#5A6580">Get the app: <a href="downloads/NEXUS.apk" download>Android</a> · <a href="downloads/NEXUS-Setup.exe" download>Windows</a></p>'}`);
      f.email.focus();
      f.querySelector('[data-register]').onclick = () => registerScreen().then(res);
      f.querySelector('[data-forgot]').onclick = () => { f.querySelector('.err').textContent = 'Ask a NEXUS administrator to set a new temporary password for you.'; };
      f.onsubmit = async e => {
        e.preventDefault();
        const b = f.querySelector('button.pri'); b.disabled = true; b.textContent = 'Signing in…';
        const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.pw.value });
        b.disabled = false; b.textContent = 'Sign in';
        if (error) { f.querySelector('.err').textContent = /invalid/i.test(error.message) ? 'Wrong email or password.' : /banned/i.test(error.message) ? 'This login has been switched off. Contact an administrator.' : error.message; return; }
        res(data.session);
      };
    });
  }
  function registerScreen() {
    return new Promise(res => {
      const f = screen(`<p><b>Sign up.</b> Fill in your details and choose a password. An administrator approves your sign-up before you can open NEXUS.</p>
        ${CLOUD ? `<div class="seg2" role="radiogroup" aria-label="Sign-up type"><label><input type="radio" name="kind" value="join" checked> Join my company</label><label><input type="radio" name="kind" value="new"> Register a new company</label></div>
        <label data-k="join">Company code <span class="small" style="opacity:.7">(ask your NEXUS administrator)</span><input name="code" autocomplete="off" placeholder="e.g. 7F3K9Q2A" style="text-transform:uppercase"></label>
        <label data-k="new" hidden>Company name<input name="company" autocomplete="organization" placeholder="Registered name of the company"></label>
        <label data-k="new" hidden>Country<input name="country" value="Tanzania" autocomplete="country-name"></label>` : ''}
        <label>Full name<input name="name" required autocomplete="name"></label>
        <label>Work email<input name="email" type="email" required autocomplete="email"></label>
        <label>Position<input name="position" placeholder="e.g. Site Engineer, QS, Storekeeper"></label>
        <label>Mobile<input name="phone" type="tel" placeholder="+255…" autocomplete="tel"></label>
        <label>Choose a password (10+)<input name="p1" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>Repeat password<input name="p2" type="password" autocomplete="new-password" required></label>
        <div class="err" role="alert"></div>
        <button class="pri" type="submit">Sign up</button>
        <button class="lnk" type="button" data-back>Back to sign in</button>`);
      f.elements.namedItem('name').focus();
      const kind = () => (CLOUD ? (f.querySelector('input[name=kind]:checked')?.value || 'join') : 'join');
      if (CLOUD) f.querySelectorAll('input[name=kind]').forEach(r => r.onchange = () => { f.querySelectorAll('[data-k]').forEach(el => { el.hidden = el.dataset.k !== kind(); });
        f.querySelector('p').innerHTML = kind() === 'new' ? '<b>Register your company.</b> You become its first administrator. The NEXUS team checks the request and opens your company – usually within one working day.' : '<b>Sign up.</b> Fill in your details and choose a password. An administrator approves your sign-up before you can open NEXUS.'; });
      f.querySelector('[data-back]').onclick = () => loginScreen().then(res);
      f.onsubmit = async e => {
        e.preventDefault();
        const v = k => f.elements.namedItem(k).value.trim(), er = f.querySelector('.err');
        if (CLOUD && kind() === 'join' && !/^[A-Za-z0-9]{6,12}$/.test(v('code'))) { er.textContent = 'Enter the company code from your administrator.'; return; }
        if (CLOUD && kind() === 'new' && v('company').length < 3) { er.textContent = 'Enter the name of your company.'; return; }
        if (v('name').length < 3) { er.textContent = 'Enter your full name.'; return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('email'))) { er.textContent = 'Enter a valid email.'; return; }
        if (f.p1.value.length < 10) { er.textContent = 'Use at least 10 characters for the password.'; return; }
        if (f.p1.value !== f.p2.value) { er.textContent = 'The two passwords are different.'; return; }
        const b = f.querySelector('button.pri'); b.disabled = true; b.textContent = 'Sending…';
        const { data, error } = await sb.auth.signUp({ email: v('email').toLowerCase(), password: f.p1.value,
          options: { data: { name: v('name'), position: v('position'), phone: v('phone'),
            ...(CLOUD ? (kind() === 'new' ? { new_company: v('company'), country: v('country') } : { company_code: v('code').toUpperCase() }) : {}) } } });
        b.disabled = false; b.textContent = 'Sign up';
        if (error) { er.textContent = /registered|exists/i.test(error.message) ? 'This email is already signed up. Sign in, or ask an administrator.' : /signups? not allowed|disabled/i.test(error.message) ? 'Self-registration is switched off. Ask an administrator.' : error.message; return; }
        if (data.session) await sb.auth.signOut({ scope: 'local' });
        if (CLOUD && kind() === 'new') companyWaitScreen(v('name'), v('company')); else waitingScreen(v('name'));
      };
    });
  }
  function waitingScreen(name) {
    const f = screen(`<p><b>${name ? 'Thank you, ' + h(name.split(' ')[0]) + '.' : 'Sign-up received.'}</b></p>
      <p>Your sign-up has been sent to the administrators. You will be able to sign in with your email and password as soon as it is approved.</p>
      <button class="pri" type="button">Back to sign in</button>`);
    f.querySelector('button').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); };
  }
  // ---------- NEXUS Cloud: how to pay (set by the platform owner) + "I have paid" notice ----------
  const PAY_FIELDS = [['price', 'Price'], ['bank', 'Bank transfer'], ['mobile', 'Mobile money'], ['contact', 'Questions'], ['other', 'Other']];
  async function payHtml(c) {
    let info = {}; try { const { data } = await sb.rpc('nx_pay_info'); info = data || {}; } catch (_) {}
    const lines = PAY_FIELDS.filter(([k]) => (info[k] || '').trim()).map(([k, l]) => `<div style="margin:2px 0"><b>${h(l)}:</b> ${h(info[k]).replace(/\n/g, '<br>')}</div>`).join('');
    return `<div style="background:#EEF3FA;border-radius:6px;padding:10px 12px;font-size:13px;color:#182340">${lines || 'Contact the NEXUS team for payment details.'}
      <div style="margin-top:4px;opacity:.75">Write <b>${h(c?.name || 'your company name')}</b> as the payment reference.</div></div>
      ${profile?.role === 'admin' ? `<div data-claim style="display:flex;flex-direction:column;gap:8px">
        <b style="font-size:13px">After paying, tell us here:</b>
        <label>Paid by<select name="pm"><option>M-Pesa</option><option>Mixx by Yas (Tigo Pesa)</option><option>Airtel Money</option><option>HaloPesa</option><option>Bank transfer</option><option>Other</option></select></label>
        <label>Transaction / receipt number<input name="pref" autocomplete="off" placeholder="e.g. QK7H2XYZ12"></label>
        <label>Amount paid<input name="pamt" autocomplete="off" placeholder="e.g. TZS 600,000"></label>
        <button class="pri" type="button" data-claimsend>Send payment notice</button>
        <div class="err" role="status" data-claimmsg></div></div>` : '<p class="small" style="margin:0">Your company administrator makes the payment.</p>'}`;
  }
  function payWire(root) {
    const b = root.querySelector('[data-claimsend]'); if (!b) return;
    b.onclick = async () => {
      const q = n => root.querySelector(`[name="${n}"]`).value.trim(), msg = root.querySelector('[data-claimmsg]');
      if (q('pref').length < 3) { msg.textContent = 'Enter the transaction or receipt number.'; return; }
      b.disabled = true; b.textContent = 'Sending…';
      const { error } = await sb.rpc('nx_payment_claim', { method: q('pm'), reference: q('pref'), amount: q('pamt'), note: null });
      b.disabled = false; b.textContent = 'Send payment notice';
      if (error) { msg.textContent = error.message; return; }
      root.querySelector('[data-claim]').innerHTML = '<p style="margin:0"><b>Thank you.</b> The NEXUS team checks the payment and extends your subscription – usually the same working day. You will then be able to sign in again.</p>';
    };
  }
  async function openPay(c) {
    const w = document.createElement('div'); w.className = 'nxm';
    w.innerHTML = `<div class="box" style="width:min(460px,100%)"><div style="display:flex;align-items:center;gap:8px"><h2 style="margin:0;font:700 19px var(--f-display,Arial);text-transform:uppercase">Pay for NEXUS</h2><div style="flex:1"></div><button class="btn sm" data-close>Close</button></div><div data-pb class="nxa" style="position:static;background:none;padding:0;display:block"><p>Loading…</p></div></div>`;
    w.onclick = e => { if (e.target === w || e.target.closest('[data-close]')) w.remove(); };
    document.body.append(w);
    const pb = w.querySelector('[data-pb]'); pb.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">${await payHtml(c)}</div>`; payWire(pb);
  }
  window.NX_PAY = c => openPay(c || profile?.company);

  function companyWaitScreen(name, company) {
    const f = screen(`<p><b>Thank you${name ? ', ' + h(name.split(' ')[0]) : ''}.</b></p>
      <p>The request for <b>${h(company || 'your company')}</b> has been sent to the NEXUS team. When the company is opened you sign in with your email and password and add your staff.</p>
      <button class="pri" type="button">Back to sign in</button>`);
    f.querySelector('button').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); };
  }
  function companyClosedScreen(c) {
    const st = c?.status, late = st === 'active' || st === 'trial';
    const msg = !c ? 'Your login is not linked to a company yet. Ask your NEXUS administrator for the company code.'
      : st === 'pending' ? `<b>${h(c.name)}</b> is waiting for approval by the NEXUS team. You will be able to sign in as soon as it is opened.`
      : st === 'trial' ? `The free trial of <b>${h(c.name)}</b> ended on ${h(c.trial_until || '')}. Choose a plan to continue – all your records are kept.`
      : late ? `The NEXUS subscription of <b>${h(c.name)}</b> ended on ${h(c.paid_until || '')}. Renew to continue – all your records are kept.`
      : `NEXUS is switched off for <b>${h(c.name)}</b>. Contact the NEXUS team.`;
    const f = screen(`<p>${msg}</p>
      <div data-paybox></div>
      ${profile?.platform ? '<button class="pri" type="button" data-plat>Open NEXUS Cloud – companies</button>' : ''}
      <button class="lnk" type="button" data-out>Sign out</button>`);
    f.querySelector('[data-out]').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); };
    if (late && c) payHtml(c).then(x => { const pb = f.querySelector('[data-paybox]'); if (pb) { pb.style.cssText = 'display:flex;flex-direction:column;gap:10px'; pb.innerHTML = x; payWire(pb); } });
    f.querySelector('[data-plat]')?.addEventListener('click', () => openPlatform());
  }
  function newPasswordScreen(first) {
    return new Promise(res => {
      const f = screen(`<p>${first ? 'Welcome! Choose your own password before you continue.' : 'Choose a new password.'} Use at least 10 characters.</p>
        <label>New password<input name="p1" type="password" autocomplete="new-password" required minlength="10"></label>
        <label>Repeat new password<input name="p2" type="password" autocomplete="new-password" required></label>
        <div class="err" role="alert"></div>
        <button class="pri" type="submit">Save password</button>
        ${first ? '' : '<button class="lnk" type="button" data-cancel>Cancel</button>'}`);
      f.p1.focus();
      f.querySelector('[data-cancel]')?.addEventListener('click', () => { closeScreen(); res(false); });
      f.onsubmit = async e => {
        e.preventDefault();
        const er = f.querySelector('.err');
        if (f.p1.value.length < 10) { er.textContent = 'Use at least 10 characters.'; return; }
        if (f.p1.value !== f.p2.value) { er.textContent = 'The two passwords are different.'; return; }
        const { error } = await sb.auth.updateUser({ password: f.p1.value, data: { must_change_password: false } });
        if (error) { er.textContent = error.message; return; }
        closeScreen(); res(true);
      };
    });
  }
  function blockedScreen(text) {
    const f = screen(`<p>${h(text)}</p><button class="pri" type="button">Sign out</button>`);
    f.querySelector('button').onclick = async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); };
  }

  async function loadProfile() {
    const { data, error } = await sb.rpc('whoami');
    if (error) throw error;
    profile = data;
  }

  window.NX_READY = (async () => {
    if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
    // hide the app until signed in
    screen('<p>Connecting…</p>');
    let { data: { session: s } } = await sb.auth.getSession();
    if (s) { // a login ended elsewhere (signed out, switched off) must not leave a half-working page
      try { const { error: ge } = await sb.auth.getUser(); if (ge && [401, 403].includes(ge.status)) { await sb.auth.signOut({ scope: 'local' }); s = null; } } catch (_) {}
    }
    if (!s) s = await loginScreen();
    session = s;
    try { await loadProfile(); } catch (e) { blockedScreen('Could not reach the NEXUS server. Check the internet connection and reload.'); throw e; }
    if (CLOUD && profile && !profile.pending && !(profile.company && profile.company.open)) { companyClosedScreen(profile.company); throw new Error('company'); }
    if (profile && profile.pending) { waitingScreen(profile.name); throw new Error('pending'); }
    if (!profile || !profile.active) { blockedScreen('Your login is not active in NEXUS. Contact an administrator.'); throw new Error('inactive'); }
    if (session.user.user_metadata?.must_change_password) await newPasswordScreen(true);
    closeScreen();
    sb.auth.onAuthStateChange((ev, s2) => { if (ev === 'SIGNED_OUT') location.reload(); if (s2) session = s2; });
    setTimeout(attachMenu, 300);
    if (CLOUD && profile.role === 'admin' && profile.company) {
      const c = profile.company, end = c.status === 'trial' ? c.trial_until : c.paid_until;
      const left = end ? Math.ceil((Date.parse(end + 'T23:59:59') - Date.now()) / 864e5) : null;
      if (left != null && left <= 14) setTimeout(() => {
        const bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:140;background:#182340;color:#fff;border-radius:8px;padding:10px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:13px;max-width:calc(100% - 24px)';
        bar.innerHTML = `<span>${left < 0 ? `Your NEXUS ${c.status === 'trial' ? 'trial' : 'subscription'} ended ${-left} day${left === -1 ? '' : 's'} ago – NEXUS closes 7 days after the end date.` : `Your NEXUS ${c.status === 'trial' ? 'free trial' : 'subscription'} ends in ${left} day${left === 1 ? '' : 's'} (${h(end)}).`}</span><button class="btn sm pri" type="button">How to pay</button><button class="btn sm" type="button" aria-label="Close">✕</button>`;
        const [pay, x] = bar.querySelectorAll('button'); pay.onclick = () => openPay(c); x.onclick = () => bar.remove();
        document.body.append(bar);
      }, 1500);
    }
    if (profile.role === 'admin') {
      // who is waiting for approval – one notification per person (so a new sign-up is always a NEW alert)
      const count = async () => { try { const { data } = await sb.from('profiles').select('user_id,name,email,position,requested_at').eq('pending', true).order('requested_at', { ascending: false }); const L = data || [], sig = L.map(u => u.user_id).join(',');
        if (window.NX_PENDING !== L.length || window.NX_PENDING_SIG !== sig) { window.NX_PENDING = L.length; window.NX_PENDING_SIG = sig; window.NX_PENDING_LIST = L; window.renderAll?.(); } } catch (_) {} };
      window.NX_PENDING_REFRESH = count; count(); setInterval(count, 60e3);
      addEventListener('focus', count); document.addEventListener('visibilitychange', () => { if (!document.hidden) count(); });
      loadFilesBk();
    }
  })();
  window.NX_OPEN_USERS = () => openUsers();

  /* ---------------- announcements: who has seen what ---------------- */
  window.NX_ANN = {
    role: () => profile?.role || '',
    uid: () => session?.user?.id || '',
    async mySeen() { const { data, error } = await sb.from('announce_seen').select('ann_id').eq('user_id', session.user.id); if (error) throw error; return new Set((data || []).map(r => r.ann_id)); },
    async markSeen(id) { const { error } = await sb.from('announce_seen').insert({ ann_id: id }); if (error && error.code !== '23505') throw error; },
    async seenList(id) { const { data, error } = await sb.rpc('ann_seen_list', { ann: id }); if (error) throw error; return data || []; }
  };

  /* ---------------- notifications on this phone / computer (Firebase Cloud Messaging) ---------------- */
  (() => {
    const FB = CFG.firebase || null;                       // public web config + web-push key (config.js)
    const droid = () => window.NexusAndroid && typeof window.NexusAndroid.getPushToken === 'function';
    const LS = 'nx_push';
    const saved = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (_) { return null; } };
    const keep = v => { try { v ? localStorage.setItem(LS, JSON.stringify(v)) : localStorage.removeItem(LS); } catch (_) {} };
    let signedIn = false, pendingDroid = '', busy = false;
    const say = m => (window.toast ? window.toast(m) : alert(m));
    const register = async (tok, plat) => {
      if (!tok) return false;
      const { error } = await sb.rpc('push_register', { tok, plat, ua: navigator.userAgent.slice(0, 200) });
      if (error) throw error;
      keep({ tok, plat, on: true }); return true;
    };
    // the Android app hands over its push address here (before or after sign-in)
    window.NX_PUSH_TOKEN = (tok, plat) => { if (plat !== 'android' || !tok) return; if (!signedIn) { pendingDroid = tok; return; } register(tok, 'android').then(() => window.renderAll?.()).catch(() => {}); };
    const load = src => new Promise((ok, no) => { const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = () => no(new Error('Could not load ' + src)); document.head.append(el); });
    async function webToken(ask) {
      if (!FB || !FB.apiKey) throw new Error('Device notifications are not set up yet.');
      if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window))
        throw new Error('This browser cannot show notifications. Use Chrome or Edge (on iPhone: Share → Add to Home Screen, then open NEXUS from there).');
      let perm = Notification.permission;
      if (perm === 'default' && ask) perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for NEXUS in this browser. Click the icon left of the web address → Notifications → Allow, then try again.' : 'Notifications were not allowed.');
      if (!window.firebase) { await load('https://www.gstatic.com/firebasejs/12.19.0/firebase-app-compat.js'); await load('https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-compat.js'); }
      if (!firebase.apps.length) firebase.initializeApp(FB);
      const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js?v=1', { scope: './' });
      const m = firebase.messaging();
      if (!m.__nx) { m.__nx = 1; m.onMessage(() => {}); }   // NEXUS open on screen: it shows the message itself
      return m.getToken({ vapidKey: FB.vapidKey, serviceWorkerRegistration: reg });
    }
    // what the bell drawer shows: on / off / blocked / unsupported / setup
    window.NX_PUSH_STATE = () => {
      if (window.NexusAndroid && !droid()) return 'oldapp';   // Android app older than v1.2 (no notification support)
      if (droid()) { const p = window.NexusAndroid.pushPermission ? window.NexusAndroid.pushPermission() : 'granted';
        return p === 'granted' ? (saved()?.on ? 'on' : 'wait') : 'off'; }
      if (!FB || !FB.apiKey) return 'setup';
      if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return 'unsupported';
      if (Notification.permission === 'denied') return 'blocked';
      return saved()?.on && Notification.permission === 'granted' ? 'on' : 'off';
    };
    window.NX_PUSH_BUSY = () => busy;
    window.NX_PUSH_ON = async () => {
      if (busy) return; busy = true; window.renderAll?.();
      try {
        if (droid()) { if (window.NexusAndroid.pushPermission() !== 'granted') window.NexusAndroid.askPush(); const t = window.NexusAndroid.getPushToken(); if (t) await register(t, 'android'); }
        else { await register(await webToken(true), 'web'); say('Notifications are on for this device.'); }
      } catch (e) { say(e.message || String(e)); }
      finally { busy = false; window.renderAll?.(); }
    };
    window.NX_PUSH_OFF = async () => {
      if (busy) return; busy = true; window.renderAll?.();
      try { const s = saved(); if (s?.tok) await sb.rpc('push_unregister', { tok: s.tok }); keep(null);
        if (!droid() && window.firebase?.apps?.length) { try { await firebase.messaging().deleteToken(); } catch (_) {} }
        say(droid() ? 'Notifications off for this phone. To switch them on again, tap Turn on.' : 'Notifications are off for this device.'); }
      catch (e) { say(e.message || String(e)); }
      finally { busy = false; window.renderAll?.(); }
    };
    // after sign-in: register the Android app automatically; keep a browser's address fresh (they change from time to time)
    window.NX_READY.then(async () => {
      signedIn = true;
      try {
        if (droid()) { const t = pendingDroid || window.NexusAndroid.getPushToken(); if (t && saved()?.on !== false) await register(t, 'android'); }
        else { const s = saved(); if (s?.on && 'Notification' in window && Notification.permission === 'granted') { const t = await webToken(false); if (t && t !== s.tok) { if (s.tok) sb.rpc('push_unregister', { tok: s.tok }); } await register(t, 'web'); } }
      } catch (_) {}
      window.renderAll?.();
    }).catch(() => {});
    // ask the server to send due notifications now (after approvals, orders, meetings …)
    window.NX_PUSH_SWEEP = () => fetch(CFG.url + '/functions/v1/push', { method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: '{"type":"sweep"}' }).catch(() => {});
  })();
  // tell people when a newer NEXUS has been published (browsers keep the old page for a while)
  (() => {
    const mine = ((document.querySelector('script[src*="nexus-sb.js"]') || {}).src || '').match(/[?&]v=(\d+)/)?.[1];
    if (!mine) return;
    let shown = false;
    const check = async () => {
      if (shown || document.hidden) return;
      try {
        const html = await fetch('index.html?check=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.text() : '');
        const live = html.match(/nexus-sb\.js\?v=(\d+)/)?.[1];
        if (live && +live > +mine) {
          shown = true;
          const bar = document.createElement('div');
          bar.setAttribute('role', 'status');
          bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:120;background:#182340;color:#fff;padding:10px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;font:14px Arial,sans-serif;max-width:calc(100vw - 32px)';
          bar.innerHTML = '<span>A new version of NEXUS is ready.</span><button type="button" style="background:#539FDC;color:#0E1830;border:0;border-radius:6px;padding:7px 12px;font-weight:700;cursor:pointer">Reload</button>';
          bar.querySelector('button').onclick = async () => { try { await fetch('index.html', { cache: 'reload' }); await fetch('./', { cache: 'reload' }); } catch (_) {} location.reload(); };
          document.body.append(bar);
        }
      } catch (_) {}
    };
    setTimeout(check, 20e3); setInterval(check, 5 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  })();
  // run the cloud tender sync straight away (used after a manual pipeline import)
  window.NX_SYNC_NOW = async () => {
    const r = await fetch(CFG.url + '/functions/v1/tender-sync?force=1', { method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: '{}' });
    return r.ok ? r.json() : null;
  };
  // email the approvers straight away when a purchase request is sent
  window.NX_NOTIFY_PR = async () => {
    setTimeout(() => window.NX_PUSH_SWEEP?.(), 4000);
    try { const r = await fetch(CFG.url + '/functions/v1/tender-sync?pr=1', { method: 'POST', headers: { apikey: CFG.key, 'Content-Type': 'application/json' }, body: '{}' }); return r.ok ? r.json() : null; } catch (_) { return null; }
  };

  /* ---------------- backups (administrators) ---------------- */
  const BK_URL = CFG.url + '/functions/v1/nexus-backup';
  const bkEsc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bkWhen = v => { const t = Date.parse(v || ''); return t ? new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'; };
  const bkSay = m => (window.toast ? window.toast(m) : alert(m));
  let bkBusy = '', bkProg = '';
  const bkSize = n => { n = +n || 0; return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
  window.NX_FILES_BK = undefined;   // status of the last photo/document download (system/files_backup)
  async function loadFilesBk() {
    try { const { data } = await sb.from('docs').select('data').eq('col', 'system').eq('id', 'files_backup').maybeSingle(); window.NX_FILES_BK = data ? data.data : null; window.renderAll?.(); } catch (_) {}
  }
  window.NX_BACKUP_CARD = bk => {
    const fb = window.NX_FILES_BK;
    const age = bk && bk.last_ok ? (Date.now() - Date.parse(bk.last_ok)) / 36e5 : 1e9;
    const chip = !bk ? '<span class="chip amb">No backup yet</span>' : bk.error ? '<span class="chip bad">Last backup failed</span>'
      : age > 48 ? '<span class="chip bad">Late</span>' : '<span class="chip good">Protected</span>';
    const b = (k, t, pri) => `<button class="btn sm ${pri ? 'pri' : ''}" data-nxbk="${k}" ${bkBusy ? 'disabled' : ''}>${bkBusy === k ? '<span class="spin"></span> ' : ''}${t}</button>`;
    return `<div class="card"><div class="hd"><h2>Backups</h2>${chip}</div><div class="bd small">
      <p>Every night at 02:15 NEXUS saves a full copy of all records and logins, keeps it for 35 days (plus the 1st of every month for good), and emails the file to the administrators.</p>
      <p>Last backup: <b>${bkWhen(bk && bk.last_ok)}</b>${bk && bk.records ? ` · ${bk.records} records · ${Math.max(1, Math.round((bk.size || 0) / 1024))} KB · ${bk.stored || 0} copies kept · ${bk.emailed ? 'emailed' : '<b>not emailed</b>'}` : ''}${bk && bk.error ? `<br><span style="color:var(--bad)">${bkEsc(bk.error)}</span>` : ''}</p>
      <p>Photos &amp; documents: <b>${bk && bk.files != null ? bk.files + ' file' + (bk.files === 1 ? '' : 's') : '—'}</b> in NEXUS storage · last downloaded <b>${bkWhen(fb && fb.last_at)}</b>${fb && fb.files ? ` (${fb.files} files, ${bkSize(fb.bytes)})` : ''}. They are not inside the nightly file – download them once a week and save the zip in the Google Drive folder.</p>
      ${bkProg ? `<p><span class="spin"></span> ${bkEsc(bkProg)}</p>` : ''}
      <div class="toolbar">${b('download', 'Download backup now', true)}${b('run', 'Back up + email now')}${b('files', 'Download photos & documents (.zip)')}${b('restore', 'Restore from file…')}</div></div></div>`;
  };
  async function bkCall(q, body) {
    const { data: { session: s } } = await sb.auth.getSession();
    const r = await fetch(BK_URL + '?' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + (s && s.access_token), apikey: CFG.key }, body: body || '{}' });
    if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch (_) {} throw new Error(m || 'Backup service error ' + r.status); }
    return r;
  }
  // minimal ZIP writer (stored, no compression – photos and PDFs are already compressed)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(entries) { // [{name, data: Uint8Array}]
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF,
      dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    for (const e of entries) {
      const nm = enc.encode(e.name), c = crc32(e.data), sz = e.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, c, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
      h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), nm, e.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, c, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + sz;
    }
    const cdSize = central.reduce((a, x) => a + x.length, 0), end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
  window.NX_ZIP = makeZip;   // v151: also used to download a project's files as one .zip
  async function listAllFiles(prefix = '') {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await sb.storage.from('files').list(prefix, { limit: 1000, offset });
      if (error) throw new Error(error.message);
      for (const f of data || []) { const p = prefix ? prefix + '/' + f.name : f.name; if (f.id === null) out.push(...await listAllFiles(p)); else out.push({ path: p, size: f.metadata?.size || 0 }); }
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  async function downloadFilesZip() {
    bkProg = 'Listing files…'; window.renderAll?.();
    const list = await listAllFiles();
    const total = list.reduce((a, f) => a + f.size, 0);
    if (total > 1.5 * 1073741824) throw new Error('More than 1.5 GB of files – ask the developer to split the download by year.');
    const entries = [], failed = []; let bytes = 0;
    for (const [i, f] of list.entries()) {
      bkProg = `Downloading ${i + 1} of ${list.length} (${bkSize(bytes)})…`; if (i % 5 === 0) window.renderAll?.();
      const { data, error } = await sb.storage.from('files').download(f.path);
      if (error || !data) { failed.push(f.path); continue; }
      const u8 = new Uint8Array(await data.arrayBuffer()); bytes += u8.length; entries.push({ name: f.path, data: u8 });
    }
    const manifest = ['path,size_bytes', ...list.map(f => `"${f.path}",${f.size}`)].join('\r\n') + (failed.length ? '\r\n\r\nNOT DOWNLOADED:\r\n' + failed.join('\r\n') : '');
    entries.push({ name: 'NEXUS-files-list.csv', data: new TextEncoder().encode(manifest) });
    bkProg = 'Saving zip…'; window.renderAll?.();
    const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    await downloads.save({ filename: `nexus-photos-documents-${day}.zip`, data: makeZip(entries) });
    const status = { last_at: new Date().toISOString(), files: list.length - failed.length, failed: failed.length, bytes, by: profile?.email || '' };
    await sb.from('docs').upsert({ col: 'system', id: 'files_backup', data: status }, { onConflict: CLOUD ? 'tenant_id,col,id' : 'col,id' });
    window.NX_FILES_BK = status;
    return status;
  }
  async function bkDo(k) {
    if (bkBusy) return;
    if (k === 'files') {
      bkBusy = 'files'; window.renderAll?.();
      try { const st = await downloadFilesZip(); bkSay(st.files ? `Saved ${st.files} photos/documents (${bkSize(st.bytes)})${st.failed ? ` – ${st.failed} could not be read` : ''}. Put the zip in the Google Drive folder.` : 'No photos or documents are stored yet – nothing to download.'); }
      catch (e) { bkSay('Photo backup failed: ' + e.message); } finally { bkBusy = ''; bkProg = ''; window.renderAll?.(); }
      return;
    }
    if (k === 'restore') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.gz,.json,application/gzip,application/json';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; if (!f) return;
        const ok = window.confirmBox ? await window.confirmBox(`Restore NEXUS from "${f.name}"? Every record in the file is put back as it was in the backup. Records created after the backup are kept. A safety copy of today's data is saved first.`, 'Restore', true) : confirm('Restore NEXUS from ' + f.name + '?');
        if (!ok) return;
        bkBusy = 'restore'; window.renderAll?.();
        try { const r = await bkCall('restore=1', await f.arrayBuffer()); const j = await r.json(); bkSay(`Restored ${j.restored} records from the backup of ${bkWhen(j.from)}.`); }
        catch (e) { bkSay(e.message); } finally { bkBusy = ''; window.renderAll?.(); }
      };
      inp.click(); return;
    }
    bkBusy = k; window.renderAll?.();
    try {
      if (k === 'download') {
        const r = await bkCall('download=1'); const blob = await r.blob();
        const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'nexus-backup.json.gz';
        await downloads.save({ filename: name, data: blob });
        bkSay('Backup downloaded: ' + name);
      } else {
        const j = await (await bkCall('run=1')).json();
        bkSay(j.ok ? `Backup saved (${j.records} records)${j.emailed ? ' and emailed' : ''}.` : 'Backup failed: ' + j.error);
      }
    } catch (e) { bkSay(e.message); } finally { bkBusy = ''; window.renderAll?.(); }
  }
  document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-nxbk]'); if (b) { e.preventDefault(); bkDo(b.dataset.nxbk); } });

  /* ================= account menu + login management ================= */
  const ROLE_TXT = { admin: 'Administrator', finance: 'Finance', procurement: 'Procurement Officer', qs: 'Quantity Surveyor', staff: 'Staff', viewer: 'Viewer (read only)' };
  window.NX_ROLE = () => ROLE_TXT[profile?.role] || '';
  function attachMenu() {
    const who = document.querySelector('.who'); if (!who) return;
    who.style.cursor = 'pointer'; who.title = 'Account';
    who.onclick = e => {
      e.stopPropagation();
      document.querySelector('.nxw')?.remove();
      const r = who.getBoundingClientRect();
      const m = document.createElement('div'); m.className = 'nxw';
      m.style.top = (r.bottom + 6) + 'px'; m.style.right = Math.max(8, innerWidth - r.right) + 'px';
      m.innerHTML = `<div class="who2"><b>${h(profile?.name || '')}</b><br><span style="opacity:.7">${h(session.user.email)} · ${h(ROLE_TXT[profile?.role] || '')}</span></div>
        ${profile?.role === 'admin' ? '<button data-m="users">Manage logins</button>' : ''}
        ${CLOUD && profile?.platform ? '<button data-m="plat">NEXUS Cloud – companies</button>' : ''}
        <button data-m="pw">Change my password</button><button data-m="out">Sign out</button>`;
      m.onclick = async ev => {
        const k = ev.target.closest('[data-m]')?.dataset.m; if (!k) return; m.remove();
        if (k === 'out') { await sb.auth.signOut({ scope: 'local' }); location.reload(); }
        if (k === 'pw') { if (await newPasswordScreen(false)) window.toast?.('Password changed.'); }
        if (k === 'users') openUsers();
        if (k === 'plat') openPlatform();
      };
      document.body.append(m);
      setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('click', off); } }), 0);
    };
  }

  async function adminCall(body) {
    const { data, error } = await sb.functions.invoke('admin-users', { body });
    if (error) { let b = null; try { b = await error.context?.json(); } catch (_) {} throw new Error(b?.message || b?.error || error.message); }
    return data;
  }
  // ---------- NEXUS Cloud: platform owner panel (companies, trials, payments, seats) ----------
  async function openPlatform() {
    closeScreen();
    const w = document.createElement('div'); w.className = 'nxm';
    w.innerHTML = '<div class="box" style="width:min(1100px,100%)"><p>Loading companies…</p></div>';
    w.onclick = e => { if (e.target === w) w.remove(); };
    document.body.append(w);
    const box = w.querySelector('.box');
    const ST = { pending: 'Waiting for approval', trial: 'Free trial', active: 'Active (paid)', suspended: 'Suspended', closed: 'Closed' };
    const COL = { pending: '#F2A900', trial: '#2E75B6', active: '#2E8B57', suspended: '#C0392B', closed: '#7A869A' };
    const day = (d, n) => { const x = new Date(d || Date.now()); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    let payInfo = {};
    async function render() {
      const { data, error } = await sb.rpc('nx_companies');
      if (error) { box.innerHTML = `<p>${h(error.message)}</p><button class="btn sm" data-close>Close</button>`; box.querySelector('[data-close]').onclick = () => w.remove(); return; }
      const L = data || [], n = k => L.filter(c => c.status === k).length;
      const { data: cl } = await sb.rpc('nx_payment_claims'); const claims = cl || [];
      try { const { data: pi } = await sb.rpc('nx_pay_info'); payInfo = pi || {}; } catch (_) {}
      box.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><h2 style="margin:0;font:700 21px var(--f-display,Arial);text-transform:uppercase">NEXUS Cloud – companies</h2><div style="flex:1"></div><button class="btn sm" data-close>Close</button></div>
        <p class="small muted" style="margin:4px 0 10px">${L.length} companies · ${n('pending')} waiting · ${n('trial')} on trial · ${n('active')} paying · ${n('suspended')} suspended. Only you (platform owner) see this. You never see the companies' records.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Company</th><th>Contact</th><th>Status</th><th>Users</th><th>Trial until</th><th>Paid until</th><th>Seats</th><th>Notes</th><th></th></tr></thead><tbody>
        ${L.map(c => `<tr data-cid="${h(c.id)}">
          <td><b>${h(c.name)}</b><div class="small muted">${h(c.country || '')} · since ${h(String(c.created_at).slice(0, 10))}</div>${c.open ? '<span class="small" style="color:#2E8B57">● open</span>' : '<span class="small" style="color:#C0392B">● closed</span>'}</td>
          <td class="small">${h(c.contact_name || '')}<div>${h(c.contact_email || '')}</div><div class="muted">${h(c.contact_phone || '')}</div></td>
          <td><select data-f="status" aria-label="Status" style="border-left:4px solid ${COL[c.status] || '#999'}">${Object.keys(ST).map(k => `<option value="${k}"${k === c.status ? ' selected' : ''}>${ST[k]}</option>`).join('')}</select></td>
          <td class="small">${c.users} active<div class="muted">${c.records} records</div></td>
          <td><input type="date" data-f="trial" value="${h(c.trial_until || '')}" aria-label="Trial until"></td>
          <td><input type="date" data-f="paid" value="${h(c.paid_until || '')}" aria-label="Paid until"></td>
          <td><input type="number" min="1" max="999" data-f="seats" value="${h(c.seats)}" style="width:64px" aria-label="Seats"></td>
          <td><input data-f="notes" value="${h(c.notes || '')}" placeholder="e.g. invoice 012, paid M-Pesa" aria-label="Notes"></td>
          <td style="white-space:nowrap">${c.status === 'pending' ? `<button class="btn sm pri" data-quick="trial">Approve – 30-day trial</button> ` : ''}${c.status !== 'pending' ? `<button class="btn sm" data-quick="year">+1 year paid</button> ` : ''}<button class="btn sm pri" data-save>Save</button></td></tr>`).join('') || '<tr><td colspan="9">No companies yet. Companies appear here when someone chooses “Register a new company” on the sign-in page.</td></tr>'}
        </tbody></table></div><p class="small" data-msg role="status"></p>
        <details ${claims.some(x => x.status === 'new') ? 'open' : ''}><summary style="cursor:pointer;font-weight:700">Payment notices from companies (${claims.filter(x => x.status === 'new').length} new)</summary>
          <p class="small muted">Check each one against your bank / mobile money statement. If the money arrived: <b>Confirm</b>, then give the company <b>+1 year paid</b> (or the paid period) above.</p>
          <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Company</th><th>By</th><th>Paid by</th><th>Reference</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
          ${claims.map(x => `<tr><td class="small">${h(String(x.created_at).slice(0, 16).replace('T', ' '))}</td><td>${h(x.company)}</td><td class="small">${h(x.who || '')}</td><td class="small">${h(x.method || '')}</td><td style="font-family:monospace">${h(x.reference)}</td><td class="small">${h(x.amount || '')}</td>
            <td><b style="color:${x.status === 'new' ? '#F2A900' : x.status === 'confirmed' ? '#2E8B57' : '#C0392B'}">${h(x.status)}</b></td>
            <td style="white-space:nowrap">${x.status === 'new' ? `<button class="btn sm pri" data-pclaim="${x.id}:confirmed">Confirm</button> <button class="btn sm" data-pclaim="${x.id}:rejected">Reject</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8">No payment notices yet.</td></tr>'}
          </tbody></table></div></details>
        <details><summary style="cursor:pointer;font-weight:700">How companies pay you (shown on their payment screen)</summary>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin-top:8px">
          ${PAY_FIELDS.map(([k, l]) => `<label class="small" style="display:flex;flex-direction:column;gap:3px"><b>${h(l)}</b><textarea data-pi="${k}" rows="3" placeholder="${h({ price: 'e.g. TZS 600,000 per year (up to 25 users)', bank: 'Bank name, account name, account number, branch', mobile: 'e.g. M-Pesa Lipa Namba / till number and name', contact: 'Phone / WhatsApp / email for payment questions', other: 'Anything else (e.g. invoices on request)' }[k])}">${h(payInfo[k] || '')}</textarea></label>`).join('')}
          </div><button class="btn sm pri" data-savepay style="margin-top:8px">Save payment details</button></details>`;
      box.querySelector('[data-savepay]').onclick = async () => { const v = {}; box.querySelectorAll('[data-pi]').forEach(t => { v[t.dataset.pi] = t.value.trim(); }); const { error } = await sb.rpc('nx_pay_info_set', { v }); const el = box.querySelector('[data-msg]'); if (el) el.textContent = error ? error.message : 'Payment details saved.'; if (!error) payInfo = v; };
      box.querySelector('[data-close]').onclick = () => w.remove();
    }
    box.addEventListener('click', async e => {
      const cb = e.target.closest('[data-pclaim]');
      if (cb) { const [id, st] = cb.dataset.pclaim.split(':'); const { error } = await sb.rpc('nx_payment_claim_set', { cid: +id, new_status: st }); if (!error) await render(); const el = box.querySelector('[data-msg]'); if (el) el.textContent = error ? error.message : (st === 'confirmed' ? 'Payment confirmed – now extend the company\'s paid period above.' : 'Payment notice rejected.'); return; }
      const tr = e.target.closest('tr[data-cid]'); const say = t => { const el = box.querySelector('[data-msg]'); if (el) el.textContent = t; };
      if (!tr) return; const g = k => tr.querySelector(`[data-f="${k}"]`);
      const q = e.target.closest('[data-quick]')?.dataset.quick;
      if (q === 'trial') { g('status').value = 'trial'; if (!g('trial').value) g('trial').value = day(null, 30); }
      if (q === 'year') { g('status').value = 'active'; g('paid').value = day(g('paid').value && g('paid').value > day(null, 0) ? g('paid').value : null, 365); }
      if (!q && !e.target.closest('[data-save]')) return;
      const args = { cid: tr.dataset.cid, new_status: g('status').value, trial: g('trial').value || null, paid: g('paid').value || null, new_plan: null, new_seats: +g('seats').value || null, note: g('notes').value };
      const { error } = await sb.rpc('nx_company_set', args);
      if (error) { say(error.message); return; }
      await render(); say('Saved.');
    });
    render();
  }
  window.NX_OPEN_PLATFORM = () => openPlatform();

  async function openUsers() {
    const w = document.createElement('div'); w.className = 'nxm';
    w.innerHTML = '<div class="box"><p>Loading logins…</p></div>';
    w.onclick = e => { if (e.target === w) w.remove(); };
    document.body.append(w);
    const box = w.querySelector('.box');
    const say = t => { const el = box.querySelector('[data-msg]'); if (el) el.textContent = t; };
    async function render() {
      let users = [];
      try { users = (await adminCall({ action: 'list' })).users; } catch (e) { box.innerHTML = `<p>${h(e.message)}</p>`; return; }
      const roleSel = (id, r) => `<select data-role="${h(id)}" aria-label="Role">${Object.keys(ROLE_TXT).map(k => `<option value="${k}"${k === r ? ' selected' : ''}>${ROLE_TXT[k]}</option>`).join('')}</select>`;
      box.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><h2 style="margin:0;font:700 21px var(--f-display,Arial);text-transform:uppercase">Manage logins</h2><div style="flex:1"></div><button class="btn sm" data-close>Close</button></div>
        ${(() => { const P = users.filter(u => u.pending); return P.length ? `<div style="border:2px solid #F2A900;border-radius:6px;padding:10px 12px"><h3 style="margin:0 0 6px">Waiting for approval (${P.length})</h3>
          <p class="small muted" style="margin:0 0 6px">Only approve people you know. Choose the role, then Approve.</p><div class="tbl-wrap"><table><tbody>
          ${P.map(u => `<tr><td><b>${h(u.name || '')}</b><div class="small muted">${h(u.email || '')}</div></td><td class="small">${h(u.position || '')}<div class="muted">${h(u.phone || '')}</div></td>
            <td class="small">${u.requested_at ? new Date(u.requested_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</td>
            <td><select data-aprole="${h(u.user_id)}" aria-label="Role">${Object.keys(ROLE_TXT).map(k => `<option value="${k}"${k === 'staff' ? ' selected' : ''}>${ROLE_TXT[k]}</option>`).join('')}</select></td>
            <td style="white-space:nowrap"><button class="btn sm pri" data-approve="${h(u.user_id)}">Approve</button> <button class="btn sm danger" data-reject="${h(u.user_id)}">Reject</button></td></tr>`).join('')}
          </tbody></table></div></div>` : ''; })()}
        ${CLOUD && profile?.company?.join_code ? `<div style="background:#EEF3FA;border-radius:6px;padding:10px 12px"><b>Company code: <span style="font:700 18px monospace;letter-spacing:.12em">${h(profile.company.join_code)}</span></b><div class="small muted">Staff choose <i>Sign up → Join my company</i> on the sign-in page and type this code. You then approve them here.${profile.company.seats ? ` Your plan allows ${h(profile.company.seats)} active users.` : ''}</div></div>` : ''}
        <p class="small muted">Only administrators see this. Staff can sign up themselves from the sign-in page (Sign up); you approve them above. You can also add a login directly below with a temporary password – give it in person or by phone, not by email.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
        ${users.filter(u => !u.pending).map(u => `<tr style="${u.active ? '' : 'opacity:.55'}"><td>${h(u.name || '')}</td><td>${h(u.email || '')}</td><td>${roleSel(u.user_id, u.role)}</td>
          <td class="small">${u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never'}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-reset="${h(u.user_id)}">New password</button> <button class="btn sm ${u.active ? 'danger' : ''}" data-act2="${h(u.user_id)}" data-on="${u.active ? 0 : 1}">${u.active ? 'Switch off' : 'Switch on'}</button>${u.active ? '' : ` <button class="btn sm danger" data-del="${h(u.user_id)}" data-name="${h(u.name || u.email || '')}" title="Delete this login for good">Delete</button>`}</td></tr>`).join('')}
        </tbody></table></div>
        <h3 style="margin:6px 0 0">Add a login</h3>
        <form class="row" data-new autocomplete="off">
          <label>Full name<input name="name" required></label>
          <label>Email<input name="email" type="email" required></label>
          <label>Role${roleSel('', 'staff').replace('data-role=""', 'name="role"')}</label>
          <label>Temporary password (8+)<input name="pw" type="text" minlength="8" required autocomplete="new-password"></label>
          <button class="btn pri" type="submit">Create login</button>
        </form>
        <div class="small" data-msg role="status"></div>`;
      box.querySelector('[data-close]').onclick = () => w.remove();
      box.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
        const id = b.dataset.approve, role = box.querySelector(`[data-aprole="${id}"]`).value;
        try { await adminCall({ action: 'approve', id, role }); await render(); say(`Approved as ${ROLE_TXT[role]}. They can sign in now.`); window.NX_PENDING_REFRESH?.(); } catch (e) { say(e.message); }
      });
      box.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to reject'; return; }
        try { await adminCall({ action: 'reject', id: b.dataset.reject }); await render(); say('Sign-up rejected and removed.'); window.NX_PENDING_REFRESH?.(); } catch (e) { say(e.message); }
      });
      box.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
        try { await adminCall({ action: 'set_role', id: s.dataset.role, role: s.value }); say('Role updated.'); } catch (e) { say(e.message); render(); }
      });
      box.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => {
        const td = b.parentElement, id = b.dataset.reset;
        td.innerHTML = '<input type="text" placeholder="Temporary password (8+)" autocomplete="new-password" style="width:170px"> <button class="btn sm pri">Set</button> <button class="btn sm">Cancel</button>';
        const [inp, ok, no] = [td.querySelector('input'), ...td.querySelectorAll('button')];
        inp.focus(); no.onclick = () => render();
        ok.onclick = async () => {
          try { await adminCall({ action: 'set_password', id, password: inp.value }); say('Temporary password set. The person must change it at next sign-in.'); render(); } catch (e) { say(e.message); }
        };
      });
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Click again to delete'; say(`Deleting removes ${b.dataset.name}'s login and private chats for good. Their staff card and the records they made stay in NEXUS.`); return; }
        b.disabled = true;
        try { await adminCall({ action: 'delete', id: b.dataset.del }); await render(); say(`${b.dataset.name}'s login was deleted.`); } catch (e) { b.disabled = false; say(e.message); }
      });
      box.querySelectorAll('[data-act2]').forEach(b => b.onclick = async () => {
        try { await adminCall({ action: 'set_active', id: b.dataset.act2, active: b.dataset.on === '1' }); render(); } catch (e) { say(e.message); }
      });
      box.querySelector('[data-new]').onsubmit = async e => {
        e.preventDefault(); const f = e.target;
        try {
          const v = k => f.elements.namedItem(k).value.trim();
          const em = v('email');
          await adminCall({ action: 'create', name: v('name'), email: em, role: v('role'), password: f.elements.namedItem('pw').value });
          await render(); say(`Login created for ${em}.`);
        } catch (er) { say(er.message); }
      };
    }
    render();
  }
})();
