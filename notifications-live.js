// notifications-live.js  (save in the SAME folder as app.html)
// Real notifications and chat from Supabase. Only runs when backend.js is in live mode.
(function () {
  'use strict';
  var B = window.EMEMART_BACKEND;
  if (!B || B.mode !== 'live' || !window.sb) return;
  var sb = window.sb;
  function me() { return typeof state !== 'undefined' && state.session ? state.session : null; }
  function E(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(i, t, m) { try { showPopupNotif(i, t, m); } catch (e) {} }

  // a pop-up that does NOT add a second entry to the notification list
  function popup(icon, title, body) {
    try {
      E('popup-icon').textContent = icon; E('popup-title').textContent = title; E('popup-body').textContent = body;
      var p = E('popup-notif'); p.classList.remove('hidden'); setTimeout(function () { p.classList.add('hidden'); }, 5000);
    } catch (e) {}
    try { if (document.hidden && window._swReg && Notification.permission === 'granted') window._swReg.showNotification(title, { body: body, icon: '/icon-192.png' }); } catch (e) {}
  }

  var ICON = { new_order: '🛒', order_delivered: '🏍️', escrow_released: '💰', order_cancelled: '❌', dispute_opened: '⚖️', dispute_resolved: '⚖️',
               post_deletion_warning: '🗑️', freshness_reminder: '🍲', verification: '🪪', funding: '💳', booking: '📅' };

  // ---- notifications -------------------------------------------------------------------------
  var seen = {}, firstLoad = true;
  async function loadNotifs() {
    var u = me(); if (!u) return;
    var r = await sb.from('notifications').select('*').eq('user_id', u.id).order('created_at', { ascending: false }).limit(60);
    if (r.error) return;
    var fresh = [];
    state.notifications = (r.data || []).map(function (n) {
      if (!seen[n.id]) { seen[n.id] = 1; if (!firstLoad && !n.read_at) fresh.push(n); }
      return { id: n.id, icon: ICON[n.kind] || '🔔', title: esc(n.title), body: esc(n.body || ''), ts: new Date(n.created_at).getTime(), read: !!n.read_at };
    });
    firstLoad = false;
    try { renderNotifList(); } catch (e) {}
    fresh.slice(0, 2).forEach(function (n) { popup(ICON[n.kind] || '🔔', n.title, n.body || ''); });
  }
  B.reloadNotifications = loadNotifs;

  // marking as read: opening the bell marks everything read on the server too
  var _toggle = window.toggleNotifCenter;
  window.toggleNotifCenter = function () {
    _toggle.apply(this, arguments);
    var u = me(); if (!u) return;
    sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', u.id).is('read_at', null).then(function () {});
  };
  window.clearNotifs = function () {
    var u = me(); state.notifications = []; renderNotifList();
    if (u) sb.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', u.id).is('read_at', null).then(function () {});
  };

  // ---- chat ----------------------------------------------------------------------------------
  function pairId(a, b) { return a < b ? a + '-' + b : b + '-' + a; }
  function partnerOf(pid, myId) { return pid.slice(0, 36) === myId ? pid.slice(37) : pid.slice(0, 36); }
  var people = {};   // id -> {id, name, role}

  async function loadPeople(ids) {
    var need = ids.filter(function (i) { return !people[i]; });
    if (!need.length) return;
    var r = await sb.from('public_profiles').select('id,full_name,role').in('id', need);
    (r.data || []).forEach(function (p) { people[p.id] = { id: p.id, name: esc(p.full_name || 'User'), role: p.role }; });
  }

  async function loadChats() {
    var u = me(); if (!u) return;
    var r = await sb.from('messages').select('*').or('sender_id.eq.' + u.id + ',recipient_id.eq.' + u.id).order('created_at', { ascending: true }).limit(500);
    if (r.error) return;
    var chats = {}, others = {};
    (r.data || []).forEach(function (m) {
      var other = m.sender_id === u.id ? m.recipient_id : m.sender_id;
      others[other] = 1;
      var pid = pairId(u.id, other);
      (chats[pid] = chats[pid] || []).push({ sender: m.sender_id, text: esc(m.body), ts: new Date(m.created_at).getTime() });
    });
    await loadPeople(Object.keys(others));
    var open = state.activeChatPartnerId;
    // keep an open, still-empty conversation
    if (open && !chats[open]) chats[open] = [];
    state.chats = chats;
    state.users = Object.keys(people).map(function (k) { return people[k]; });
    try { if (open) renderChatMessages(); else renderInbox(); } catch (e) {}
  }
  B.reloadChats = loadChats;

  window.renderInbox = function () {
    var box = E('inbox-list'); var u = me(); if (!box || !u) return;
    var pids = Object.keys(state.chats).filter(function (p) { return state.chats[p].length; });
    if (!pids.length) { box.innerHTML = '<div class="text-center py-12 text-xs text-gray-500 italic">No messages yet. Tap the + button to start a chat.</div>'; return; }
    box.innerHTML = '';
    pids.sort(function (a, b) { var x = state.chats[a], y = state.chats[b]; return y[y.length - 1].ts - x[x.length - 1].ts; });
    pids.forEach(function (pid) {
      var thread = state.chats[pid], last = thread[thread.length - 1];
      var partner = people[partnerOf(pid, u.id)] || { name: 'User', role: 'user' };
      var item = document.createElement('div');
      item.className = 'inbox-item flex gap-3 items-center';
      item.innerHTML = '<div class="w-8 h-8 rounded-xl bg-gray-800 text-gray-400 font-bold flex items-center justify-center shrink-0">' + (partner.name[0] || '?') +
        '</div><div class="flex-1 min-w-0"><div class="flex justify-between items-center"><span class="text-xs font-black text-white truncate">' + partner.name +
        '</span><span class="text-[9px] text-gray-600 mono">' + getTimeAgo(last.ts) + '</span></div><div class="text-[10px] text-gray-400 truncate mt-0.5">' + last.text + '</div></div>';
      item.onclick = function () { openChatWith(pid, partner.name, partner.role); };
      box.appendChild(item);
    });
  };

  // new chat: search people by name
  window.openNewChatModal = async function () {
    var u = me(); if (!u) { toast('🔐', 'Sign in', 'Please sign in first.'); return; }
    E('new-chat-modal').classList.remove('hidden');
    var w = E('users-list-for-chat'); w.innerHTML = '<div class="p-3 text-xs text-gray-500">Loading...</div>';
    var r = await sb.from('public_profiles').select('id,full_name,role').neq('id', u.id).order('created_at', { ascending: false }).limit(60);
    w.innerHTML = '';
    (r.data || []).forEach(function (p) {
      people[p.id] = { id: p.id, name: esc(p.full_name || 'User'), role: p.role };
      var row = document.createElement('div');
      row.className = 'p-2.5 hover:bg-gray-800 border-b border-gray-800 rounded-xl text-xs font-bold cursor-pointer transition flex justify-between';
      row.innerHTML = '<span class="text-white">' + people[p.id].name + '</span><span class="text-emerald-500 font-mono text-[9px] uppercase">' + esc(p.role) + '</span>';
      row.onclick = function () {
        E('new-chat-modal').classList.add('hidden');
        var pid = pairId(u.id, p.id); if (!state.chats[pid]) state.chats[pid] = [];
        openChatWith(pid, people[p.id].name, p.role);
      };
      w.appendChild(row);
    });
    if (!(r.data || []).length) w.innerHTML = '<div class="p-3 text-xs text-gray-500">No one to message yet.</div>';
  };

  window.msgVendor = async function (vendorId, vendorName) {
    var u = me(); if (!u) return;
    if (u.id === vendorId) { toast('⚠️', 'Not allowed', 'You cannot message yourself.'); return; }
    await loadPeople([vendorId]);
    var pid = pairId(u.id, vendorId); if (!state.chats[pid]) state.chats[pid] = [];
    navTo('chat'); openChatWith(pid, vendorName, 'vendor');
  };

  window.sendChatMessage = async function () {
    var u = me(), inp = E('chat-msg-inp'); if (!u || !inp) return;
    var txt = inp.value.trim(), pid = state.activeChatPartnerId;
    if (!txt || !pid) return;
    var to = partnerOf(pid, u.id);
    inp.value = '';
    state.chats[pid] = state.chats[pid] || [];
    state.chats[pid].push({ sender: u.id, text: esc(txt), ts: Date.now() });
    renderChatMessages();
    var r = await sb.from('messages').insert({ sender_id: u.id, recipient_id: to, body: txt.slice(0, 2000) });
    if (r.error) { state.chats[pid].pop(); renderChatMessages(); inp.value = txt; toast('❌', 'Not sent', r.error.message); }
  };

  // ---- live updates + start ------------------------------------------------------------------
  function subscribe() {
    var u = me(); if (!u || B._rt) return;
    try {
      B._rt = sb.channel('ememart-' + u.id)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + u.id }, function () { loadNotifs(); })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'recipient_id=eq.' + u.id }, function (p) {
          loadChats();
          var m = p.new || {}; var who = people[m.sender_id];
          popup('💬', 'New message' + (who ? ' from ' + who.name : ''), 'Open Messages to reply.');
        })
        .subscribe();
    } catch (e) { console.warn('realtime not available, using refresh instead', e); }
  }
  function start() { if (!me()) return; loadNotifs(); loadChats(); subscribe(); }
  window.addEventListener('load', function () { setTimeout(start, 1000); });
  setInterval(function () { if (!document.hidden && me()) { loadNotifs(); loadChats(); } }, 20000);

  // ---- broadcasts: the scrolling notice at the top of the app -------------------------------
  async function loadBroadcasts() {
    try {
      var r = await sb.from('broadcasts').select('id,message,audience').order('created_at', { ascending: false }).limit(5);
      if (!r.error && typeof setBroadcasts === 'function') setBroadcasts(r.data || []);
    } catch (e) {}
  }
  window.addEventListener('load', function () { setTimeout(loadBroadcasts, 800); });
  setInterval(function () { if (!document.hidden) loadBroadcasts(); }, 300000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadBroadcasts(); });
})();
