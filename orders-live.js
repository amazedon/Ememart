// orders-live.js  (save in the SAME folder as app.html)
// Connects checkout, escrow, wallet balance, transaction list, withdrawals and disputes to the Supabase API.
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

  // ---- 1. a PIN box in the checkout window ---------------------------------------------------
  function addPinBox() {
    var btn = E('place-order-btn');
    if (!btn || E('order-pin')) return;
    var w = document.createElement('div');
    w.className = 'flex flex-col gap-1 mb-2';
    w.innerHTML = '<label class="text-[10px] text-gray-400 font-black">Transaction PIN</label>' +
      '<input id="order-pin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4-digit PIN" ' +
      'class="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-sm text-white">';
    btn.parentNode.insertBefore(w, btn);
  }

  // ---- 2. orders from the server  ->  the order lists the app already draws -------------------
  var STATUS = { held: 'pending', delivered: 'delivered', released: 'completed', disputed: 'delivered' };
  // while the money is held, the seller's progress steps decide what both sides see
  var PREP_TO_LOCAL = { placed: 'pending', accepted: 'accepted', preparing: 'preparing', ready: 'ready', on_the_way: 'ready' };
  function localStatus(o) { return o.status === 'held' ? (PREP_TO_LOCAL[o.prep_status || 'placed'] || 'pending') : STATUS[o.status]; }
  B.orders = [];
  // ---- escrow settings from the admin dashboard (fees and times) -----------------------------
  var CFG = { fee_buyer: 4500, fee_seller: 9000, auto_release_hours: 24, auto_release_hours_food: 24, accept_minutes: 30 };
  B.escrowCfg = CFG;
  function naira(k) { return '\u20A6' + Math.round(Number(k) / 100).toLocaleString('en-NG'); }
  function applyEscrowText() {
    [['fee_buyer', naira(CFG.fee_buyer)], ['fee_seller', naira(CFG.fee_seller)], ['release_hours', String(CFG.auto_release_hours)]].forEach(function (p) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-esc="' + p[0] + '"]'), function (n) { n.textContent = p[1]; });
    });
  }
  window.applyEscrowText = applyEscrowText;
  async function loadEscrowCfg() {
    try {
      var r = await window.sb.from('app_settings').select('value').eq('key', 'escrow').maybeSingle();
      if (r.data && r.data.value) { Object.keys(r.data.value).forEach(function (k) { CFG[k] = r.data.value[k]; }); }
      applyEscrowText();
    } catch (e) {}
  }
  function relHours(o) {
    var food = o && o.item_snapshot && o.item_snapshot.type === 'food';
    return Number(food ? (CFG.auto_release_hours_food || CFG.auto_release_hours) : CFG.auto_release_hours) || 24;
  }
  function fmtLeft(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + p(m) + ':' + p(x) : p(m) + ':' + p(x);
  }
  var _expiredReload = 0;
  setInterval(function () {
    var now = Date.now(), expired = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-accept-by]'), function (n) {
      var left = Number(n.getAttribute('data-accept-by')) - now; n.textContent = fmtLeft(left); if (left <= 0) expired = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-release-at]'), function (n) {
      n.textContent = fmtLeft(Number(n.getAttribute('data-release-at')) - now);
    });
    if (expired && now - _expiredReload > 20000) { _expiredReload = now; setTimeout(function () { loadOrders(); loadWallet(); }, 4000); }
  }, 1000);
  function attachOrders() {
    if (!me() || typeof state === 'undefined') return;
    state.posts.forEach(function (p) { p.orders = []; });
    B.orders.forEach(function (o) {
      if (!STATUS[o.status]) return;                      // refunded / cancelled orders are not shown in the lists
      var post = state.posts.find(function (p) { return p.id === o.post_id; });
      if (!post) return;
      var snap = o.item_snapshot || {};
      var total = (o.amount_kobo + o.fee_buyer_kobo - o.discount_kobo) / 100;
      post.orders.push({
        id: o.id, buyerId: o.buyer_id, buyerName: esc(o.buyer_name || 'Buyer'), buyerLocation: esc(o.delivery_address || ''),
        qty: o.quantity || 1, amount: o.amount_kobo / 100, deliveryFee: (o.delivery_fee_kobo || 0) / 100, total: total,
        note: esc(o.note || ''), escrow: true, status: localStatus(o), prepStatus: o.prep_status || 'placed', hasRider: !!o.rider_id, escrowFrozen: o.status === 'disputed',
        ts: new Date(o.created_at).getTime(), postId: post.id, foodName: esc(snap.title || post.foodName || ''),
        vendorId: o.seller_id, vendorName: esc(o.seller_name || ''), serverStatus: o.status,
        acceptBy: (!o.accepted_at && o.accept_by && o.status === 'held') ? new Date(o.accept_by).getTime() : 0,
        deliverBy: o.deliver_by ? new Date(o.deliver_by).getTime() : 0,
        autoReleaseAt: o.auto_release_at ? new Date(o.auto_release_at).getTime() : 0,
        deliveryCode: o.delivery_code || '', deliveryStatus: o.delivery_status || '',
      });
    });
    try { renderVendorPortalOrders(); } catch (e) {}
    try { renderMyOrders(); } catch (e) {}
    try { renderBuyerOrders(); } catch (e) {}
  }
  async function loadOrders() {
    if (!me()) return;
    var r = await api('GET', '/orders');
    if (r.success) { B.orders = r.orders || []; attachOrders(); }
  }
  B.reloadOrders = loadOrders;

  // ---- 3. wallet balance + transactions ------------------------------------------------------
  var KIND = {
    funding: 'Wallet funded', withdrawal: 'Withdrawal', withdrawal_reversal: 'Withdrawal returned', escrow_hold: 'Order payment (held)',
    escrow_release: 'Escrow released', escrow_refund: 'Order refunded', fee: 'Fee', boost: 'Boost', tier: 'Vendor plan',
    vtu: 'Airtime / data', vtu_refund: 'Airtime / data refund', adjustment: 'Adjustment',
  };
  async function loadWallet() {
    var u = me(); if (!u) return;
    var r = await api('GET', '/wallet');
    if (!r.success) return;
    u.balance = Number(r.balance_kobo || 0) / 100; u.wallet_balance = u.balance;
    B.limits = r.limits;
    state.transactions = (r.entries || []).map(function (e) {
      var amt = Number(e.amount_kobo);
      return { id: 'led-' + e.id, type: amt >= 0 ? 'credit' : 'debit', category: e.kind, userId: u.id,
               amount: Math.abs(amt) / 100, desc: (e.meta && e.meta.title) || KIND[e.kind] || e.kind, meta: e.meta || null, ts: new Date(e.created_at).getTime(),
               ref: e.ref || '', seq: e.id, balanceAfter: e.balance_after == null ? null : Number(e.balance_after) / 100 };
    });
    try { syncAccountDisplay(); } catch (e) {}
    try { renderTxnList(); } catch (e) {}
  }
  B.reloadWallet = loadWallet;

  // ---- 4. checkout ---------------------------------------------------------------------------
  window.confirmPlaceOrder = async function () {
    var u = me();
    var post = state.posts.find(function (p) { return p.id === _activeOrderPostId; });
    if (!post || !u) return;
    var address = E('order-address').value.trim();
    if (!address) { toast('⚠️', 'Address Required', 'Please enter your delivery address.'); E('order-address').classList.add('error'); return; }
    E('order-address').classList.remove('error');
    var pin = (E('order-pin') || {}).value || '';
    if (!/^\d{4}$/.test(pin)) { toast('⚠️', 'PIN Required', 'Enter your 4-digit transaction PIN.'); return; }
    var btn = E('place-order-btn'); var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Placing order...'; }
    var r = await api('POST', '/orders', {
      post_id: post.id, quantity: _activeOrderQty, pin: pin, delivery_fee_kobo: Math.round((window.postDeliveryFee ? window.postDeliveryFee(post) : 200) * 100),
      address: address, note: E('order-note').value.trim() || undefined,
    });
    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (!r.success) { toast('❌', 'Order not placed', r.message || 'Please try again.'); return; }
    if (E('order-pin')) E('order-pin').value = '';
    u.balance = Number(r.balance_kobo) / 100; u.wallet_balance = u.balance;
    E('order-checkout-modal').classList.add('hidden');

    var unit = post.flashSale ? post.flashPrice : post.price;
    window._escrowOrderId = r.id; window._escrowPostId = post.id;
    var set = function (id, v) { var n = E(id); if (n) n.textContent = v; };
    set('conf-order-id', '#' + String(r.id).slice(0, 8).toUpperCase());
    set('conf-food-name', post.foodName || 'Item');
    set('conf-vendor-name', post.authorName);
    set('conf-qty', String(_activeOrderQty));
    set('conf-address', address);
    set('conf-escrow', '🔐 Escrow');
    set('conf-amount', '₦' + fmt(unit * _activeOrderQty + (window.postDeliveryFee ? window.postDeliveryFee(post) : 200)));
    set('conf-balance', '₦' + fmt(u.balance));
    set('conf-time', new Date().toLocaleString());
    set('escrow-held-amount', '₦' + fmt(unit * _activeOrderQty + (window.postDeliveryFee ? window.postDeliveryFee(post) : 200)));
    var panel = E('conf-escrow-panel'); if (panel) panel.classList.remove('hidden');
    E('escrow-confirm-section') && E('escrow-confirm-section').classList.remove('hidden');
    E('escrow-released-section') && E('escrow-released-section').classList.add('hidden');
    E('order-confirmation-modal').classList.remove('hidden');
    try { syncAccountDisplay(); } catch (e) {}
    loadOrders(); loadWallet();
    if (B.reloadPosts) B.reloadPosts();
  };

  // ---- 5. escrow: no demo timers; the server holds, releases and auto-releases --------------
  window.autoReleaseEscrow = function () {};
  window.startEscrowCountdown = function () { var c = E('escrow-countdown'); if (c) c.textContent = 'auto-release ' + CFG.auto_release_hours + 'h after delivery'; };
  window.registerEscrow = function () {};

  window.confirmEscrowDelivery = async function () {
    var oid = window._escrowOrderId; if (!oid) return;
    var r = await api('POST', '/orders/' + oid + '/confirm');
    if (!r.success) { toast('❌', 'Could not release', r.message || 'Please try again.'); return; }
    E('escrow-confirm-section') && E('escrow-confirm-section').classList.add('hidden');
    E('escrow-released-section') && E('escrow-released-section').classList.remove('hidden');
    var m = E('escrow-released-msg'); if (m) m.textContent = 'Payment released to the seller. Thank you!';
    toast('✅', 'Payment released', 'The seller has been paid.');
    loadOrders(); loadWallet();
  };

  // the seller's buttons
  window.advanceOrderStatus = async function (postId, orderId) {
    var o = B.orders.find(function (x) { return x.id === orderId; });
    if (!o) return;
    var cur = o.prep_status || 'placed';
    var next = { placed: 'accepted', accepted: 'preparing', preparing: 'ready', ready: 'on_the_way' }[cur];
    var msg = { accepted: 'Order accepted', preparing: 'Preparing the order', ready: 'Order is ready', on_the_way: 'On the way to the customer' };
    try {
      if (cur === 'on_the_way' || (cur === 'ready' && o.rider_id && o.delivery_status === 'delivered')) next = null;
      if (!next) {
        var d = await api('POST', '/orders/' + orderId + '/deliver');
        if (d && d.success === false) { toast('❌', 'Not updated', d.message || 'Please try again.'); return; }
        toast('🏍️', 'Marked delivered', 'The buyer has been asked to confirm. Payment auto-releases in ' + relHours(o) + ' hours.');
      } else if (cur === 'ready' && o.rider_id) {
        toast('ℹ️', 'Waiting for the rider', 'A rider is assigned and will collect this order.'); return;
      } else {
        var r = await api('POST', '/orders/' + orderId + '/progress', { step: next });
        if (r && r.success === false) { toast('❌', 'Not updated', r.message || 'Please try again.'); return; }
        toast('✅', msg[next], 'The customer was notified.');
      }
    } catch (e) { toast('❌', 'Not updated', (e && e.message) || 'Please try again.'); return; }
    loadOrders();
  };

  // ---- tracking timeline built from the real order ----------------------------------------
  var _gtr = window.getTrackingRecord;
  window.getTrackingRecord = function (orderId) {
    var o = (B.orders || []).find(function (x) { return x.id === orderId; });
    if (!o) return _gtr ? _gtr(orderId) : null;
    var snap = o.item_snapshot || {};
    var cur = 'placed';
    if (o.status === 'delivered' || o.status === 'released' || o.delivery_status === 'delivered') cur = 'delivered';
    else if (o.delivery_status === 'on_the_way' || o.prep_status === 'on_the_way') cur = 'on_the_way';
    else if (o.delivery_status === 'picked_up') cur = 'picked_up';
    else cur = o.prep_status || 'placed';
    var tl = [{ step: 'placed', ts: new Date(o.created_at).getTime(), note: '' }];
    (Array.isArray(o.prep_log) ? o.prep_log : []).forEach(function (l) { tl.push({ step: l.step, ts: new Date(l.ts).getTime(), note: '' }); });
    if (o.rider_delivered_at) tl.push({ step: 'delivered', ts: new Date(o.rider_delivered_at).getTime(), note: '' });
    else if (o.delivered_at) tl.push({ step: 'delivered', ts: new Date(o.delivered_at).getTime(), note: '' });
    return {
      orderId: o.id, currentStep: cur, timeline: tl, etaTime: cur === 'on_the_way' ? 'Arriving soon' : 'Updating live',
      riderName: o.rider_id ? 'Your rider' : (o.seller_name || 'Partner'), riderRating: '', distanceKm: '',
      foodName: snap.title || 'Order', vendorName: o.seller_name || '', deliveryAddr: o.delivery_address || '', amount: (o.amount_kobo || 0) / 100
    };
  };
  // keep an open tracking window fresh
  setInterval(function () {
    var m = E('order-tracking-modal');
    if (m && !m.classList.contains('hidden')) { loadOrders().then(function () { try { renderOrderTrackingModal(window._trackingOrderId || _trackingOrderId); } catch (e) {} }); }
  }, 15000);
  window.releaseEscrow = function (postId, orderId) {
    toast('ℹ️', 'Waiting for the buyer', 'The buyer confirms delivery to release payment, or it releases automatically ' + CFG.auto_release_hours + ' hours after you mark it delivered.');
  };
  window.declineOrderAsSeller = async function (orderId) {
    if (!(await uiConfirm('Decline this order? The customer will be refunded.'))) return;
    var r = await api('POST', '/orders/' + orderId + '/decline');
    if (!r.success) { toast('❌', 'Not declined', r.message || 'Please try again.'); return; }
    toast('✅', 'Order declined', 'The customer was refunded.'); loadOrders();
  };
  window.cancelOrderAsSeller = async function (orderId) {
    if (!(await uiConfirm('Cancel this order and refund the buyer?'))) return;
    var r = await api('POST', '/orders/' + orderId + '/cancel');
    if (!r.success) { toast('❌', 'Not cancelled', r.message || ''); return; }
    toast('✅', 'Order cancelled', 'The buyer was refunded.'); loadOrders();
  };

  // ---- delivery code: the Partner or Rider types the Customer's 6-digit code, and the payment is released ----
  var _handoverId = null;
  window.openHandover = function (id) {
    _handoverId = id;
    var i = E('delivery-code-input'); if (i) i.value = '';
    var m = E('delivery-code-modal'); if (m) m.classList.remove('hidden');
  };
  var _origOpenCode = window.openDeliveryCodeModal;
  window.openDeliveryCodeModal = function () { _handoverId = null; return _origOpenCode && _origOpenCode.apply(this, arguments); };
  var _origConfirmCode = window.confirmDeliveryCode;
  window.confirmDeliveryCode = async function () {
    if (!_handoverId) return _origConfirmCode && _origConfirmCode.apply(this, arguments);
    var code = String((E('delivery-code-input') || {}).value || '').replace(/\D/g, '');
    if (code.length !== 6) { toast('⚠️', 'Enter the code', 'The delivery code has 6 digits.'); return; }
    var r = await api('POST', '/orders/' + _handoverId + '/handover', { code: code });
    if (!r.success) { toast('❌', 'Not confirmed', r.message || 'Please try again.'); return; }
    var m = E('delivery-code-modal'); if (m) m.classList.add('hidden');
    _handoverId = null;
    toast('✅', 'Delivered', 'The code is correct. Payment has been released.');
    loadOrders(); loadWallet();
    try { renderRiderActiveDeliveries(); } catch (e) {}
  };

  // ---- 6. disputes: submitting the form also opens a real dispute on the server --------------
  var _submitDispute = window.submitDispute;
  window.submitDispute = async function () {
    var sel = E('dispute-order-select'), desc = E('dispute-desc');
    var val = sel ? sel.value : '', reason = desc ? desc.value.trim() : '';
    if (!val) { toast('⚠️', 'Choose an order', 'Pick the order you want to dispute.'); return; }
    if (reason.length < 10) { toast('⚠️', 'Add details', 'Describe the problem in at least 10 characters.'); return; }
    var r = await api('POST', '/orders/' + val.split('||')[1] + '/dispute', { reason: reason });
    if (!r.success) { toast('❌', 'Dispute not sent', r.message || 'Please try again.'); return; }
    toast('⚖️', 'Dispute opened', 'Payment is frozen until support reviews it.');
    loadOrders();
    try { _submitDispute && _submitDispute.apply(this, arguments); } catch (e) {}
  };

  // ---- 7. wallet screens: banks, withdrawal, balance -----------------------------------------
  var _oldPost = window.apiPost;
  window.apiPost = async function (file, action, data) {
    data = data || {};
    if (file === 'wallet.php') {
      if (action === 'get_banks') {
        var rb = await api('GET', '/wallet/banks');
        return rb.success ? { success: true, banks: rb.banks || [] } : { success: false, message: rb.message || 'Could not load banks' };
      }
      if (action === 'withdraw') {
        var r = await api('POST', '/wallet/withdraw', {
          amount_kobo: Math.round(Number(data.amount) * 100), bank_code: data.bank_code,
          account_number: data.account_no, pin: (E('withdraw-pin') || {}).value || '',
        });
        if (r.success) {
          await loadWallet();
          return { success: true, new_balance: String(me() ? me().balance : 0), message: r.status === 'success' ? 'Money sent to your bank.' : 'Transfer is being processed.' };
        }
        return r;
      }
      if (action === 'transfer') return { success: false, message: 'Sending money to another Ememart wallet is not available yet.' };
      if (action === 'balance') { await loadWallet(); return { success: true, balance: me() ? me().balance : 0 }; }
    }
    return _oldPost.apply(this, arguments);
  };

  // The account name is not typed by the person. We ask the bank (through Squad) who owns the account
  // and fill it in, so it can never be mistyped and money only goes to the account that was checked.
  var _lkSeq = 0;
  function lkStatus(msg, bad) {
    var n = E('withdraw-lookup-status');
    if (!n) {
      var box = E('withdraw-account-name'); if (!box) return;
      n = document.createElement('div'); n.id = 'withdraw-lookup-status'; n.style.cssText = 'font-size:11px;margin-top:4px';
      box.parentNode.appendChild(n);
    }
    n.textContent = msg || ''; n.style.color = bad ? '#f87171' : '#9ca3af';
  }
  async function lookupWithdrawAccount() {
    var noEl = E('withdraw-account-no'), nameEl = E('withdraw-account-name'), bankEl = E('withdraw-bank');
    if (!noEl || !nameEl) return;
    nameEl.readOnly = true; nameEl.placeholder = 'Filled in automatically from your bank';
    var no = (noEl.value || '').trim(), bank = bankEl ? bankEl.value : '';
    nameEl.value = '';
    if (!/^\d{10}$/.test(no)) { lkStatus(''); return; }
    if (!bank) { lkStatus('Choose your bank first.', true); return; }
    var mine = ++_lkSeq;
    lkStatus('Checking account...');
    var r = await api('POST', '/wallet/lookup', { bank_code: bank, account_number: no });
    if (mine !== _lkSeq) return;           // a newer check is running
    if (r.success && r.account_name) { nameEl.value = r.account_name; lkStatus('Account found. Check the name is yours.'); }
    else lkStatus(r.message || 'Could not verify that account. Check the bank and number.', true);
  }
  document.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'withdraw-account-no') lookupWithdrawAccount(); });
  document.addEventListener('change', function (ev) { if (ev.target && ev.target.id === 'withdraw-bank') lookupWithdrawAccount(); });
  document.addEventListener('focusin', function (ev) { if (ev.target && ev.target.id === 'withdraw-account-name') { ev.target.readOnly = true; ev.target.placeholder = 'Filled in automatically from your bank'; } });

  // ---- 8. coming back from the Squad payment page --------------------------------------------
  function afterFunding() {
    var tries = 0;
    var t = setInterval(function () { loadWallet(); if (++tries >= 8) clearInterval(t); }, 4000);
  }
  if (/[?&](funded|reference|status)=/.test(location.search)) afterFunding();

  // ---- start + refresh -----------------------------------------------------------------------
  function start() {
    addPinBox();
    var _open = window.placeOrder;
    window.placeOrder = function () { addPinBox(); return _open.apply(this, arguments); };
    loadWallet(); loadOrders(); loadEscrowCfg();
  }
  window.addEventListener('load', function () { setTimeout(start, 800); });
  setInterval(function () { if (!document.hidden && me()) { loadOrders(); loadWallet(); } }, 30000);
  var _reload = B.reloadPosts;
  if (_reload) B.reloadPosts = async function () { await _reload(); attachOrders(); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden && me()) { loadOrders(); loadWallet(); } });

  // ---- 9. boosts and vendor plans: paid from the real wallet ---------------------------------
  async function askPin(title) {
    var v = await uiPrompt(title + '\nEnter your 4-digit transaction PIN', { type: 'password', numeric: true, maxLength: 4, ok: 'Confirm' });
    if (v == null) return null;
    if (!/^\d{4}$/.test(v)) { toast('⚠️', 'PIN Required', 'Enter exactly 4 digits.'); return null; }
    return v;
  }
  async function refreshMe() {
    try { var s = await window.buildSession(); if (s) { state.session = Object.assign(state.session || {}, s); try { saveState(); } catch (e) {} syncAccountDisplay(); } } catch (e) {}
  }
  window.confirmBoost = async function () {
    if (!_boostPostId || !_boostHours) { toast('⚠️', 'Select Plan', 'Please select a boost duration first.'); return; }
    var pin = await askPin('Boost for ' + _boostHours + ' hours'); if (!pin) return;
    var r = await api('POST', '/boosts', { post_id: _boostPostId, hours: _boostHours, pin: pin });
    if (!r || r.success === false || r.error) { toast('❌', 'Boost failed', (r && (r.message || r.error)) || 'Try again.'); return; }
    E('boost-modal').classList.add('hidden');
    _boostPostId = null; _boostHours = 0; _boostFee = 0;
    toast('⭐', 'Post Boosted!', 'Your post now appears at the top of the feed.');
    if (B.reloadPosts) B.reloadPosts(); loadWallet(); refreshMe();
  };
  window.confirmVendorTierUpgrade = async function (tierKey) {
    var pin = tierKey === 'free' ? '' : await askPin('Switch to the ' + tierKey + ' plan'); if (tierKey !== 'free' && !pin) return;
    var r = await api('POST', '/tier', { tier: tierKey, pin: pin || '0000' });
    if (!r || r.success === false || r.error) { toast('❌', 'Plan not changed', (r && (r.message || r.error)) || 'Try again.'); return; }
    E('vendor-tier-modal').classList.add('hidden');
    toast('✅', 'Plan updated', 'You are now on the ' + tierKey + ' plan.');
    await refreshMe(); loadWallet();
    try { renderVendorTierInfo(); renderFeed(); } catch (e) {}
  };
  window.confirmVendorTierDowngrade = function (k) { return window.confirmVendorTierUpgrade(k); };

  // ---- 10. features that are not on the server yet: stop them from changing money locally ---
  function notYet(name) { toast('ℹ️', name, 'This feature is not available yet.'); }
  window.initializeSplitPayment = function () { notYet('Group split'); };
  // The Customer can cancel until the Partner accepts. The server refunds in full.
  window.cancelOrder = async function (postId, orderId) {
    if (!(await uiConfirm('Cancel this order? Your money goes back to your wallet in full.'))) return;
    var r = await api('POST', '/orders/' + orderId + '/cancel');
    if (!r.success) { toast('❌', 'Not cancelled', r.message || 'Please try again.'); return; }
    toast('✅', 'Order cancelled', 'Your money is back in your wallet.'); loadOrders();
  };
  window.updateDeliveryStatus = function () { notYet('Rider deliveries'); };
})();
