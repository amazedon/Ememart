// partners-live.js  (save in the SAME folder as app.html)
// Connects ratings, the rider portal, my disputes and push notifications to the Supabase API.
// Only runs when backend.js is in live mode.
(function () {
  'use strict';
  var B = window.EMEMART_BACKEND;
  if (!B || B.mode !== 'live' || !window.callApi) return;
  var api = window.callApi;
  function me() { return typeof state !== 'undefined' && state.session ? state.session : null; }
  function toast(i, t, m) { try { showPopupNotif(i, t, m); } catch (e) {} }
  function E(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function naira(k) { return '₦' + (Number(k || 0) / 100).toLocaleString('en-NG'); }

  // ---- 1. true ratings (computed on the server, nobody can edit an average) -------------------
  window.EMEMART_PARTNER_STATS = window.EMEMART_PARTNER_STATS || {};
  window.EMEMART_REMOTE_REVIEWS = window.EMEMART_REMOTE_REVIEWS || {};
  async function loadStats() {
    try {
      var r = await api('GET', '/partners/stats');
      window.EMEMART_PARTNER_STATS = r.stats || {};
      if (typeof renderFeed === 'function') renderFeed();
    } catch (e) { /* ratings just show as New */ }
  }
  var _op = window.openVendorProfile;
  if (typeof _op === 'function') {
    window.openVendorProfile = function (userId) {
      _op.apply(this, arguments);
      api('GET', '/partners/' + encodeURIComponent(userId) + '/reviews').then(function (r) {
        window.EMEMART_REMOTE_REVIEWS[userId] = (r.reviews || []).map(function (x) {
          return { id: x.id, stars: x.stars, text: x.comment || '', ts: new Date(x.created_at).getTime(), buyerId: x.customer_id, buyerName: x.customer_name, foodName: 'order', reply: x.reply || '', replyTs: x.reply_at ? new Date(x.reply_at).getTime() : 0 };
        });
        if (typeof renderVendorReviews === 'function') renderVendorReviews(userId);
      }).catch(function () {});
    };
  }
  // submit a rating to the server (one per completed order, checked there)
  window.submitReview = async function () {
    if (!_reviewState || !_reviewState.stars) { toast('⚠️', 'No rating', 'Please choose 1 to 5 stars.'); return; }
    if (((E('review-text').value) || '').trim().length < 5) { toast('✍️', 'Add a comment', 'Please write a short comment about your experience.'); return; }
    var btn = E('submit-review-btn'); if (btn) btn.disabled = true;
    try {
      await api('POST', '/orders/' + encodeURIComponent(_reviewState.orderId) + '/review', { stars: _reviewState.stars, comment: (E('review-text').value || '').trim() });
      _reviewState.done = true;
      try { var r = JSON.parse(localStorage.getItem('ememart_rated_orders') || '[]'); r.push(String(_reviewState.orderId)); localStorage.setItem('ememart_rated_orders', JSON.stringify(r)); } catch (e) {}
      E('review-modal').classList.add('hidden');
      toast('⭐', 'Thank you', 'Your rating was sent.');
      loadStats();
    } catch (e) {
      toast('❌', 'Could not send rating', e.message || 'Try again.');
      if (btn) btn.disabled = false;
    }
  };

  // ---- 1b. my disputes: show the real server tickets (read-only mirror) ------------------------
  window.EMEMART_REMOTE_DISPUTES = null;
  var DSTATUS = { open: 'open', under_review: 'acknowledged', resolved_buyer: 'resolved', resolved_seller: 'resolved', closed: 'closed' };
  function mapDispute(d) {
    var o = d.orders || {}, snap = o.item_snapshot || {};
    var created = new Date(d.created_at).getTime(), upd = new Date(d.resolved_at || d.created_at).getTime();
    var myId = (state.session && state.session.id) || '';
    var msgs = [
      { from: d.opened_by === myId ? 'user' : 'other', label: d.opened_by === myId ? '' : 'Other party', text: esc(d.reason), ts: created },
      { from: 'system', text: 'The payment is on hold while support reviews this ticket. We aim to reply within 48 hours.', ts: created }
    ];
    (d.dispute_messages || []).slice().sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); }).forEach(function (m) {
      msgs.push({ from: m.user_id === myId ? 'user' : 'other', label: m.user_id === myId ? '' : 'Other party', text: esc(m.body), ts: new Date(m.created_at).getTime() });
    });
    (d.dispute_evidence || []).forEach(function (e) {
      if (e.url) msgs.push({ from: 'user', text: '<a href="' + esc(e.url) + '" target="_blank" rel="noopener" style="text-decoration:underline">Photo evidence</a>' + (e.note ? ': ' + esc(e.note) : ''), ts: new Date(e.created_at).getTime() });
    });
    msgs.sort(function (a, b) { return a.ts - b.ts; });
    if (d.resolution_note) msgs.push({ from: 'agent', text: esc(d.resolution_note), ts: upd });
    if (d.status === 'resolved_buyer') msgs.push({ from: 'agent', text: 'Decision: refunded to the customer.', ts: upd });
    if (d.status === 'resolved_seller') msgs.push({ from: 'agent', text: 'Decision: payment released to the Partner.', ts: upd });
    return {
      id: 'DSP-' + String(d.id).slice(0, 6).toUpperCase(), serverId: d.id, remote: true,
      userId: (state.session && state.session.id) || '', status: DSTATUS[d.status] || 'open',
      foodName: snap.title || snap.foodName || 'Order', vendorName: snap.seller_name || snap.vendorName || 'Partner',
      amount: Math.round(Number(o.amount_kobo || 0) / 100), reason: 'other', resolution: 'full_refund',
      openedByMe: d.opened_by === myId, rawStatus: d.status, createdAt: created, updatedAt: upd, escrowFrozen: o.status === 'disputed', messages: msgs
    };
  }
  async function loadDisputes() {
    try {
      var r = await api('GET', '/disputes');
      window.EMEMART_REMOTE_DISPUTES = (r.disputes || []).map(mapDispute);
      if (typeof renderDisputeTickets === 'function') renderDisputeTickets();
    } catch (e) {}
  }
  var _gd = window.getDisputes;
  window.getDisputes = function () { return window.EMEMART_REMOTE_DISPUTES ? window.EMEMART_REMOTE_DISPUTES : (_gd ? _gd() : []); };
  var _rdm = window.renderDisputeDetailModal;
  if (typeof _rdm === 'function') window.renderDisputeDetailModal = function (t) {
    _rdm.apply(this, arguments);
    if (t && t.remote) {
      var a = document.getElementById('ddetail-actions');
      if (!a) return;
      var live = t.rawStatus === 'open' || t.rawStatus === 'under_review';
      if (!live) { a.innerHTML = '<div class="text-center text-xs text-gray-500 italic py-2">This ticket is closed.</div>'; return; }
      a.innerHTML =
        '<textarea id="dd-msg" rows="2" maxlength="2000" placeholder="Write a message to support and the other party..." class="inp resize-none text-xs"></textarea>' +
        '<div class="flex gap-2">' +
        '<button type="button" id="dd-send" class="btn-primary py-2.5 text-xs flex-1">Send message</button>' +
        '<label class="btn-sm-outline py-2.5 text-xs text-center cursor-pointer flex-1">Add photo<input id="dd-photo" type="file" accept="image/*" class="hidden"></label>' +
        '</div>' +
        (t.openedByMe && t.rawStatus === 'open' ? '<button type="button" id="dd-withdraw" class="text-[11px] font-black text-red-400 underline self-center py-1">Withdraw this dispute</button>' : '');
      document.getElementById('dd-send').onclick = async function () {
        var box = document.getElementById('dd-msg'), txt = (box.value || '').trim();
        if (!txt) { toast('✍️', 'Write a message', 'Type your message first.'); return; }
        this.disabled = true;
        try { await api('POST', '/disputes/' + t.serverId + '/messages', { body: txt }); box.value = ''; await loadDisputes(); var nt = window.EMEMART_REMOTE_DISPUTES.find(function (x) { return x.serverId === t.serverId; }); if (nt) window.renderDisputeDetailModal(nt); }
        catch (e) { toast('❌', 'Not sent', (e && e.message) || 'Please try again.'); this.disabled = false; }
      };
      document.getElementById('dd-photo').onchange = async function () {
        var f = this.files && this.files[0]; if (!f) return;
        if (f.size > 8 * 1024 * 1024) { toast('⚠️', 'Photo too large', 'Please pick a photo under 8 MB.'); return; }
        try {
          var path = me().id + '/' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.' + (f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg');
          var up = await window.sb.storage.from('dispute-evidence').upload(path, f, { contentType: f.type });
          if (up.error) throw up.error;
          await api('POST', '/disputes/' + t.serverId + '/evidence', { path: path });
          toast('📎', 'Photo added', 'Support can now see it.');
          await loadDisputes(); var nt = window.EMEMART_REMOTE_DISPUTES.find(function (x) { return x.serverId === t.serverId; }); if (nt) window.renderDisputeDetailModal(nt);
        } catch (e) { toast('❌', 'Upload failed', (e && e.message) || 'Please try again.'); }
      };
      var wd = document.getElementById('dd-withdraw');
      if (wd) wd.onclick = async function () {
        if (!(await uiConfirm('Withdraw this dispute? The order will continue as normal.'))) return;
        try { await api('POST', '/disputes/' + t.serverId + '/withdraw'); toast('✅', 'Dispute withdrawn', 'The order continues as normal.'); await loadDisputes(); var m = document.getElementById('dispute-detail-modal'); if (m) m.classList.add('hidden'); try { if (B.reloadOrders) B.reloadOrders(); } catch (e) {} }
        catch (e) { toast('❌', 'Could not withdraw', (e && e.message) || 'Please try again.'); }
      };
    }
  };
  var _sdt = window.switchSafetyTab;
  if (typeof _sdt === 'function') window.switchSafetyTab = function (tab) { _sdt.apply(this, arguments); if (tab === 'disputes') loadDisputes(); };
  // orders delivered but not rated yet -> one reminder
  async function remindUnrated() {
    try {
      var r = await api('GET', '/reviews/pending');
      var seen = JSON.parse(localStorage.getItem('ememart_review_reminded') || '[]'), changed = false;
      (r.pending || []).forEach(function (o) {
        if (seen.indexOf(o.id) >= 0) return;
        state.notifications.unshift({ id: 'n-rv-' + o.id, icon: '⭐', title: 'Rate your order', body: 'How was your experience with ' + ((o.item_snapshot && o.item_snapshot.seller_name) || 'your Partner') + '? Tap to rate.', ts: Date.now(), read: false, action: 'review:' + (o.post_id || '') + ':' + o.id });
        seen.push(o.id); changed = true;
      });
      if (changed) { localStorage.setItem('ememart_review_reminded', JSON.stringify(seen)); saveNotificationsToStorage(); renderNotifList(); }
    } catch (e) {}
  }

  // ---- 2. rider portal ---------------------------------------------------------------------
  function card(j, actions) {
    var s = j.item_snapshot || {};
    return '<div class="bg-gray-950 border border-gray-800 rounded-2xl p-3 text-xs flex flex-col gap-2">' +
      '<div class="font-black text-white">' + esc(s.title || 'Delivery') + '</div>' +
      '<div class="text-gray-400">From ' + esc(s.seller_name || 'Partner') + '</div>' +
      '<div class="text-gray-400">To: ' + esc(j.delivery_address || 'Customer address') + '</div>' +
      '<div class="flex items-end justify-between gap-2"><div><div class="text-[10px] text-gray-500 font-bold">You earn</div><div class="text-emerald-500 font-black text-base">' + naira(j.earn_kobo != null ? j.earn_kobo : j.delivery_fee_kobo) + '</div>' +
      '<div class="text-[10px] text-gray-500">Delivery fee ' + naira(j.delivery_fee_kobo) + ' less EMEMART fee</div></div>' + (actions || '') + '</div></div>';
  }
  var NEXT = { accepted: ['picked_up', 'Picked up'], picked_up: ['on_the_way', 'On the way'], on_the_way: ['delivered', 'Enter delivery code'] };
  async function loadEarnings() {
    try {
      var r = await api('GET', '/rider/earnings');
      function set(id, v) { var e = E(id); if (e) e.textContent = v; }
      set('rider-today-earn', naira(r.today_kobo)); set('rider-week-earn', naira(r.week_kobo));
      set('rider-total-deliveries', r.paid_count);
      if (typeof partnerStats === 'function' && me()) { var s = partnerStats(me().id); set('rider-rating-display', s.count ? s.avg.toFixed(1) + ' ★' : '—'); }
      var note = E('rider-earn-note');
      if (!note) { var host = E('rider-today-earn') && E('rider-today-earn').closest('.grid, div'); }
      if (r.awaiting_confirmation) toast('ℹ️', 'Payment pending', r.awaiting_confirmation + ' delivery payment(s) arrive once the customer confirms.');
    } catch (e) {}
  }
  window.refreshAvailableOrders = async function () {
    loadEarnings();
    var w = E('rider-available-list'); if (!w) return;
    w.innerHTML = '<div class="text-center py-6 text-xs text-gray-500">Loading...</div>';
    try {
      var r = await api('GET', '/rider/jobs');
      w.innerHTML = (r.jobs || []).map(function (j) {
        return card(j, '<button class="btn-primary px-4 py-2 text-xs" style="width:auto" onclick="riderAccept(\'' + j.id + '\')">Accept</button>');
      }).join('') || '<div class="text-center py-8 text-xs text-gray-500 italic">No delivery jobs right now. Pull to refresh.</div>';
    } catch (e) { w.innerHTML = '<div class="text-center py-6 text-xs text-red-400">' + esc(e.message || 'Could not load jobs') + '</div>'; }
  };
  window.renderRiderActiveDeliveries = async function () {
    var w = E('rider-active-list'); if (!w) return;
    try {
      var r = await api('GET', '/rider/mine');
      var act = (r.jobs || []).filter(function (j) { return j.delivery_status && j.delivery_status !== 'delivered'; });
      w.innerHTML = act.map(function (j) {
        var n = NEXT[j.delivery_status];
        return card(j, (j.delivery_status === 'accepted' ? '<button class="text-[11px] font-bold text-gray-500 underline mr-2" onclick="riderDrop(\'' + j.id + '\')">Drop</button>' : '') + (n ? '<button class="btn-primary px-4 py-2 text-xs" style="width:auto" onclick="riderStep(\'' + j.id + '\',\'' + n[0] + '\')">' + n[1] + '</button>' : ''));
      }).join('') || '<div class="text-center py-8 text-xs text-gray-500 italic">No active deliveries.</div>';
    } catch (e) { w.innerHTML = '<div class="text-center py-6 text-xs text-red-400">' + esc(e.message || 'Could not load') + '</div>'; }
  };
  window.renderRiderHistory = async function () {
    var w = E('rider-history-list'); if (!w) return;
    try {
      var r = await api('GET', '/rider/mine');
      var done = (r.jobs || []).filter(function (j) { return j.delivery_status === 'delivered'; });
      var total = E('rider-total-deliveries'); if (total) total.textContent = done.length;
      w.innerHTML = done.map(function (j) { return card(j, '<span class="text-gray-500">Delivered</span>'); }).join('') || '<div class="text-center py-8 text-xs text-gray-500 italic">No completed deliveries yet.</div>';
    } catch (e) {}
  };
  window.riderAccept = async function (id) {
    try { await api('POST', '/rider/jobs/' + id + '/accept'); toast('✅', 'Job accepted', 'Head to the Partner for pickup.'); switchRiderTab('active'); }
    catch (e) { toast('⚠️', 'Not available', e.message || 'Try another job.'); refreshAvailableOrders(); }
  };
  window.riderDrop = async function (id) {
    if (!(await uiConfirm('Drop this job? It goes back to other riders.'))) return;
    try { await api('POST', '/rider/jobs/' + id + '/drop'); renderRiderActiveDeliveries(); } catch (e) { toast('⚠️', 'Cannot drop', e.message || ''); }
  };
  window.riderStep = async function (id, status) {
    if (status === 'delivered') { if (typeof openHandover === 'function') openHandover(id); return; }   // the Customer's 6-digit code confirms handover
    try { await api('POST', '/rider/jobs/' + id + '/status', { status: status }); renderRiderActiveDeliveries(); if (status === 'delivered') toast('✅', 'Delivered', 'The customer was asked to confirm.'); }
    catch (e) { toast('❌', 'Could not update', e.message || 'Try again.'); }
  };

  // ---- 3. push notifications ---------------------------------------------------------------
  // The sending key comes from the server (GET /push/key). The browser's permission box only opens when the
  // person taps "Turn on" in Account > Security, never on its own.
  function b64(u) { var p = '='.repeat((4 - u.length % 4) % 4), s = (u + p).replace(/-/g, '+').replace(/_/g, '/'), r = atob(s), a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function sameKey(sub, keyBytes) {
    try { var cur = new Uint8Array(sub.options.applicationServerKey); if (cur.length !== keyBytes.length) return false; for (var i = 0; i < cur.length; i++) if (cur[i] !== keyBytes[i]) return false; return true; } catch (e) { return true; }
  }
  // ask = true: may open the permission box (a tap). ask = false: only refreshes a device that already said yes.
  async function syncPush(ask) {
    if (!pushSupported() || !me()) return 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission !== 'granted' && !ask) return 'off';
    var kr = await api('GET', '/push/key');
    if (!kr || !kr.key) return 'error';
    var keyBytes = b64(kr.key);
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, keyBytes)) { try { await sub.unsubscribe(); } catch (e) {} sub = null; }
    if (!sub) {
      if (Notification.permission !== 'granted') { var p = await Notification.requestPermission(); if (p !== 'granted') return p === 'denied' ? 'blocked' : 'off'; }
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
    }
    var j = sub.toJSON();
    var r = await api('POST', '/push/subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    return r && r.success === false ? 'error' : 'on';
  }
  window.pushState = async function () {
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'blocked';
    if (Notification.permission !== 'granted') return 'off';
    try { var reg = await navigator.serviceWorker.ready; return (await reg.pushManager.getSubscription()) ? 'on' : 'off'; } catch (e) { return 'off'; }
  };
  function userTurnedOff() { try { return localStorage.getItem('ememart_push_off') === '1'; } catch (e) { return false; } }
  function setTurnedOff(v) { try { if (v) localStorage.setItem('ememart_push_off', '1'); else localStorage.removeItem('ememart_push_off'); } catch (e) {} }
  window.turnPushOn = async function () { setTurnedOff(false); try { return await syncPush(true); } catch (e) { return 'error'; } };
  window.turnPushOff = async function () {
    try {
      var reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
      if (sub) { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setTurnedOff(true);
      return 'off';
    } catch (e) { return 'error'; }
  };
  // On by default: subscribe quietly if the browser already allows it, otherwise ask on the person's first tap
  // (browsers only show the permission box after a tap). Never again once the person has turned it off.
  async function enablePush() {
    if (userTurnedOff() || !pushSupported() || !me()) return;
    try {
      if (Notification.permission === 'granted') { await syncPush(false); return; }
      if (Notification.permission !== 'default') return;
      var once = function () {
        document.removeEventListener('click', once, true); document.removeEventListener('touchend', once, true);
        if (!userTurnedOff()) syncPush(true).catch(function () {});
      };
      document.addEventListener('click', once, true); document.addEventListener('touchend', once, true);
    } catch (e) {}
  }

  function start() { loadStats(); loadDisputes(); remindUnrated(); setTimeout(enablePush, 4000); }
  var tries = 0, t = setInterval(function () { if (me() || ++tries > 40) { clearInterval(t); if (me()) start(); } }, 500);
  window.addEventListener('ememart:signed-in', start);
})();
