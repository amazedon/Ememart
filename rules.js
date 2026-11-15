// rules.js  (save in the SAME folder as app.html)
// Ememart posting rules, blue tick, freshness reminders and pre-order bookings.
//  - Food posts disappear after 24 hours. Verified vendors may choose "leave open".
//  - Open food posts get freshness reminders at 6h, 8h, then every 8h.
//  - Every post is deleted after 30 days, with warnings 3 days and 1 day before.
//  - Pre-order bookings: customers book a date ahead and pay a deposit or in full into escrow.
// The server enforces the same rules once the app is connected; this file makes the app show and follow them.
(function () {
  'use strict';

  var H = 3600000, DAY = 24 * H;
  var FOOD_HOURS = 24, POST_DAYS = 30;
  window.FOOD_HOURS = FOOD_HOURS;

  function $(id) { return document.getElementById(id); }
  function naira(n) { return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function notify(icon, title, body) {
    try { showPopupNotif(icon, title, body); } catch (e) {}
    try { if (typeof _swSendLocal === 'function') _swSendLocal(icon, title, body, 'ememart-rule'); } catch (e) {}
  }
  function backend() { return window.EMEMART_BACKEND || { mode: 'dev' }; }

  // ------------------------------------------------------------------------------------------
  // Blue tick
  // ------------------------------------------------------------------------------------------
  window.blueTick = function (size) {
    size = size || 14;
    return '<svg class="inline-block ml-0.5" style="vertical-align:-2px" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" role="img" aria-label="Verified"><title>Verified</title><circle cx="12" cy="12" r="11" fill="#1d9bf0"/>' +
      '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  };
  function paintStaticTicks() {
    var a = $('vp-verified-badge'); if (a) a.innerHTML = window.blueTick(16);
    var b = $('pd-seller-verified'); if (b) { b.innerHTML = window.blueTick(12) + ' Verified'; b.className = b.className.replace(/bg-emerald-900\/50|text-emerald-400|border-emerald-800\/50/g, '') + ' text-sky-300'; }
  }

  // ------------------------------------------------------------------------------------------
  // Composer: how long should a food post stay up, and the pre-order option
  // ------------------------------------------------------------------------------------------
  function injectComposerBits() {
    var box = $('food-delivery-inputs');
    if (!box || $('food-retention-box')) return;
    var w = document.createElement('div');
    w.id = 'food-retention-box';
    w.className = 'bg-gray-950 border border-gray-800 rounded-xl p-3 flex flex-col gap-2';
    w.innerHTML =
      '<div id="food-retention-part" class="flex flex-col gap-2">' +
        '<label class="label-sm">How long should this post stay up?</label>' +
        '<label class="flex items-center gap-2 text-xs text-gray-200 cursor-pointer"><input type="radio" name="food-retention" value="delete_24h" checked class="accent-emerald-500"> Delete after 24 hours</label>' +
        '<label id="food-ret-open-label" class="flex items-center gap-2 text-xs text-gray-200 cursor-pointer"><input type="radio" name="food-retention" value="open" id="food-ret-open" class="accent-emerald-500"> Leave open</label>' +
        '<p id="food-retention-note" class="text-[10px] leading-relaxed text-gray-400"></p>' +
      '</div>' +
      '<div class="border-t border-gray-800 pt-2 flex flex-col gap-2">' +
        '<label class="flex items-center gap-2 cursor-pointer select-none"><input type="checkbox" id="food-is-booking" class="accent-sky-500">' +
        '<span class="text-xs font-black text-sky-300">📅 This is a pre-order (customers book a date ahead)</span></label>' +
        '<div id="food-booking-fields" class="hidden grid grid-cols-3 gap-2">' +
          '<div class="flex flex-col gap-1"><label class="label-sm text-[9px]">Book at least</label><select id="food-book-lead" class="inp py-1 text-xs"><option value="12">12 hours ahead</option><option value="24" selected>24 hours ahead</option><option value="48">2 days ahead</option><option value="72">3 days ahead</option></select></div>' +
          '<div class="flex flex-col gap-1"><label class="label-sm text-[9px]">Deposit</label><select id="food-book-deposit" class="inp py-1 text-xs"><option value="30" selected>30%</option><option value="50">50%</option><option value="100">Full payment</option></select></div>' +
          '<div class="flex flex-col gap-1"><label class="label-sm text-[9px]">Minimum portions</label><input type="number" id="food-book-minqty" min="1" value="1" class="inp py-1 text-xs"></div>' +
        '</div>' +
        '<p id="food-booking-note" class="hidden text-[10px] leading-relaxed text-gray-400">Pre-orders stay up for 30 days. Customers pay the deposit into escrow when they book. You accept or decline each request.</p>' +
      '</div>';
    box.appendChild(w);
    $('food-is-booking').addEventListener('change', updateFoodRetentionUI);
  }

  window.updateFoodRetentionUI = function () {
    injectComposerBits();
    var note = $('food-retention-note'); if (!note) return;
    var verified = !!(typeof state !== 'undefined' && state.session && state.session.verified);
    var open = $('food-ret-open'), label = $('food-ret-open-label');
    var booking = $('food-is-booking') && $('food-is-booking').checked;
    $('food-retention-part').classList.toggle('hidden', booking);
    $('food-booking-fields').classList.toggle('hidden', !booking);
    $('food-booking-note').classList.toggle('hidden', !booking);
    open.disabled = !verified;
    label.classList.toggle('opacity-50', !verified);
    if (!verified) {
      if (open.checked) document.querySelector('input[name="food-retention"][value="delete_24h"]').checked = true;
      note.textContent = 'Food posts disappear after 24 hours. Get verified with your NIN or CAC to leave posts open.';
    } else {
      note.textContent = 'Open posts have no timer. We remind you to check freshness after 6 hours, at 8 hours, and every 8 hours after. Only keep food up if it is safe to eat. Bad complaints can lead to account suspension.';
    }
  };

  // Called by the app when it builds a food post. Decides expiry; the server applies the same rule.
  window.applyFoodRetention = function (post) {
    var now = Date.now();
    var verified = !!(typeof state !== 'undefined' && state.session && state.session.verified);
    var isBooking = !!($('food-is-booking') && $('food-is-booking').checked);
    var sel = document.querySelector('input[name="food-retention"]:checked');
    var wantsOpen = sel && sel.value === 'open';
    post.deleteAt = now + POST_DAYS * DAY;
    post.expired = false;
    post.isBooking = false;
    delete post.bookingMeta;
    if (isBooking) {
      post.isBooking = true; post.retention = 'booking'; post.expiresAt = null;
      post.bookingMeta = {
        leadHours: +($('food-book-lead') || {}).value || 24,
        depositPct: +($('food-book-deposit') || {}).value || 30,
        minQty: Math.max(1, +($('food-book-minqty') || {}).value || 1)
      };
    } else if (verified && wantsOpen) {
      post.retention = 'open'; post.expiresAt = null;
      post.openSince = now; post.reminderStage = 0; post.nextReminderAt = now + 6 * H;
    } else {
      post.retention = 'delete_24h'; post.expiresAt = now + FOOD_HOURS * H;
    }
  };

  // ------------------------------------------------------------------------------------------
  // Expiry, deletion, freshness reminders
  // ------------------------------------------------------------------------------------------
  var _isVendorOpen = window.isVendorOpen;
  window.isVendorOpen = function (post) {
    if (post && post.isFood && (post.retention === 'open' || post.isBooking)) return 'open';
    return _isVendorOpen(post);
  };

  function mineId() { return typeof state !== 'undefined' && state.session ? state.session.id : null; }

  function remindersAndWarnings() {
    if (window.EMEMART_BACKEND && window.EMEMART_BACKEND.mode === 'live') return false;   // the server sends these
    var now = Date.now(), me = mineId(); if (!me) return false;
    var changed = false;
    state.posts.forEach(function (p) {
      if (p.authorId !== me) return;
      // 30-day deletion warnings
      if (p.deleteAt && !p.expiresAt) {
        var left = p.deleteAt - now;
        if (!p.warn3 && left <= 3 * DAY && left > DAY) { p.warn3 = true; changed = true; notify('🗓️', 'Post deleted in 3 days', '"' + (p.foodName || p.bizServiceName || 'Your post') + '" will be removed automatically in 3 days.'); }
        if (!p.warn1 && left <= DAY && left > 0) { p.warn1 = true; changed = true; notify('⏰', 'Post deleted tomorrow', '"' + (p.foodName || p.bizServiceName || 'Your post') + '" will be removed automatically in 1 day.'); }
      }
      // freshness reminders for open food posts: 6h, 8h, then every 8h
      if (p.isFood && p.retention === 'open' && p.nextReminderAt && now >= p.nextReminderAt) {
        notify('🍲', p.reminderStage === 0 ? 'Is this food still fresh?' : 'Final freshness reminder',
          '"' + (p.foodName || 'Your food post') + '" has been open for a while. Only keep it up if the food is safe to eat. Bad complaints can lead to account suspension.');
        p.nextReminderAt = p.reminderStage === 0 ? p.openSince + 8 * H : now + 8 * H;
        p.reminderStage = (p.reminderStage || 0) + 1;
        changed = true;
      }
    });
    return changed;
  }

  window.checkExpirations = function () {
    var now = Date.now(), before = state.posts.length;
    state.posts = state.posts.filter(function (p) {
      if (p.deleteAt && now > p.deleteAt) return false;                                        // 30-day rule
      if (p.isFood && !p.isBooking && p.retention !== 'open' && p.expiresAt && now > p.expiresAt) return false; // 24-hour food rule
      return true;
    });
    var changed = remindersAndWarnings() || state.posts.length !== before;
    if (changed) { try { localStorage.setItem('ememart_posts', JSON.stringify(state.posts)); } catch (e) {} }
    if (state.posts.length !== before && state.activePanel === 'home' && $('feed-view-panel') && !$('feed-view-panel').classList.contains('hidden')) {
      try { renderFeed(); } catch (e) {}
    }
  };

  // ------------------------------------------------------------------------------------------
  // Pre-order bookings
  // ------------------------------------------------------------------------------------------
  var LOCAL_KEY = 'ememart_bookings';
  function localBookings() { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; } }
  function saveLocal(list) { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (e) {} }

  function ensureModal(id, inner) {
    var m = $(id);
    if (!m) {
      m = document.createElement('div');
      m.id = id; m.className = 'modal-overlay hidden';
      m.addEventListener('click', function (e) { if (e.target === m) m.classList.add('hidden'); });
      document.body.appendChild(m);
    }
    m.innerHTML = '<div class="modal-sheet flex flex-col gap-4">' + inner + '</div>';
    return m;
  }

  var _bookingPostId = null;
  function minDateTime(post) {
    var lead = (post.bookingMeta && post.bookingMeta.leadHours) || 24;
    var d = new Date(Date.now() + lead * H);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  window.openBookingModal = function (postId) {
    if (!state.session) { notify('🔐', 'Sign In Required', 'Please sign in to book.'); return; }
    var post = state.posts.find(function (p) { return p.id === postId; });
    if (!post || !post.isBooking) return;
    if (post.authorId === state.session.id) { notify('⚠️', 'Your own post', 'You cannot book your own pre-order.'); return; }
    _bookingPostId = postId;
    var meta = post.bookingMeta || {};
    var m = ensureModal('booking-modal',
      '<div class="flex justify-between items-center"><div><h3 class="text-base font-black text-white">📅 Book ' + esc(post.foodName || 'pre-order') + '</h3>' +
      '<p class="text-[10px] text-gray-400">From ' + esc(post.authorName) + (post.verified ? window.blueTick(12) : '') + '</p></div>' +
      '<button onclick="document.getElementById(\'booking-modal\').classList.add(\'hidden\')" class="text-gray-400 text-lg font-black">✕</button></div>' +
      '<div class="flex flex-col gap-3">' +
        '<div class="flex flex-col gap-1"><label class="label-sm">Date and time you need it</label><input type="datetime-local" id="bk-when" class="inp" min="' + minDateTime(post) + '"><p class="text-[10px] text-gray-500">Book at least ' + (meta.leadHours || 24) + ' hours ahead.</p></div>' +
        '<div class="flex flex-col gap-1"><label class="label-sm">Portions</label><input type="number" id="bk-qty" class="inp" min="' + (meta.minQty || 1) + '" value="' + (meta.minQty || 1) + '" oninput="bookingSummary()"></div>' +
        '<div class="flex flex-col gap-1"><label class="label-sm">Pay now</label><select id="bk-pay" class="inp" onchange="bookingSummary()"><option value="deposit">Deposit (' + (meta.depositPct == null ? 30 : meta.depositPct) + '%)</option><option value="full">Full amount</option></select></div>' +
        '<div class="flex flex-col gap-1"><label class="label-sm">Note for the vendor (optional)</label><textarea id="bk-note" rows="2" class="inp" placeholder="Event, address, special requests"></textarea></div>' +
        (backend().mode === 'live' ? '<div class="flex flex-col gap-1"><label class="label-sm">Transaction PIN</label><input type="password" id="bk-pin" inputmode="numeric" maxlength="6" class="inp" autocomplete="off"></div>' : '') +
        '<div id="bk-summary" class="bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs text-gray-300"></div>' +
        '<p class="text-[10px] text-gray-500">Your payment is held in escrow. If the vendor declines, you are refunded in full.</p>' +
      '</div>' +
      '<button id="bk-submit" onclick="submitBooking()" class="btn-primary py-3">Request booking</button>');
    m.classList.remove('hidden');
    window.bookingSummary();
  };

  window.bookingSummary = function () {
    var post = state.posts.find(function (p) { return p.id === _bookingPostId; }); if (!post) return;
    var qty = Math.max(1, +($('bk-qty') || {}).value || 1);
    var unit = post.flashSale && post.flashPrice ? post.flashPrice : (post.price || 0);
    var total = unit * qty, pct = post.bookingMeta && post.bookingMeta.depositPct != null ? post.bookingMeta.depositPct : 30;
    var pay = ($('bk-pay') || {}).value === 'full' ? total : Math.max(1, Math.floor(total * pct / 100));
    $('bk-summary').innerHTML = '<div class="flex justify-between"><span>Total</span><b>' + naira(total) + '</b></div>' +
      '<div class="flex justify-between mt-1"><span>You pay now</span><b class="text-emerald-400">' + naira(pay) + '</b></div>' +
      (pay < total ? '<div class="flex justify-between mt-1 text-gray-500"><span>Balance, paid to vendor on the day</span><span>' + naira(total - pay) + '</span></div>' : '');
  };

  window.submitBooking = async function () {
    var post = state.posts.find(function (p) { return p.id === _bookingPostId; }); if (!post) return;
    var when = ($('bk-when') || {}).value, qty = +($('bk-qty') || {}).value || 1;
    var meta = post.bookingMeta || {};
    if (!when) { notify('⚠️', 'Date needed', 'Choose the date and time you need it.'); return; }
    var whenDate = new Date(when);
    if (whenDate.getTime() < Date.now() + (meta.leadHours || 24) * H) { notify('⚠️', 'Too soon', 'Book at least ' + (meta.leadHours || 24) + ' hours ahead.'); return; }
    if (qty < (meta.minQty || 1)) { notify('⚠️', 'Too few portions', 'Minimum is ' + (meta.minQty || 1) + ' portions.'); return; }
    var btn = $('bk-submit'); btn.disabled = true; btn.textContent = 'Sending...';
    try {
      var payFull = ($('bk-pay') || {}).value === 'full', note = ($('bk-note') || {}).value || '';
      var res;
      if (backend().mode === 'live') {
        res = await backend().createBooking({ post_id: post.id, event_at: whenDate.toISOString(), quantity: qty, pay: payFull ? 'full' : 'deposit', note: note, pin: ($('bk-pin') || {}).value || '' });
      } else {
        var unit = post.flashSale && post.flashPrice ? post.flashPrice : (post.price || 0), total = unit * qty;
        var pct = meta.depositPct == null ? 30 : meta.depositPct;
        var list = localBookings();
        list.unshift({ id: 'bk-' + Date.now(), post_id: post.id, title: post.foodName, buyer_id: state.session.id, vendor_id: post.authorId, vendor_name: post.authorName,
          event_at: whenDate.toISOString(), quantity: qty, total_kobo: total * 100, deposit_kobo: (payFull ? total : Math.max(1, Math.floor(total * pct / 100))) * 100, note: note, status: 'requested' });
        saveLocal(list);
        res = { success: true };
      }
      if (!res.success) { notify('❌', 'Booking failed', res.message || 'Try again.'); return; }
      $('booking-modal').classList.add('hidden');
      notify('📅', 'Booking requested', 'The vendor will accept or decline. Your payment is held safely in escrow.');
    } catch (e) { notify('❌', 'Booking failed', 'Connection problem. Try again.'); }
    finally { btn.disabled = false; btn.textContent = 'Request booking'; }
  };

  // My bookings (as customer and as vendor)
  var STATUS = { requested: 'Waiting for vendor', accepted: 'Accepted', declined: 'Declined (refunded)', fulfilled: 'Delivered, confirm to pay vendor', cancelled: 'Cancelled', refunded: 'Refunded' };

  async function loadBookings() {
    if (backend().mode === 'live') { var r = await backend().listBookings(); return r.success ? (r.bookings || []) : []; }
    return localBookings();
  }

  window.openMyBookings = async function () {
    if (!state.session) { notify('🔐', 'Sign In Required', 'Please sign in to see your bookings.'); return; }
    var m = ensureModal('mybookings-modal',
      '<div class="flex justify-between items-center"><h3 class="text-base font-black text-white">📅 My bookings</h3>' +
      '<button onclick="document.getElementById(\'mybookings-modal\').classList.add(\'hidden\')" class="text-gray-400 text-lg font-black">✕</button></div>' +
      '<div id="mybookings-list" class="flex flex-col gap-2 max-h-[60vh] overflow-y-auto"><div class="text-xs text-gray-500 italic">Loading...</div></div>');
    m.classList.remove('hidden');
    var list = await loadBookings(), box = $('mybookings-list'), me = state.session.id;
    if (!list.length) { box.innerHTML = '<div class="text-center py-8 text-xs text-gray-500 italic">No bookings yet. Find a pre-order post and tap Book.</div>'; return; }
    box.innerHTML = list.map(function (b) {
      var isVendor = b.vendor_id === me, title = b.title || (b.vendor_snapshot && b.vendor_snapshot.title) || 'Pre-order';
      var actions = '';
      if (isVendor && b.status === 'requested') actions = '<button class="btn-sm-primary" onclick="bookingAct(\'' + b.id + '\',\'accept\')">Accept</button><button class="btn-sm-outline" onclick="bookingAct(\'' + b.id + '\',\'decline\')">Decline</button>';
      else if (isVendor && b.status === 'accepted') actions = '<button class="btn-sm-primary" onclick="bookingAct(\'' + b.id + '\',\'fulfil\')">Mark delivered</button>';
      else if (!isVendor && b.status === 'fulfilled') actions = '<button class="btn-sm-primary" onclick="bookingAct(\'' + b.id + '\',\'confirm\')">Confirm received</button><button class="btn-sm-outline" onclick="bookingAct(\'' + b.id + '\',\'dispute\')">Report a problem</button>';
      return '<div class="bg-gray-950 border border-gray-800 rounded-xl p-3 flex flex-col gap-1">' +
        '<div class="flex justify-between gap-2"><b class="text-sm text-white">' + esc(title) + '</b><span class="text-[10px] font-black text-sky-300">' + (STATUS[b.status] || esc(b.status)) + '</span></div>' +
        '<div class="text-[10px] text-gray-400">' + (isVendor ? 'You are the vendor' : 'You booked' + (b.vendor_name ? ' from ' + esc(b.vendor_name) : '')) + ' · ' + new Date(b.event_at).toLocaleString() + ' · ' + b.quantity + ' portions</div>' +
        '<div class="text-[10px] text-gray-400">Total ' + naira(b.total_kobo / 100) + ' · deposit ' + naira(b.deposit_kobo / 100) + '</div>' +
        (b.note ? '<div class="text-[10px] text-gray-500">Note: ' + esc(b.note) + '</div>' : '') +
        (actions ? '<div class="flex gap-2 mt-2">' + actions + '</div>' : '') + '</div>';
    }).join('');
  };

  window.bookingAct = async function (id, action) {
    try {
      var res;
      if (backend().mode === 'live') {
        var B = backend(), list = await B.listBookings(), bk = (list.bookings || []).find(function (x) { return x.id === id; });
        if (action === 'accept' || action === 'decline') res = await B.respondBooking(id, action === 'accept');
        else if (action === 'fulfil') res = await B.fulfilBooking(id);
        else if (action === 'confirm') res = await B.confirmOrder(bk.order_id);
        else if (action === 'dispute') {
          var reason = window.prompt('What went wrong? (at least 10 characters)');
          if (!reason) return;
          res = await B.disputeOrder(bk.order_id, reason);
        }
      } else {
        var local = localBookings(), b = local.find(function (x) { return x.id === id; });
        var next = { accept: 'accepted', decline: 'declined', fulfil: 'fulfilled', confirm: 'refunded', dispute: 'cancelled' }[action];
        if (action === 'confirm') next = 'accepted'; // dev stand-in; the real flow releases escrow
        if (b) { b.status = action === 'confirm' ? 'accepted' : next; saveLocal(local); }
        res = { success: true };
      }
      if (!res.success) notify('❌', 'Could not do that', res.message || 'Try again.');
      window.openMyBookings();
    } catch (e) { notify('❌', 'Error', 'Connection problem. Try again.'); }
  };

  // Tapping Order on a pre-order post opens the booking form instead of the normal checkout
  var _placeOrder = window.placeOrder;
  window.placeOrder = function (postId) {
    var p = typeof state !== 'undefined' && state.posts.find(function (x) { return x.id === postId; });
    if (p && p.isBooking) { window.openBookingModal(postId); return; }
    return _placeOrder(postId);
  };

  // ------------------------------------------------------------------------------------------
  function start() {
    paintStaticTicks();
    window.updateFoodRetentionUI();
    setInterval(window.updateFoodRetentionUI, 2000);   // keeps the notes right after sign-in or verification
    setInterval(window.checkExpirations, 10000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
