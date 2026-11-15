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
  var STATUS = { held: 'ready', delivered: 'delivered', released: 'completed', disputed: 'delivered' };
  B.orders = [];
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
        note: esc(o.note || ''), escrow: true, status: STATUS[o.status], escrowFrozen: o.status === 'disputed',
        ts: new Date(o.created_at).getTime(), postId: post.id, foodName: esc(snap.title || post.foodName || ''),
        vendorId: o.seller_id, vendorName: esc(o.seller_name || ''), serverStatus: o.status,
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
               amount: Math.abs(amt) / 100, desc: KIND[e.kind] || e.kind, ts: new Date(e.created_at).getTime() };
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
      post_id: post.id, quantity: _activeOrderQty, pin: pin, delivery_fee_kobo: 20000,
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
    set('conf-amount', '₦' + fmt(unit * _activeOrderQty + 200));
    set('conf-balance', '₦' + fmt(u.balance));
    set('conf-time', new Date().toLocaleString());
    set('escrow-held-amount', '₦' + fmt(unit * _activeOrderQty + 200));
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
  window.startEscrowCountdown = function () { var c = E('escrow-countdown'); if (c) c.textContent = 'auto-release 48h after delivery'; };
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
    var r = await api('POST', '/orders/' + orderId + '/deliver');
    if (!r.success) { toast('❌', 'Not updated', r.message || 'Please try again.'); return; }
    toast('🏍️', 'Marked delivered', 'The buyer has been asked to confirm. Payment auto-releases in 48 hours.');
    loadOrders();
  };
  window.releaseEscrow = function (postId, orderId) {
    toast('ℹ️', 'Waiting for the buyer', 'The buyer confirms delivery to release payment, or it releases automatically 48 hours after you mark it delivered.');
  };
  window.cancelOrderAsSeller = async function (orderId) {
    if (!confirm('Cancel this order and refund the buyer?')) return;
    var r = await api('POST', '/orders/' + orderId + '/cancel');
    if (!r.success) { toast('❌', 'Not cancelled', r.message || ''); return; }
    toast('✅', 'Order cancelled', 'The buyer was refunded.'); loadOrders();
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

  // when the user taps the account-name box on the withdraw form we look the account up
  document.addEventListener('input', async function (ev) {
    if (!ev.target || ev.target.id !== 'withdraw-account-no') return;
    var no = ev.target.value.trim(), bank = (E('withdraw-bank') || {}).value;
    if (!/^\d{10}$/.test(no) || !bank) return;
    var r = await api('POST', '/wallet/lookup', { bank_code: bank, account_number: no });
    if (r.success && r.account_name && E('withdraw-account-name')) E('withdraw-account-name').value = r.account_name;
  });

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
    loadWallet(); loadOrders();
  }
  window.addEventListener('load', function () { setTimeout(start, 800); });
  setInterval(function () { if (!document.hidden && me()) { loadOrders(); loadWallet(); } }, 30000);
  var _reload = B.reloadPosts;
  if (_reload) B.reloadPosts = async function () { await _reload(); attachOrders(); };
  document.addEventListener('visibilitychange', function () { if (!document.hidden && me()) { loadOrders(); loadWallet(); } });

  // ---- 9. boosts and vendor plans: paid from the real wallet ---------------------------------
  function askPin(title) {
    var v = window.prompt(title + '\nEnter your 4-digit transaction PIN');
    if (v == null) return null;
    if (!/^\d{4}$/.test(v)) { toast('⚠️', 'PIN Required', 'Enter exactly 4 digits.'); return null; }
    return v;
  }
  async function refreshMe() {
    try { var s = await window.buildSession(); if (s) { state.session = Object.assign(state.session || {}, s); try { saveState(); } catch (e) {} syncAccountDisplay(); } } catch (e) {}
  }
  window.confirmBoost = async function () {
    if (!_boostPostId || !_boostHours) { toast('⚠️', 'Select Plan', 'Please select a boost duration first.'); return; }
    var pin = askPin('Boost for ' + _boostHours + ' hours'); if (!pin) return;
    var r = await api('POST', '/boosts', { post_id: _boostPostId, hours: _boostHours, pin: pin });
    if (!r || r.success === false || r.error) { toast('❌', 'Boost failed', (r && (r.message || r.error)) || 'Try again.'); return; }
    E('boost-modal').classList.add('hidden');
    _boostPostId = null; _boostHours = 0; _boostFee = 0;
    toast('⭐', 'Post Boosted!', 'Your post now appears at the top of the feed.');
    if (B.reloadPosts) B.reloadPosts(); loadWallet(); refreshMe();
  };
  window.confirmVendorTierUpgrade = async function (tierKey) {
    var pin = tierKey === 'free' ? '' : askPin('Switch to the ' + tierKey + ' plan'); if (tierKey !== 'free' && !pin) return;
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
  window.cancelOrder = function () { toast('ℹ️', 'Cancel order', 'Ask the seller to cancel. You will be refunded to your wallet automatically.'); };
  window.updateDeliveryStatus = function () { notYet('Rider deliveries'); };
})();
