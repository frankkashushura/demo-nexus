/* NEXUS · private staff chat (1-to-1). Text, photos, documents, voice notes, video.
   Only the two people in a conversation can read it (database rules in 11_chat.sql). */
(function () {
  'use strict';
  const sb = window.NX_SB; if (!sb) return;
  const MAX = 25 * 1024 * 1024, PAGE = 100;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const say = m => (window.toast ? window.toast(m) : alert(m));
  const st = { slow: 0, me: null, people: new Map(), threads: [], unread: {}, mst: {}, cur: null, msgs: {}, more: {}, urls: {}, root: null, q: '', rec: null, ready: false, err: '' };
  window.NX_CHAT_UNREAD = 0; window.NX_CHAT_ALERTS = [];

  /* ---------- helpers ---------- */
  const other = t => (t.a === st.me ? t.b : t.a);
  const pName = id => st.people.get(id)?.name || 'Former user';
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const hhmm = iso => new Date(iso).toTimeString().slice(0, 5);
  const dayLabel = iso => { const d = new Date(iso), t = new Date(); const y = new Date(Date.now() - 864e5);
    return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }); };
  const listTime = iso => { if (!iso) return ''; const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? hhmm(iso) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };
  const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const linkify = s => esc(s).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(36).slice(2));
  const visible = () => document.visibilityState === 'visible' && (window.NX_ROUTE && window.NX_ROUTE()) === 'chat';
  function beep() { try { const A = window.AudioContext || window.webkitAudioContext; if (!A) return; const c = beep.c || (beep.c = new A()); const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.18, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.25);
    o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.26); } catch (_) {} }

  /* ---------- data ---------- */
  async function loadPeople() { const { data, error } = await sb.rpc('chat_people'); if (error) throw error; st.people = new Map((data || []).map(p => [p.user_id, p])); }
  async function loadThreads() { const { data, error } = await sb.from('chat_threads').select('*').order('last_at', { ascending: false }); if (error) throw error; st.threads = data || []; }
  async function loadUnread() {
    const { data } = await sb.from('chat_messages').select('thread_id').is('read_at', null).neq('sender', st.me).eq('deleted', false).limit(2000);
    st.unread = {}; (data || []).forEach(r => { st.unread[r.thread_id] = (st.unread[r.thread_id] || 0) + 1; });
    await markDelivered(); await loadMine(); badge();
  }
  // ticks like WhatsApp: ✓ sent · ✓✓ grey delivered (the other person's NEXUS received it) · ✓✓ blue read
  // "delivered" only while this person is really using NEXUS (app on screen) – a hidden/background tab does not count
  async function markDelivered(id) {
    if (document.visibilityState !== 'visible') return;
    try { let q = sb.from('chat_messages').update({ delivered_at: new Date().toISOString() }).neq('sender', st.me).is('delivered_at', null); if (id) q = q.eq('id', id); await q; } catch (_) {}
  }
  async function loadMine() {
    try { const { data, error } = await sb.from('chat_messages').select('thread_id,delivered_at').eq('sender', st.me).is('read_at', null).eq('deleted', false).limit(2000); if (error) return;
      const m = {}; (data || []).forEach(r => { if (!r.delivered_at) m[r.thread_id] = 'sent'; else if (!m[r.thread_id]) m[r.thread_id] = 'delivered'; }); st.mst = m; } catch (_) {}
  }
  let mineT = null; function refreshMine() { clearTimeout(mineT); mineT = setTimeout(async () => { await loadMine(); if (st.root) renderList(); }, 400); }
  const listTick = t => { const s = st.mst[t.id]; return s === 'sent' ? `<span style="color:var(--wa-sub)" title="Sent">${IC.t1}</span> ` : s === 'delivered' ? `<span style="color:var(--wa-sub)" title="Delivered">${IC.t2}</span> ` : `<span class="rd" style="color:var(--wa-tick)" title="Read">${IC.t2}</span> `; };
  async function loadMsgs(tid, older) {
    let q = sb.from('chat_messages').select('*').eq('thread_id', tid).order('created_at', { ascending: false }).limit(PAGE);
    const have = st.msgs[tid] || [];
    if (older && have.length) q = q.lt('created_at', have[0].created_at);
    const { data, error } = await q; if (error) throw error;
    const rows = (data || []).reverse();
    st.msgs[tid] = older ? [...rows, ...have] : rows; st.more[tid] = (data || []).length === PAGE;
  }
  async function markRead(tid) {
    const list = st.msgs[tid] || [];
    const pending = st.unread[tid] || list.some(m => m.sender !== st.me && !m.read_at && !m.tmp);
    if (!pending) return;
    st.unread[tid] = 0; badge();
    const now = new Date().toISOString();
    list.forEach(m => { if (m.sender !== st.me && !m.read_at) m.read_at = now; });
    await sb.from('chat_messages').update({ read_at: now }).eq('thread_id', tid).neq('sender', st.me).is('read_at', null);
  }
  // safety net: while a chat is open, re-check it every few seconds (new messages, ✓✓ read ticks, deletions)
  async function poll() {
    try {
      const tid = st.cur;
      if (tid && visible() && st.msgs[tid]) {
        const { data } = await sb.from('chat_messages').select('*').eq('thread_id', tid).order('created_at', { ascending: false }).limit(40);
        const list = st.msgs[tid]; let changed = false;
        for (const m of (data || []).reverse()) {
          const i = list.findIndex(x => x.id === m.id);
          if (i < 0) { const t = list.findIndex(x => x.tmp && x.sender === m.sender && x.kind === m.kind && (x.body || '') === (m.body || '')); if (t >= 0) list.splice(t, 1); list.push(m); changed = true; }
          else if (list[i].read_at !== m.read_at || list[i].delivered_at !== m.delivered_at || list[i].deleted !== m.deleted) { list[i] = m; changed = true; if (m.sender === st.me) refreshMine(); }
        }
        if (changed) { list.sort((a, b) => a.created_at.localeCompare(b.created_at)); renderMsgs(false); }
        if (list.some(m => m.sender !== st.me && !m.read_at)) markRead(tid).catch(() => {});
      } else if (++st.slow % 4 === 0) { await loadThreads(); await loadUnread(); }
    } catch (_) {}
  }
  function badge() {
    const n = Object.values(st.unread).reduce((a, b) => a + b, 0);
    window.NX_CHAT_UNREAD = n;
    window.NX_CHAT_ALERTS = st.threads.filter(t => st.unread[t.id]).map(t => ({ id: t.id, from: pName(other(t)), n: st.unread[t.id], text: t.last_text || '', at: t.last_at }));
    try { window.renderNav && window.renderNav(); } catch (_) {}
    if (st.root) renderList();
  }

  function subscribe() {
    sb.channel('nx-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, p => onNew(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, p => onUpd(p.new))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_threads' }, async () => { await loadThreads().catch(() => {}); badge(); })
      .subscribe();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markDelivered(); if (visible() && st.cur) markRead(st.cur).catch(() => {}); });
  }
  async function onNew(m) {
    let t = st.threads.find(x => x.id === m.thread_id);
    if (!t) { await loadThreads().catch(() => {}); await loadPeople().catch(() => {}); t = st.threads.find(x => x.id === m.thread_id); }
    const list = st.msgs[m.thread_id];
    if (list && !list.some(x => x.id === m.id)) { const tmp = list.findIndex(x => x.tmp && x.sender === m.sender && x.body === m.body && x.kind === m.kind); if (tmp >= 0) list.splice(tmp, 1); list.push(m); }
    if (t) { t.last_at = m.created_at; t.last_from = m.sender; t.last_text = preview(m); st.threads.sort((a, b) => b.last_at.localeCompare(a.last_at)); }
    if (m.sender === st.me) { if (!m.read_at) st.mst[m.thread_id] = m.delivered_at ? 'delivered' : 'sent'; }
    if (m.sender !== st.me) {
      if (!m.delivered_at) markDelivered(m.id);
      if (st.cur === m.thread_id && visible()) markRead(m.thread_id).catch(() => {});
      else { st.unread[m.thread_id] = (st.unread[m.thread_id] || 0) + 1; beep(); if ((window.NX_ROUTE && window.NX_ROUTE()) !== 'chat' || st.cur !== m.thread_id) say(`💬 ${pName(m.sender)}: ${preview(m)}`); }
    }
    badge(); if (st.cur === m.thread_id) renderMsgs(true);
  }
  function onUpd(m) { if (m.sender === st.me) refreshMine(); const list = st.msgs[m.thread_id]; if (!list) return; const i = list.findIndex(x => x.id === m.id); if (i >= 0) { list[i] = m; if (st.cur === m.thread_id) renderMsgs(false); } }
  const preview = m => m.deleted ? 'Message deleted' : m.kind === 'text' ? String(m.body || '').slice(0, 120) : { image: '📷 Photo', video: '🎬 Video', audio: '🎤 Voice note' }[m.kind] || '📄 ' + (m.file_name || 'Document');

  /* ---------- sending ---------- */
  async function sendText(txt) {
    const tid = st.cur; if (!tid || !txt.trim()) return;
    const rt = st.reply || null; if (st.reply) { st.reply = null; renderComposer(); }
    const tmp = { id: 'tmp' + uuid(), tmp: true, thread_id: tid, sender: st.me, kind: 'text', body: txt.trim(), reply_to: rt, created_at: new Date().toISOString() };
    (st.msgs[tid] = st.msgs[tid] || []).push(tmp); renderMsgs(true);
    const { data, error } = await sb.from('chat_messages').insert({ thread_id: tid, kind: 'text', body: txt.trim(), reply_to: rt }).select().single();
    const list = st.msgs[tid]; const i = list.findIndex(x => x.id === tmp.id);
    if (error) { if (i >= 0) list[i] = { ...tmp, failed: true }; say('Message not sent – check your connection.'); }
    else if (i >= 0) { if (list.some(x => x.id === data.id)) list.splice(i, 1); else list[i] = data; }
    renderMsgs(true);
  }
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 450 * 1024) return file;
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.82)); URL.revokeObjectURL(img.src);
      return b && b.size < file.size ? new File([b], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch (_) { return file; }
  }
  async function sendFile(file, forceKind) {
    const tid = st.cur; if (!tid || !file) return;
    const kind = forceKind || (/^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : 'file');
    if (kind === 'image') file = await shrink(file);
    if (file.size > MAX) { say(`"${file.name}" is ${size(file.size)} – the limit is 25 MB.`); return; }
    const safe = String(file.name || kind).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || kind;
    const path = `${tid}/${uuid()}-${safe}`;
    const tmp = { id: 'tmp' + uuid(), tmp: true, uploading: true, thread_id: tid, sender: st.me, kind, file_name: file.name || safe, file_size: file.size, created_at: new Date().toISOString() };
    (st.msgs[tid] = st.msgs[tid] || []).push(tmp); renderMsgs(true);
    const up = await sb.storage.from('chat').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    const list = st.msgs[tid], drop = () => { const i = list.findIndex(x => x.id === tmp.id); if (i >= 0) list.splice(i, 1); };
    if (up.error) { drop(); renderMsgs(true); say('Upload failed: ' + up.error.message); return; }
    const { data, error } = await sb.from('chat_messages').insert({ thread_id: tid, kind, file_path: path, file_name: file.name || safe, file_size: file.size, mime: file.type || '' }).select().single();
    drop(); if (error) say('Not sent: ' + error.message); else if (!list.some(x => x.id === data.id)) list.push(data);
    renderMsgs(true);
  }
  async function delMsg(id) {
    const m = (st.msgs[st.cur] || []).find(x => x.id === id); if (!m || m.sender !== st.me) return;
    const ok = window.confirmBox ? await window.confirmBox('Delete this message for everyone?', 'Delete', true) : confirm('Delete this message for everyone?');
    if (!ok) return;
    const { error } = await sb.from('chat_messages').update({ deleted: true }).eq('id', id);
    if (error) say('Could not delete: ' + error.message);
  }

  /* ---------- WhatsApp-style message actions ---------- */
  const vis = m => !(m.hidden_for || []).includes(st.me);
  const findMsg = id => (st.msgs[st.cur] || []).find(x => x.id === id);
  const canEdit = m => m.sender === st.me && m.kind === 'text' && !m.deleted && !m.tmp && Date.now() - Date.parse(m.created_at) < 15 * 60e3;
  const canDelAll = m => m.sender === st.me && !m.deleted && !m.tmp && Date.now() - Date.parse(m.created_at) < 48 * 3600e3;
  const EMO = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  function closeMenu() { document.querySelectorAll('.nxc-back-drop').forEach(x => x.remove()); }
  function sheet(html, anchor) {
    closeMenu();
    const bd = document.createElement('div'); bd.className = 'nxc-back-drop'; bd.innerHTML = `<div class="nxc-menu">${html}</div>`;
    bd.addEventListener('click', e => { if (e.target === bd) closeMenu(); });
    st.root.append(bd); const m = bd.firstChild;
    if (anchor && !mobile() && anchor.getBoundingClientRect().width) { const r = anchor.getBoundingClientRect(), W = m.offsetWidth, H = m.offsetHeight;
      m.style.position = 'fixed'; m.style.left = Math.max(8, Math.min(window.innerWidth - W - 8, r.right - W)) + 'px'; m.style.top = Math.max(8, Math.min(window.innerHeight - H - 8, r.bottom + 4)) + 'px'; }
    return m;
  }
  function openMenu(id, anchor) {
    const m = findMsg(id); if (!m || m.tmp) return;
    const mine = (m.reactions || {})[st.me];
    const items = [];
    if (!m.deleted) items.push(['reply', '↩️', 'Reply']);
    if (!m.deleted && m.kind === 'text' && m.body) items.push(['copy', '📋', 'Copy']);
    if (!m.deleted && !m.uploading) items.push(['forward', '↪️', 'Forward']);
    if (canEdit(m)) items.push(['edit', '✏️', 'Edit']);
    items.push(['delask', '🗑️', 'Delete']);
    sheet(`${m.deleted ? '' : `<div class="nxc-emo">${EMO.map(e => `<button data-c="react" data-v="${m.id}" data-e="${e}" class="${mine === e ? 'on' : ''}">${e}</button>`).join('')}</div>`}
      ${items.map(([a, i, t]) => `<button class="nxc-mi ${a === 'delask' ? 'bad' : ''}" data-c="${a}" data-v="${m.id}"><span>${i}</span>${t}</button>`).join('')}`, anchor);
  }
  function askDelete(id) {
    const m = findMsg(id); if (!m) return;
    sheet(`<div class="nxc-mh">Delete message?</div>
      ${canDelAll(m) ? `<button class="nxc-mi bad" data-c="delall" data-v="${m.id}"><span>🗑️</span>Delete for everyone</button>` : ''}
      <button class="nxc-mi bad" data-c="delme" data-v="${m.id}"><span>🙈</span>Delete for me</button>
      <button class="nxc-mi" data-c="menuclose"><span>✕</span>Cancel</button>
      ${m.sender === st.me && !m.deleted && !canDelAll(m) ? '<div class="nxc-mh" style="font-weight:400">Older than 48 hours – it can only be deleted for you.</div>' : ''}`);
  }
  async function delMe(id) {
    const m = findMsg(id); if (!m) return; closeMenu();
    const h = [...new Set([...(m.hidden_for || []), st.me])];
    const { error } = await sb.from('chat_messages').update({ hidden_for: h }).eq('id', id);
    if (error) return say('Could not delete: ' + error.message);
    m.hidden_for = h; renderMsgs(false);
  }
  async function delAll(id) {
    closeMenu(); const { error } = await sb.from('chat_messages').update({ deleted: true }).eq('id', id);
    if (error) return say('Could not delete: ' + error.message);
    const m = findMsg(id); if (m) { m.deleted = true; m.body = null; m.file_path = null; renderMsgs(false); }
  }
  async function react(id, e) {
    const m = findMsg(id); if (!m) return; closeMenu();
    const r = { ...(m.reactions || {}) }; if (r[st.me] === e) delete r[st.me]; else r[st.me] = e;
    const { error } = await sb.from('chat_messages').update({ reactions: r }).eq('id', id);
    if (error) return say('Could not react: ' + error.message);
    m.reactions = r; renderMsgs(false);
  }
  function startCtx(kind, id) {
    const m = findMsg(id); if (!m) return; closeMenu();
    st.reply = kind === 'reply' ? id : null; st.edit = kind === 'edit' ? id : null;
    renderComposer(); const t = st.root.querySelector('#nxcText');
    if (kind === 'edit') { t.value = m.body || ''; t.dispatchEvent(new Event('input', { bubbles: true })); }
    t.focus();
  }
  async function saveEdit(id, txt) {
    const m = findMsg(id); st.edit = null; renderComposer();
    if (!m || txt.trim() === (m.body || '').trim()) return;
    const { data, error } = await sb.from('chat_messages').update({ body: txt.trim() }).eq('id', id).select().single();
    if (error) return say(error.message);
    Object.assign(m, data); renderMsgs(false);
  }
  function snippet(m) { return !m ? 'Original message' : m.deleted ? '🚫 This message was deleted' : m.kind === 'text' ? String(m.body || '').slice(0, 90) : preview(m); }
  function ctxBar() {
    const id = st.reply || st.edit; if (!id) return ''; const m = findMsg(id);
    return `<div class="nxc-ctx"><div class="q"><b>${st.edit ? '✏️ Edit message' : esc(m && m.sender === st.me ? 'You' : pName(m && m.sender))}</b><span>${esc(snippet(m))}</span></div><button class="nxc-ib" data-c="ctxclose" title="Cancel">✕</button></div>`;
  }
  function forwardPick(id) {
    const m = findMsg(id); if (!m) return; st.fwd = { id, to: new Set() };
    const ppl = [...st.people.values()];
    sheet(`<div class="nxc-mh">Forward message to… <span class="nxc-sub">(up to 5)</span></div>
      <div class="nxc-fl">${ppl.map(p => `<label class="nxc-fp"><input type="checkbox" data-fwto="${p.user_id}">${av(p.name).replace('nxc-av', 'nxc-av sm')}<span>${esc(p.name)}<br><small>${esc(p.job || '')}</small></span></label>`).join('') || '<div class="nxc-mh">No colleagues yet.</div>'}</div>
      <div style="display:flex;justify-content:flex-end;padding:8px"><button class="nxc-round" data-c="fwdsend" title="Forward">${IC.send}</button></div>`)
      .addEventListener('change', e => { const u = e.target.dataset.fwto; if (!u) return; if (e.target.checked) { if (st.fwd.to.size >= 5) { e.target.checked = false; say('You can forward to up to 5 people at a time.'); return; } st.fwd.to.add(u); } else st.fwd.to.delete(u); });
  }
  async function forwardSend() {
    const f = st.fwd, m = f && findMsg(f.id); if (!m || !f.to.size) return say('Choose at least one person.');
    closeMenu(); let n = 0;
    for (const u of f.to) {
      try {
        const { data: tid, error } = await sb.rpc('chat_open', { other: u }); if (error) throw error;
        const row = { thread_id: tid, kind: m.kind, fwd: true, body: m.kind === 'text' ? m.body : null };
        if (m.file_path) { const dst = `${tid}/${uuid()}-${String(m.file_name || m.kind).replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}`;
          const cp = await sb.storage.from('chat').copy(m.file_path, dst); if (cp.error) throw cp.error;
          Object.assign(row, { file_path: dst, file_name: m.file_name, file_size: m.file_size, mime: m.mime }); }
        const ins = await sb.from('chat_messages').insert(row); if (ins.error) throw ins.error; n++;
      } catch (e) { say('Forward failed: ' + (e.message || e)); }
    }
    st.fwd = null; await loadThreads().catch(() => {}); renderList(); if (n) say(`Forwarded to ${n} ${n > 1 ? 'people' : 'person'}.`);
  }
  function jump(id) {
    const el = st.root.querySelector(`.nxc-b[data-id="${id}"]`); if (!el) return say('Scroll up / load earlier messages to see the original.');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400);
  }
  /* presence (online) + typing… */
  function presence() {
    try {
      st.pres = sb.channel('nx-online', { config: { presence: { key: st.me } } });
      st.pres.on('presence', { event: 'sync' }, () => { st.online = new Set(Object.keys(st.pres.presenceState())); headStatus(); })
        .subscribe(async s => { if (s === 'SUBSCRIBED') { try { await st.pres.track({ at: Date.now() }); } catch (_) {} } });
    } catch (_) {}
  }
  function typingChannel(tid) {
    try { if (st.tch) sb.removeChannel(st.tch); } catch (_) {}
    st.typing = 0;
    st.tch = sb.channel('nx-typing-' + tid).on('broadcast', { event: 'typing' }, p => { if (p.payload && p.payload.u !== st.me) { st.typing = Date.now(); headStatus(); setTimeout(headStatus, 3200); } }).subscribe();
  }
  function sendTyping() { if (!st.tch || Date.now() - (st.lastType || 0) < 2000) return; st.lastType = Date.now(); try { st.tch.send({ type: 'broadcast', event: 'typing', payload: { u: st.me } }); } catch (_) {} }
  function headStatus() {
    const el = st.root && st.root.querySelector('.nxc-st'); const t = st.threads.find(x => x.id === st.cur); if (!el || !t) return;
    const o = other(t), p = st.people.get(o) || {};
    if (Date.now() - (st.typing || 0) < 3000) { el.textContent = 'typing…'; el.classList.add('live'); }
    else if (st.online && st.online.has(o)) { el.textContent = 'online'; el.classList.add('live'); }
    else { el.textContent = `${p.job || (p.role === 'admin' ? 'Administrator' : 'Staff')} · 🔒 private chat`; el.classList.remove('live'); }
  }

  /* ---------- voice notes ---------- */
  async function recStart() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { say('Voice notes are not supported on this device/browser.'); return; }
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_) { say('Microphone blocked – allow microphone access for NEXUS and try again.'); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined), chunks = [];
    r.ondataavailable = e => e.data.size && chunks.push(e.data);
    st.rec = { r, stream, chunks, t0: Date.now(), send: false, timer: setInterval(recTick, 500) };
    r.onstop = () => { const rec = st.rec; st.rec = null; clearInterval(rec.timer); stream.getTracks().forEach(t => t.stop()); renderComposer();
      if (!rec.send) return; const type = r.mimeType || mime || 'audio/webm'; const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      const secs = Math.round((Date.now() - rec.t0) / 1000); if (secs < 1) return;
      sendFile(new File([new Blob(chunks, { type })], `voice-note-${secs}s.${ext}`, { type }), 'audio'); };
    r.start(); renderComposer();
  }
  function recTick() { if (!st.rec) return; const s = Math.floor((Date.now() - st.rec.t0) / 1000); const el = st.root?.querySelector('.nxc-rt'); if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; if (s >= 300) recStop(true); }
  function recStop(send) { if (!st.rec) return; st.rec.send = send; try { st.rec.r.stop(); } catch (_) {} }

  /* ---------- signed links for attachments ---------- */
  async function fillMedia() {
    const els = [...st.root.querySelectorAll('[data-sp]:not([data-ok])')]; if (!els.length) return;
    const need = [...new Set(els.map(e => e.dataset.sp).filter(p => !(st.urls[p] && st.urls[p].exp > Date.now())))];
    if (need.length) { const { data } = await sb.storage.from('chat').createSignedUrls(need, 3600); (data || []).forEach(d => { if (d.signedUrl) st.urls[d.path] = { u: d.signedUrl, exp: Date.now() + 3500e3 }; }); }
    els.forEach(e => { const u = st.urls[e.dataset.sp]?.u; if (u) { e.src = u; e.dataset.ok = '1'; } });
  }
  async function openFile(path, name) {
    const { data, error } = await sb.storage.from('chat').createSignedUrl(path, 600, { download: name || true });
    if (error) { say('Could not open the file.'); return; }
    const a = document.createElement('a'); a.href = data.signedUrl; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove();
  }

  /* ---------- UI ---------- */
  const IC = {
    back: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 4l1.4 1.4L7.8 11H20v2H7.8l5.6 5.6L12 20l-8-8z"/></svg>',
    clip: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M16.5 6.5v10.1a4.5 4.5 0 01-9 0V5.8a3 3 0 016 0v9.6a1.5 1.5 0 01-3 0V6.5H9v8.9a3 3 0 006 0V5.8a4.5 4.5 0 00-9 0v10.8a6 6 0 0012 0V6.5z" transform="rotate(40 12 12)"/></svg>',
    cam: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 9a4 4 0 100 8 4 4 0 000-8zm0 6.4a2.4 2.4 0 110-4.8 2.4 2.4 0 010 4.8zM20 5h-3.2l-1.5-2H8.7L7.2 5H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2zm0 14H4V7h4.1l1.5-2h4.8l1.5 2H20z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 15a3.5 3.5 0 003.5-3.5v-6a3.5 3.5 0 00-7 0v6A3.5 3.5 0 0012 15zm6.2-3.5h-1.7a4.5 4.5 0 01-9 0H5.8a6.2 6.2 0 005.4 6.1V21h1.6v-3.4a6.2 6.2 0 005.4-6.1z"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3.4 20.4l17.4-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4.9L2 9.1c0 .5.4.9.9 1l14.1 1.9-14.1 1.9c-.5.1-.9.5-.9 1l0 4.6a1 1 0 001.4.9z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    doc: '<svg viewBox="0 0 24 24" width="30" height="30"><path fill="currentColor" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zm4 18H6V4h7v5h5z"/></svg>',
    t1: '<svg viewBox="0 0 16 11" width="16" height="11"><path fill="currentColor" d="M11.1.7L4.7 7.1 2 4.4.9 5.5l3.8 3.8L12.2 1.8z"/></svg>',
    t2: '<svg viewBox="0 0 16 11" width="16" height="11"><path fill="currentColor" d="M11.1.7L4.7 7.1 2 4.4.9 5.5l3.8 3.8L12.2 1.8zM15 1.8l-1.1-1.1-6.4 6.4-.6-.6-1.1 1.1 1.7 1.7z"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 11.7A5.2 5.2 0 118 2.8a5.2 5.2 0 010 10.4zM8.6 4.5H7.4v4l3.4 2 .6-1-2.8-1.7z"/></svg>'
  };
  const hue = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const av = (name, big) => `<div class="nxc-av${big ? ' big' : ''}" style="background:hsl(${hue(name)},42%,52%)">${esc(initials(name))}</div>`;
  const mobile = () => window.matchMedia && window.matchMedia('(max-width:760px)').matches;

  const CSS = `
  .nxchat{--wa-head:#008069;--wa-bg:#efeae2;--wa-in:#fff;--wa-out:#d9fdd3;--wa-ink:#111b21;--wa-sub:#667781;--wa-tick:#53bdeb;--wa-green:#00a884;--wa-badge:#25d366;--wa-panel:#fff;--wa-panel2:#f0f2f5;--wa-line:#e9edef;--wa-hover:#f5f6f6;--wa-day:#fff;--wa-dot:rgba(0,0,0,.05)}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .nxchat{--wa-head:#202c33;--wa-bg:#0b141a;--wa-in:#202c33;--wa-out:#005c4b;--wa-ink:#e9edef;--wa-sub:#8696a0;--wa-panel:#111b21;--wa-panel2:#202c33;--wa-line:#222d34;--wa-hover:#202c33;--wa-day:#182229;--wa-dot:rgba(255,255,255,.03)}}
  :root[data-theme="dark"] .nxchat{--wa-head:#202c33;--wa-bg:#0b141a;--wa-in:#202c33;--wa-out:#005c4b;--wa-ink:#e9edef;--wa-sub:#8696a0;--wa-panel:#111b21;--wa-panel2:#202c33;--wa-line:#222d34;--wa-hover:#202c33;--wa-day:#182229;--wa-dot:rgba(255,255,255,.03)}
  .nxchat{display:grid;grid-template-columns:340px 1fr;height:calc(100vh - 150px);min-height:440px;border-radius:10px;overflow:hidden;background:var(--wa-panel);color:var(--wa-ink);box-shadow:0 1px 3px rgba(0,0,0,.12);font-family:var(--f-body)}
  .nxchat button{font-family:inherit}
  .nxc-l{border-right:1px solid var(--wa-line);display:flex;flex-direction:column;min-height:0;background:var(--wa-panel)}
  .nxc-lh{background:var(--wa-head);color:#fff;height:58px;display:flex;align-items:center;padding:0 16px;font-size:19px;font-weight:600;flex:none}
  .nxc-sb{padding:8px 12px;flex:none;border-bottom:1px solid var(--wa-line)} .nxc-sb label{display:flex;align-items:center;gap:10px;background:var(--wa-panel2);border-radius:9px;padding:0 12px;height:36px;color:var(--wa-sub)}
  .nxc-sb input{flex:1;border:0;background:transparent;outline:0;color:var(--wa-ink);font-size:14.5px;min-width:0}
  .nxc-items{overflow:auto;flex:1}
  .nxc-it{display:flex;gap:12px;align-items:center;padding:0 14px;height:72px;cursor:pointer} .nxc-it:hover,.nxc-it.on{background:var(--wa-hover)}
  .nxc-it .g{flex:1;min-width:0;border-bottom:1px solid var(--wa-line);height:100%;display:flex;flex-direction:column;justify-content:center;gap:3px}
  .nxc-it .r1,.nxc-it .r2{display:flex;align-items:center;gap:8px} .nxc-it .n{flex:1;font-size:16px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nxc-it .t{font-size:12px;color:var(--wa-sub)} .nxc-it .t.u{color:var(--wa-badge);font-weight:600}
  .nxc-it .p{flex:1;font-size:14px;color:var(--wa-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nxc-u{background:var(--wa-badge);color:#fff;border-radius:11px;min-width:20px;height:20px;padding:0 6px;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}
  .nxc-av{width:48px;height:48px;border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;flex:none;font-size:17px}
  .nxc-av.sm{width:40px;height:40px;font-size:15px}
  .nxc-sec{padding:14px 16px 6px;font-size:13px;color:var(--wa-green);font-weight:600}
  .nxc-c{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--wa-bg);background-image:radial-gradient(var(--wa-dot) 1.2px,transparent 1.3px);background-size:22px 22px}
  .nxc-ch{background:var(--wa-head);color:#fff;height:58px;padding:0 10px 0 8px;display:flex;align-items:center;gap:10px;flex:none}
  .nxc-who{min-width:0;display:flex;flex-direction:column;flex:1} .nxc-nm{display:block;font-size:16px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .nxc-st{display:block;font-size:12.5px;line-height:1.25;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nxc-back{display:none;background:none;border:0;color:#fff;width:40px;height:40px;border-radius:50%;align-items:center;justify-content:center;cursor:pointer;flex:none}
  .nxc-m{flex:1;overflow:auto;padding:10px 6% 8px;display:flex;flex-direction:column;gap:2px}
  .nxc-day{align-self:center;font-size:12.5px;color:var(--wa-sub);background:var(--wa-day);border-radius:8px;padding:5px 12px;margin:10px 0 6px;box-shadow:0 1px .5px rgba(0,0,0,.13)}
  .nxc-b{max-width:min(65%,560px);padding:6px 8px 7px 9px;border-radius:8px;background:var(--wa-in);color:var(--wa-ink);align-self:flex-start;overflow-wrap:anywhere;position:relative;box-shadow:0 1px .5px rgba(0,0,0,.13);font-size:14.5px;line-height:1.38}
  .nxc-b.me{align-self:flex-end;background:var(--wa-out)}
  .nxc-b.tail{margin-top:6px} .nxc-b.tail:not(.me){border-top-left-radius:0} .nxc-b.tail.me{border-top-right-radius:0}
  .nxc-b.tail:not(.me)::before{content:"";position:absolute;top:0;left:-8px;border-right:8px solid var(--wa-in);border-bottom:10px solid transparent}
  .nxc-b.tail.me::before{content:"";position:absolute;top:0;right:-8px;border-left:8px solid var(--wa-out);border-bottom:10px solid transparent}
  .nxc-b .meta{float:right;margin:8px 0 -6px 12px;font-size:11px;color:var(--wa-sub);display:inline-flex;align-items:center;gap:3px;white-space:nowrap;position:relative;top:2px}
  .nxc-b .rd{color:var(--wa-tick)} .nxc-b .del{font-style:italic;color:var(--wa-sub)}
  .nxc-b a{color:#027eb5}
  .nxc-b.media{padding:3px 3px 6px} .nxc-b.media .meta{margin-right:6px}
  .nxc-b img,.nxc-b video{max-width:min(330px,100%);max-height:340px;border-radius:6px;display:block;background:rgba(0,0,0,.06);min-width:140px;min-height:100px;cursor:pointer;object-fit:cover}
  .nxc-b audio{width:260px;max-width:100%;height:40px;display:block}
  .nxc-vn{display:flex;align-items:center;gap:8px;color:var(--wa-green)}
  .nxc-f{display:flex;gap:10px;align-items:center;cursor:pointer;background:rgba(0,0,0,.05);border-radius:6px;padding:8px 10px;min-width:200px} .nxc-f .ic{color:#e0544b;flex:none;display:flex} .nxc-f .fn{font-size:14px;overflow:hidden;text-overflow:ellipsis} .nxc-f .fs{font-size:12px;color:var(--wa-sub)}
  .nxc-x{position:absolute;top:3px;right:4px;border:0;background:var(--wa-out);color:var(--wa-sub);cursor:pointer;display:none;width:26px;height:26px;border-radius:50%;align-items:center;justify-content:center;z-index:1}
  .nxc-b.me:hover .nxc-x{display:inline-flex} @media (hover:none){.nxc-b.me .nxc-x{display:inline-flex;opacity:.55;width:22px;height:22px}}
  .nxc-k{display:flex;align-items:flex-end;gap:6px;padding:6px 8px 8px;flex:none}
  .nxc-pill{flex:1;display:flex;align-items:flex-end;background:var(--wa-panel);border-radius:24px;min-height:48px;padding:0 4px;box-sizing:border-box;box-shadow:0 1px .5px rgba(0,0,0,.13);min-width:0}
  .nxc-pill textarea{flex:1;border:0;outline:0;background:transparent;resize:none;color:var(--wa-ink);font:15.5px/1.35 var(--f-body);padding:13px 4px;max-height:130px;min-width:0;box-sizing:border-box}
  .nxc-ib{background:none;border:0;width:42px;height:48px;color:var(--wa-sub);display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none;padding:0}
  .nxc-round{width:48px;height:48px;border-radius:50%;background:var(--wa-green);color:#fff;border:0;display:flex;align-items:center;justify-content:center;flex:none;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.2);padding:0}
  .nxc-rec{flex:1;display:flex;align-items:center;gap:10px;padding:0 8px;font-size:15px;color:var(--wa-ink)} .nxc-rec .rt{font-variant-numeric:tabular-nums}
  .nxc-dot{width:10px;height:10px;border-radius:50%;background:#ea0038;animation:nxcp 1s infinite} @keyframes nxcp{50%{opacity:.2}}
  .nxc-empty{margin:auto;text-align:center;color:var(--wa-sub);padding:24px;max-width:380px;font-size:14px;line-height:1.5}
  .nxc-empty b{color:var(--wa-ink);font-size:18px;font-weight:500}
  .nxc-older{align-self:center;background:var(--wa-day);border:0;border-radius:8px;padding:6px 14px;color:var(--wa-sub);cursor:pointer;box-shadow:0 1px .5px rgba(0,0,0,.13);margin-bottom:6px}
  .nxc-k{flex-direction:column;align-items:stretch;gap:0} .nxc-row{display:flex;align-items:flex-end;gap:6px}
  .nxc-ctx{display:flex;align-items:center;gap:6px;background:var(--wa-panel);border-radius:12px 12px 0 0;margin:0 54px -4px 0;padding:6px 6px 10px 8px}
  .nxc-ctx .q,.nxc-q{flex:1;min-width:0;border-left:4px solid var(--wa-green);background:rgba(0,0,0,.05);border-radius:6px;padding:5px 8px;display:flex;flex-direction:column;font-size:13px;line-height:1.3}
  .nxc-ctx .q b,.nxc-q b{color:var(--wa-green);font-weight:600;font-size:12.5px} .nxc-ctx .q span,.nxc-q span{color:var(--wa-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nxc-q{margin:0 0 5px;cursor:pointer} .nxc-b.me .nxc-q{background:rgba(0,0,0,.06)}
  .nxc-fw{font-size:12.5px;font-style:italic;color:var(--wa-sub);margin:0 0 2px}
  .nxc-b .meta i{font-style:italic;margin-right:2px}
  .nxc-mn{position:absolute;top:2px;right:2px;width:24px;height:22px;border:0;border-radius:0 8px 0 12px;background:inherit;color:var(--wa-sub);display:none;align-items:center;justify-content:center;cursor:pointer;z-index:2;padding:0}
  .nxc-b:hover .nxc-mn{display:flex} @media (hover:none){.nxc-mn{display:none!important}}
  .nxc-b.hasrx{margin-bottom:16px}
  .nxc-rx{position:absolute;bottom:-15px;left:8px;background:var(--wa-panel);border-radius:12px;padding:1px 6px;font-size:14px;box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:pointer;white-space:nowrap;color:var(--wa-sub)} .nxc-b.me .nxc-rx{left:auto;right:8px}
  .nxc-b.flash{animation:nxcfl 1.4s} @keyframes nxcfl{0%,60%{box-shadow:0 0 0 3px var(--wa-green)}}
  .nxc-back-drop{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center}
  .nxc-menu{background:var(--wa-panel);color:var(--wa-ink);border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25);min-width:220px;max-width:340px;padding:6px 0;overflow:hidden}
  .nxc-mi{display:flex;align-items:center;gap:14px;width:100%;border:0;background:none;padding:11px 18px;font-size:15px;color:inherit;cursor:pointer;text-align:left}
  .nxc-mi:hover{background:var(--wa-hover)} .nxc-mi span{width:22px;text-align:center} .nxc-mi.bad{color:#ea0038}
  .nxc-mh{padding:10px 18px 6px;font-size:14px;font-weight:600;color:var(--wa-sub)} .nxc-sub{font-weight:400;font-size:12px}
  .nxc-emo{display:flex;justify-content:space-around;padding:4px 8px 8px;border-bottom:1px solid var(--wa-line);margin-bottom:4px}
  .nxc-emo button{font-size:24px;border:0;background:none;cursor:pointer;border-radius:50%;width:40px;height:40px;transition:transform .1s} .nxc-emo button:hover{transform:scale(1.2)} .nxc-emo button.on{background:var(--wa-panel2)}
  .nxc-fl{max-height:50vh;overflow:auto} .nxc-fp{display:flex;align-items:center;gap:12px;padding:8px 16px;cursor:pointer;font-size:15px} .nxc-fp:hover{background:var(--wa-hover)} .nxc-fp small{color:var(--wa-sub)} .nxc-fp input{width:18px;height:18px;accent-color:var(--wa-green)}
  .nxc-st.live{opacity:1;font-weight:500}
  @media (max-width:760px){.nxc-back-drop{background:rgba(0,0,0,.35);display:flex;align-items:flex-end} .nxc-menu{width:100%;max-width:none;border-radius:16px 16px 0 0;padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))} .nxc-mi{padding:14px 22px;font-size:16px}}
  @media (max-width:760px){
    .nxchat{grid-template-columns:1fr;height:calc(100vh - 190px);height:calc(100dvh - 190px);border-radius:8px}
    .nxchat.conv{position:fixed;inset:0;z-index:200;height:auto;border-radius:0;box-shadow:none}
    .nxchat.conv .nxc-l{display:none} .nxchat:not(.conv) .nxc-c{display:none}
    .nxc-back{display:inline-flex} .nxc-b{max-width:84%} .nxc-m{padding:8px 12px}
    .nxc-lh{height:52px;font-size:18px}
  }`;

  function build() {
    if (st.root) return;
    const s = document.createElement('style'); s.textContent = CSS; document.head.append(s);
    st.root = document.createElement('div'); st.root.className = 'nxchat';
    st.root.innerHTML = `<div class="nxc-l"><div class="nxc-lh">Chats</div><div class="nxc-sb"><label>${IC.search}<input id="nxcSearch" placeholder="Search or start a new chat" autocomplete="off"></label></div><div class="nxc-items"></div></div>
      <div class="nxc-c"><div class="nxc-ch"></div><div class="nxc-m"></div><div class="nxc-k"></div></div>
      <input type="file" id="nxcFile" hidden multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.dwg,.dxf">
      <input type="file" id="nxcCam" hidden accept="image/*" capture="environment">`;
    st.root.querySelector('#nxcSearch').addEventListener('input', e => { st.q = e.target.value.toLowerCase(); renderList(); });
    for (const id of ['#nxcFile', '#nxcCam']) st.root.querySelector(id).addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; for (const f of fs) await sendFile(f); });
    st.root.addEventListener('click', onClick);
    st.root.addEventListener('keydown', e => { if (e.target.id === 'nxcText' && e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); doSend(); } });
    st.root.addEventListener('input', e => { if (e.target.id === 'nxcText') { e.target.style.height = 'auto'; e.target.style.height = Math.min(130, e.target.scrollHeight) + 'px'; roundBtn(); sendTyping(); } });
    let lp; st.root.addEventListener('touchstart', e => { const b = e.target.closest('.nxc-b[data-id]'); if (!b || e.target.closest('audio,video,a,button')) return; lp = setTimeout(() => { openMenu(b.dataset.id, b); if (navigator.vibrate) navigator.vibrate(20); }, 480); }, { passive: true });
    for (const ev of ['touchend', 'touchmove', 'touchcancel']) st.root.addEventListener(ev, () => clearTimeout(lp), { passive: true });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    st.root.querySelector('.nxc-m').addEventListener('scroll', e => { const m = e.target; st.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80; });
    window.addEventListener('popstate', () => { if (st.pushed) { st.pushed = false; closeConv(); } });
  }
  function roundBtn() {
    const t = st.root.querySelector('#nxcText'), b = st.root.querySelector('.nxc-round'); if (!t || !b) return;
    const has = !!t.value.trim(); if ((b.dataset.c === 'send') === has) return;
    b.dataset.c = has ? 'send' : 'mic'; b.title = has ? 'Send' : 'Record a voice note'; b.innerHTML = has ? IC.send : IC.mic;
  }
  function doSend() { const t = st.root.querySelector('#nxcText'); if (!t || !t.value.trim()) return; const v = t.value; t.value = ''; t.style.height = 'auto'; roundBtn(); if (st.edit) saveEdit(st.edit, v); else sendText(v); if (!('ontouchstart' in window)) t.focus(); }
  function closeConv() { st.cur = null; st.root.classList.remove('conv'); document.body.classList.remove('nx-chatconv'); renderList(); renderConv(); }
  async function onClick(e) {
    const b = e.target.closest('[data-c]'); if (!b) { const im = e.target.closest('img[data-sp]'); if (im && im.src && window.lightbox) window.lightbox(im.src); return; }
    const [a, v] = [b.dataset.c, b.dataset.v];
    if (a === 'open') openThread(v);
    else if (a === 'person') { try { const { data, error } = await sb.rpc('chat_open', { other: v }); if (error) throw error; await loadThreads(); openThread(data); } catch (er) { say('Could not start the chat: ' + (er.message || er)); } }
    else if (a === 'back') { if (st.pushed) history.back(); else closeConv(); }
    else if (a === 'send') doSend();
    else if (a === 'attach') st.root.querySelector('#nxcFile').click();
    else if (a === 'cam') st.root.querySelector('#nxcCam').click();
    else if (a === 'mic') recStart();
    else if (a === 'recsend') recStop(true);
    else if (a === 'reccancel') recStop(false);
    else if (a === 'older') { await loadMsgs(st.cur, true).catch(() => {}); renderMsgs(false); }
    else if (a === 'file') openFile(v, b.dataset.n);
    else if (a === 'menu') openMenu(v, b);
    else if (a === 'react') react(v, b.dataset.e);
    else if (a === 'reply' || a === 'edit') startCtx(a, v);
    else if (a === 'copy') { const m = findMsg(v); closeMenu(); try { await navigator.clipboard.writeText(m.body || ''); say('Message copied.'); } catch (_) { say('Copy is not allowed in this browser.'); } }
    else if (a === 'forward') forwardPick(v);
    else if (a === 'fwdsend') forwardSend();
    else if (a === 'delask') askDelete(v);
    else if (a === 'delall') delAll(v);
    else if (a === 'delme') delMe(v);
    else if (a === 'menuclose') closeMenu();
    else if (a === 'ctxclose') { st.reply = st.edit = null; const t = st.root.querySelector('#nxcText'); const keep = t ? t.value : ''; renderComposer(); }
    else if (a === 'jump') jump(v);
  }
  async function openThread(tid) {
    const was = st.cur; st.cur = tid; st.root.classList.add('conv'); document.body.classList.add('nx-chatconv'); st.stick = true; st.reply = st.edit = null; typingChannel(tid);
    if (mobile() && !was && !st.pushed) { history.pushState(Object.assign({}, history.state, { nxchat: 1 }), ''); st.pushed = true; }
    renderList(); renderConv();
    if (!st.msgs[tid]) { renderMsgs(true); await loadMsgs(tid).catch(er => say('Could not load messages: ' + er.message)); }
    renderMsgs(true); if (visible()) markRead(tid).catch(() => {});
    const t = st.root.querySelector('#nxcText'); if (t && !('ontouchstart' in window)) t.focus();
  }
  function renderList() {
    if (!st.root) return; const box = st.root.querySelector('.nxc-items'), q = st.q;
    const withThread = new Set(st.threads.map(other));
    const th = st.threads.filter(t => !q || pName(other(t)).toLowerCase().includes(q));
    const ppl = [...st.people.values()].filter(p => !withThread.has(p.user_id) && (!q || (p.name || '').toLowerCase().includes(q) || (p.job || '').toLowerCase().includes(q)));
    box.innerHTML = th.map(t => { const o = other(t), u = st.unread[t.id] || 0, mine = t.last_from === st.me;
      return `<div class="nxc-it ${st.cur === t.id ? 'on' : ''}" data-c="open" data-v="${t.id}">${av(pName(o))}<div class="g"><div class="r1"><span class="n">${esc(pName(o))}</span><span class="t ${u ? 'u' : ''}">${listTime(t.last_text ? t.last_at : '')}</span></div><div class="r2"><span class="p">${mine && t.last_text ? listTick(t) : ''}${esc(t.last_text || 'Tap to start chatting')}</span>${u ? `<span class="nxc-u">${u}</span>` : ''}</div></div></div>`; }).join('')
      + (ppl.length ? `<div class="nxc-sec">Start a new chat</div>` + ppl.map(p => `<div class="nxc-it" data-c="person" data-v="${p.user_id}">${av(p.name)}<div class="g"><div class="r1"><span class="n">${esc(p.name)}</span></div><div class="r2"><span class="p">${esc(p.job || (p.role === 'admin' ? 'Administrator' : 'Staff'))}</span></div></div></div>`).join('') : '')
      || `<div class="nxc-empty">${q ? 'Nobody matches your search.' : 'No other NEXUS users yet. Colleagues appear here once they sign up and an administrator approves them.'}</div>`;
  }
  function renderConv() {
    if (!st.root) return; const h = st.root.querySelector('.nxc-ch');
    const t = st.threads.find(x => x.id === st.cur);
    if (!t) { h.innerHTML = ''; h.style.visibility = 'hidden'; st.root.querySelector('.nxc-m').innerHTML = `<div class="nxc-empty"><div style="font-size:54px;line-height:1">💬</div><b>NEXUS Chat</b><br>Choose a colleague to start chatting.<br>Only the two of you can read your messages – not even administrators. Send text, photos, documents, voice notes and videos (up to 25 MB).</div>`; st.root.querySelector('.nxc-k').innerHTML = ''; return; }
    h.style.visibility = ''; const p = st.people.get(other(t)) || {};
    h.innerHTML = `<button class="nxc-back" data-c="back" aria-label="Back to chats">${IC.back}</button>${av(pName(other(t))).replace('nxc-av', 'nxc-av sm')}<div class="nxc-who"><div class="nxc-nm">${esc(pName(other(t)))}</div><div class="nxc-st">${esc(p.job || (p.role === 'admin' ? 'Administrator' : 'Staff'))} · 🔒 private chat</div></div>`;
    renderComposer(); headStatus();
  }
  function renderComposer() {
    const k = st.root?.querySelector('.nxc-k'); if (!k || !st.cur) return;
    if (st.rec) { k.innerHTML = `<div class="nxc-row"><div class="nxc-pill"><button class="nxc-ib" data-c="reccancel" title="Cancel recording" style="color:#ea0038">${IC.trash}</button><div class="nxc-rec"><span class="nxc-dot"></span><span class="rt nxc-rt">0:00</span><span style="color:var(--wa-sub)">Recording…</span></div></div><button class="nxc-round" data-c="recsend" title="Send voice note">${IC.send}</button></div>`; return; }
    const keep = k.querySelector('#nxcText')?.value || '';
    k.innerHTML = `${ctxBar()}<div class="nxc-row"><div class="nxc-pill"><button class="nxc-ib" data-c="attach" title="Photo, video or document">${IC.clip}</button><textarea id="nxcText" rows="1" placeholder="Message"></textarea><button class="nxc-ib" data-c="cam" title="Take a photo">${IC.cam}</button></div><button class="nxc-round" data-c="mic" title="Record a voice note">${IC.mic}</button></div>`;
    k.querySelector('#nxcText').value = keep; roundBtn();
  }
  function body(m) {
    if (m.deleted) return '<span class="del">🚫 This message was deleted</span>';
    if (m.uploading) return `<span class="del">⏳ Sending ${esc(m.file_name || '')} (${size(m.file_size || 0)})…</span>`;
    const sp = esc(m.file_path || '');
    switch (m.kind) {
      case 'image': return `<img data-sp="${sp}" alt="Photo" loading="lazy">`;
      case 'video': return `<video data-sp="${sp}" controls preload="metadata" playsinline></video>`;
      case 'audio': return `<div class="nxc-vn">${IC.mic}<audio data-sp="${sp}" controls preload="metadata"></audio></div>`;
      case 'file': return `<div class="nxc-f" data-c="file" data-v="${sp}" data-n="${esc(m.file_name || 'document')}"><span class="ic">${IC.doc}</span><div style="min-width:0"><div class="fn">${esc(m.file_name || 'Document')}</div><div class="fs">${size(m.file_size || 0)} · tap to open</div></div></div>`;
      default: return linkify(m.body || '');
    }
  }
  function renderMsgs(toBottom) {
    if (!st.root || !st.cur) return; const box = st.root.querySelector('.nxc-m'), list = st.msgs[st.cur];
    if (!list) { box.innerHTML = '<div class="nxc-empty">Loading…</div>'; return; }
    const prevH = box.scrollHeight, prevT = box.scrollTop; let day = '', prev = null, html = st.more[st.cur] ? `<button class="nxc-older" data-c="older">Load earlier messages</button>` : '';
    for (const m of list.filter(vis)) { const d = dayLabel(m.created_at); let tail = !prev || prev.sender !== m.sender; if (d !== day) { day = d; tail = true; html += `<div class="nxc-day">${d}</div>`; }
      const mine = m.sender === st.me, media = !m.deleted && !m.uploading && (m.kind === 'image' || m.kind === 'video');
      const tick = mine ? (m.failed ? ' <span style="color:#ea0038">not sent</span>' : m.tmp ? ' ' + IC.clock : m.read_at ? ` <span class="rd" title="Read">${IC.t2}</span>` : m.delivered_at ? ` <span title="Delivered">${IC.t2}</span>` : ` <span title="Sent">${IC.t1}</span>`) : '';
      const q = m.reply_to ? (list.find(x => x.id === m.reply_to) || null) : null;
      const rx = Object.values(m.reactions || {}); const rxs = [...new Set(rx)];
      html += `<div class="nxc-b ${mine ? 'me' : ''} ${tail ? 'tail' : ''} ${media ? 'media' : ''} ${rx.length ? 'hasrx' : ''}" data-id="${m.id}">${!m.tmp ? `<button class="nxc-mn" data-c="menu" data-v="${m.id}" title="Message options"><svg viewBox="0 0 18 18" width="18" height="18"><path fill="currentColor" d="M3.3 4.6L9 10.3l5.7-5.7 1.6 1.6L9 13.4 1.7 6.2z"/></svg></button>` : ''}${m.fwd && !m.deleted ? '<div class="nxc-fw">↪ Forwarded</div>' : ''}${m.reply_to && !m.deleted ? `<div class="nxc-q" data-c="jump" data-v="${m.reply_to}"><b>${esc(q ? (q.sender === st.me ? 'You' : pName(q.sender)) : 'Reply')}</b><span>${esc(snippet(q))}</span></div>` : ''}${body(m)}<span class="meta">${m.edited_at && !m.deleted ? '<i>Edited</i> ' : ''}${hhmm(m.created_at)}${tick}</span>${rx.length ? `<div class="nxc-rx" data-c="menu" data-v="${m.id}">${rxs.join('')}${rx.length > 1 ? ' ' + rx.length : ''}</div>` : ''}</div>`; prev = m; }
    box.innerHTML = html || '<div class="nxc-empty">No messages yet – say hello 👋</div>';
    if (toBottom || st.stick !== false) box.scrollTop = box.scrollHeight; else box.scrollTop = prevT + (box.scrollHeight - prevH);
    fillMedia().catch(() => {});
  }

  /* ---------- page hooks (called by the NEXUS app) ---------- */
  // open one conversation (used when a chat notification is tapped); false until chat has loaded
  window.NX_CHAT_OPEN = tid => { if (!st.ready || !st.root || !st.root.isConnected || !(st.threads || []).some(t => t.id === tid)) return false; openThread(tid); return true; };
  window.NX_CHAT_MOUNT = host => {
    if (!host) return; build();
    if (!st.ready) { host.innerHTML = `<div class="card empty">${st.err ? 'Chat could not start: ' + esc(st.err) : '<span class="spin"></span> Loading chat…'}</div>`; return; }
    if (st.root.parentNode !== host) host.append(st.root);
    if (!st.rendered) { st.rendered = true; renderList(); renderConv(); if (st.cur) renderMsgs(true); }
    if (st.cur && visible()) markRead(st.cur).catch(() => {});
  };
  window.NX_CHAT_OPEN = async tid => { if (st.ready) openThread(tid); };

  async function init(tries = 0) {
    try {
      const { data } = await sb.auth.getSession(); const s = data && data.session;
      if (!s) { setTimeout(() => init(tries), 4000); return; }
      st.me = s.user.id; await loadPeople(); await loadThreads(); await loadUnread(); subscribe();
      st.ready = true; st.err = ''; setInterval(poll, 4000); presence(); build(); renderList(); renderConv(); st.rendered = true;
      if ((window.NX_ROUTE && window.NX_ROUTE()) === 'chat') { const h = document.getElementById('chatHost'); if (h) window.NX_CHAT_MOUNT(h); }
    } catch (e) { st.err = e.message || String(e); if (tries < 20) setTimeout(() => init(tries + 1), 6000); }
  }
  setTimeout(init, 1500);
})();
