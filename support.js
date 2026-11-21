// support.js  (save in the SAME folder as app.html)
// Help Center: quick FAQ chips and live chat with the Ememart team in one window, plus email and WhatsApp.
// Live chat works when backend.js is in live mode. The FAQ and contact options always work.
(function () {
  'use strict';

  // ---- contact details: change these two lines if they change ---------------------------------
  // These are the defaults. The real values are set in the admin dashboard (Live chat tab, Contact details).
  var C = { email: 'help@ememart.com', whatsapp: '', reply_note: 'We reply within minutes.' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function toast(i, t, m) { try { showPopupNotif(i, t, m); } catch (e) {} }
  function user() { return typeof state !== 'undefined' && state.session ? state.session : null; }
  function live() { var B = window.EMEMART_BACKEND; return !!(B && B.mode === 'live' && window.callApi && window.sb); }
  function naira(kobo) { return '₦' + Math.round(Number(kobo) / 100).toLocaleString('en-NG'); }

  // ---- live numbers from the app settings (fees, limits, prices) --------------------------------
  var S = {
    support_contact: C,
    escrow: { fee_buyer: 4500, fee_seller: 9000, auto_release_hours: 48, first_order_discount: 50000 },
    wallet_limits: {
      unverified: { max_balance: 10000000, daily_funding: 5000000, daily_withdrawal: 2000000 },
      verified: { max_balance: 100000000, daily_funding: 50000000, daily_withdrawal: 30000000 }
    },
    boost_prices: { '6': 50000, '12': 90000, '24': 150000, '72': 350000 },
    vendor_tiers: { free: 0, pro: 500000, premium: 1500000 }
  };
  var settingsLoaded = false;
  async function loadSettings() {
    if (settingsLoaded || !window.sb) return;
    settingsLoaded = true;
    try {
      var r = await window.sb.from('app_settings').select('key,value').in('key', Object.keys(S));
      (r.data || []).forEach(function (x) {
        if (x.key === 'support_contact' && x.value) { C.email = x.value.email || C.email; C.whatsapp = String(x.value.whatsapp || '').replace(/\D/g, ''); C.reply_note = x.value.reply_note != null ? x.value.reply_note : C.reply_note; }
        else if (S[x.key] && x.value) S[x.key] = x.value;
      });
      applyContact(); buildFaq();
    } catch (e) {}
  }

  // ---- FAQ ---------------------------------------------------------------------------------------
  function faqData() {
    var e = S.escrow, wl = S.wallet_limits, bp = S.boost_prices, vt = S.vendor_tiers;
    return [
      { cat: 'Getting started', items: [
        ['What is Ememart?', 'Ememart is a local marketplace in Nigeria. Customers buy food from Stores, hire Artisans and book Riders near them. Every payment is protected by escrow.'],
        ['Who are Partners and Customers?', 'Customers buy on Ememart. Partners sell or work on Ememart. A Store sells food, an Artisan offers a skill or service, and a Rider delivers orders.'],
        ['Do I need an account to browse?', 'No. You can browse posts without an account. You need an account to order, message a Partner, use your wallet or chat with support.'],
        ['How do I become a Store, Artisan or Rider?', 'Go to Account, then Account Role, and choose the role you want. Artisans and Riders send a request that our team reviews. Stores post food only.']
      ] },
      { cat: 'Escrow and payments', items: [
        ['How does escrow work?', 'When you pay, Ememart holds your money safely. The Partner is paid only after you confirm the order. Escrow is always on for every order, so Partners cannot turn it off.'],
        ['When is the money released to the Partner?', 'When you tap Confirm. If the Partner marks the order as delivered and you do nothing, the money is released automatically after ' + e.auto_release_hours + ' hours. If there is a problem, open a dispute before then.'],
        ['What fees do I pay?', 'Customers pay ' + naira(e.fee_buyer) + ' per escrow order. Partners pay ' + naira(e.fee_seller) + ' per order on the Free plan. Premium Partners pay no escrow fee. The delivery fee is set by the Partner and shown on the post.'],
        ['Is there a discount on my first order?', 'Yes. Your first order gets ' + naira(e.first_order_discount) + ' off.'],
        ['How do I add money to my wallet?', 'Go to Account, then Wallet, and tap Fund wallet. You pay securely through Squad and the money appears in your wallet when the payment is confirmed.']
      ] },
      { cat: 'Orders and food', items: [
        ['How long does a food post stay open?', 'Food posts close to new orders 8 hours after they are posted and show a Closed label. They disappear 24 hours after posting. The time left is counting down on each post.'],
        ['How do I track my order?', 'Open the order in Account, then My Orders. You see each step as the Partner updates it: accepted, preparing, ready and on the way.'],
        ['Who sets the delivery fee?', 'The Partner sets it on each post. Pickup-only posts have no delivery fee.'],
        ['My order never arrived. What do I do?', 'Message the Partner first. If you cannot sort it out, go to Safety, then Escrow Disputes, and open a dispute on that order. Your money stays in escrow until the dispute is decided.'],
        ['Can I cancel an order?', 'Only the Partner can cancel an order. If the Partner cancels, your money returns to your wallet. If you want out of an order, message the Partner or open a dispute.']
      ] },
      { cat: 'Refunds and disputes', items: [
        ['How do I open a dispute?', 'Go to Safety, then Escrow Disputes, then open a new dispute. Choose the order, give the reason and add photos as evidence.'],
        ['What happens after I open a dispute?', 'The money stays held in escrow. You and the Partner can both send messages and photos in the dispute. Our support team reads everything and decides. You get a notification and an email with the decision.'],
        ['Can I withdraw a dispute?', 'Yes, if you opened it and support has not started reviewing it. Open the dispute and tap Withdraw. The order then continues as normal.'],
        ['Where does my refund go?', 'Approved refunds go back to your Ememart wallet. You can use the money on your next order or withdraw it to your bank.']
      ] },
      { cat: 'Wallet and withdrawals', items: [
        ['How do I withdraw money?', 'Go to Account, then Wallet, then Withdraw. Choose your bank, enter your account number and the amount, then confirm with your transaction PIN. Your withdrawal history shows every request.'],
        ['What are the wallet limits?', 'Unverified accounts can hold up to ' + naira(wl.unverified.max_balance) + ', add up to ' + naira(wl.unverified.daily_funding) + ' a day and withdraw up to ' + naira(wl.unverified.daily_withdrawal) + ' a day. Verified accounts can hold up to ' + naira(wl.verified.max_balance) + ', add up to ' + naira(wl.verified.daily_funding) + ' a day and withdraw up to ' + naira(wl.verified.daily_withdrawal) + ' a day.'],
        ['I forgot my transaction PIN or it is locked.', 'After 5 wrong PIN attempts the PIN locks for 15 minutes. Wait, then try again. If you still cannot get in, start a live chat with support.'],
        ['Is wallet funding and withdrawal available outside Nigeria?', 'No. Funding and withdrawals work in Nigeria only. The app can be downloaded anywhere.']
      ] },
      { cat: 'Verification and the blue tick', items: [
        ['How do I get verified?', 'Go to Account, then Get Verified. Individuals send their NIN. Registered businesses send their CAC certificate. Our team checks each request by hand.'],
        ['What do I get when I am verified?', 'A blue tick on your profile and posts, and higher wallet limits. Verified Stores can also choose to leave a food post open instead of removing it after 8 hours.'],
        ['Do I have to be verified to sell?', 'No. Anyone can sell without verification. Riders can use the app unverified too. Verification builds trust and raises your limits.']
      ] },
      { cat: 'Posting, boosts and plans', items: [
        ['What can I post?', 'Photos and written details only. Videos are not allowed. Every post is removed automatically after 30 days. You get a warning 3 days and 1 day before.'],
        ['What are the plans?', 'Free: up to 5 active posts. Pro (' + naira(vt.pro) + ' a month): unlimited posts, advanced analytics and 50% off boosts. Premium (' + naira(vt.premium) + ' a month): everything in Pro with no escrow fee and priority placement.'],
        ['How does boosting work?', 'A boost puts your post higher in the feed for a set time. ' + [['6', '6 hours'], ['12', '12 hours'], ['24', '24 hours'], ['72', '3 days']].filter(function (x) { return bp[x[0]]; }).map(function (x) { return x[1] + ': ' + naira(bp[x[0]]); }).join(', ') + '. You pay from your wallet.'],
        ['Can customers rate me?', 'Yes. After a completed order the customer leaves a star rating and a written comment. You can reply once to each review.']
      ] },
      { cat: 'Safety and your account', items: [
        ['What is the SOS button?', 'In Safety, the Panic Wire sends an alert with your location for an emergency. Use it only in a real emergency. In Nigeria you can also call 112.'],
        ['How do I report a Partner or a post?', 'Open the post and tap the flag icon. For a problem with an order, open a dispute instead.'],
        ['How do I turn on notifications?', 'Go to Account, then Notifications, and allow notifications in your browser or phone. You get alerts for orders, messages, disputes and money.'],
        ['How do I delete my account?', 'Go to Account and tap Delete account at the bottom of the settings. Some records, such as payments and disputes, are kept for the time the law requires. Our Privacy Policy explains what we keep.']
      ] }
    ];
  }

  // ---- screen ------------------------------------------------------------------------------------
  var QUICK = [
    ['How escrow works', 'How does escrow work?'],
    ['Get a refund', 'Where does my refund go?'],
    ['Withdraw funds', 'How do I withdraw money?'],
    ['Verification', 'How do I get verified?'],
    ['Order not arrived', 'My order never arrived. What do I do?'],
    ['Fees', 'What fees do I pay?'],
    ['Food hours', 'How long does a food post stay open?'],
    ['Become a Partner', 'How do I become a Store, Artisan or Rider?']
  ];
  var showAll = false;
  function findAnswer(q) {
    var out = null;
    faqData().forEach(function (d) { d.items.forEach(function (it) { if (it[0] === q) out = it[1]; }); });
    return out;
  }
  function buildChips() {
    var box = $('help-chips'); if (!box) return;
    var chip = function (label, q) { return '<button type="button" data-q="' + esc(q) + '" class="filter-pill text-[10px] py-1.5 px-3 text-left">' + esc(label) + '</button>'; };
    var html = QUICK.map(function (x) { return chip(x[0], x[1]); }).join('');
    html += '<button type="button" id="help-more" class="filter-pill text-[10px] py-1.5 px-3 font-black" style="color:#059669">' + (showAll ? 'Fewer questions' : 'More questions') + '</button>';
    if (showAll) {
      var quick = QUICK.map(function (x) { return x[1]; });
      faqData().forEach(function (d) {
        var rest = d.items.filter(function (it) { return quick.indexOf(it[0]) < 0; });
        if (!rest.length) return;
        html += '<div class="w-full text-[10px] font-black text-gray-500 uppercase tracking-wider mt-2">' + esc(d.cat) + '</div>' +
          rest.map(function (it) { return chip(it[0], it[0]); }).join('');
      });
    }
    box.innerHTML = html;
  }
  function buildFaq() { buildChips(); render(); } // called again when live numbers arrive

  var mailIco = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5z"/></svg>';
  var waIco = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2z"/></svg>';

  function buildScreen() {
    var host = $('ssub-support'); if (!host || host.dataset.helpReady) return;
    host.dataset.helpReady = '1';
    host.className = 'hidden flex-col gap-3 fade-up';
    host.innerHTML =
      '<div class="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">' +
        '<div class="p-3">' +
          '<div class="text-[10px] font-black text-gray-500 uppercase tracking-wider mb-2">Quick FAQ</div>' +
          '<div id="help-chips" class="flex flex-wrap gap-1.5" style="max-height:190px;overflow-y:auto"></div>' +
        '</div>' +
        '<div class="border-t border-gray-800"></div>' +
        '<div id="help-msgs" class="p-3 flex flex-col gap-2 overflow-y-auto" style="height:min(48vh,380px)"></div>' +
        '<div class="p-2 border-t border-gray-800 flex gap-2">' +
          '<input id="help-inp" type="text" maxlength="2000" placeholder="Message Ememart Support" class="inp flex-1 py-2 text-xs" autocomplete="off">' +
          '<button type="button" id="help-send" class="btn-sm-primary px-4">Send</button>' +
        '</div>' +
        '<div class="px-3 pb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] font-black" style="color:#059669">' +
          '<a id="help-mail" href="#" style="text-decoration:none;color:inherit;display:inline-flex;align-items:center;gap:4px">' + mailIco + 'Email us</a>' +
          '<button type="button" id="help-wa" class="hidden" style="color:inherit;align-items:center;gap:4px">' + waIco + 'WhatsApp</button>' +
          '<button type="button" id="help-chat-end" class="hidden text-red-400">End chat</button>' +
        '</div>' +
      '</div>';
    $('help-chips').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.id === 'help-more') { showAll = !showAll; buildChips(); return; }
      if (b.dataset.q) askFaq(b.dataset.q);
    });
    $('help-chat-end').onclick = endChat;
    $('help-send').onclick = sendMsg;
    $('help-inp').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendMsg(); });
    $('help-wa').onclick = function () {
      var u = user();
      window.open('https://wa.me/' + C.whatsapp + '?text=' + encodeURIComponent('Hello Ememart Support. My name is ' + (u ? u.name || '' : '') + '.'), '_blank');
    };
    applyContact();
    buildChips(); render();
  }

  function applyContact() {
    var wa = $('help-wa'); if (!wa) return;
    var has = C.whatsapp.length >= 8;
    wa.classList.toggle('hidden', !has); wa.style.display = has ? 'inline-flex' : '';
    $('help-mail').href = 'mailto:' + C.email;
    render();
  }

  // ---- chat --------------------------------------------------------------------------------------
  var ticketId = null, msgs = [], chan = null, timer = null, chatOpen = false;
  function greeting() { return 'Hello! Welcome to Ememart Support. Tap a question above for a quick answer, or type your message below to chat with our team. ' + (C.reply_note || '') + ' You will get a notification when we reply.'; }

  function bubble(m) {
    var mine = m.sender_role === 'user';
    var bot = m.sender_role === 'bot';
    var d = document.createElement('div');
    d.className = 'flex flex-col ' + (mine ? 'items-end' : 'items-start');
    if (!mine) {
      var who = document.createElement('div');
      who.style.cssText = 'font-size:9px;font-weight:800;color:#6b7280;margin:0 0 2px 4px';
      who.textContent = bot ? 'Ememart Help' : 'Ememart Support';
      d.appendChild(who);
    }
    var b = document.createElement('div');
    b.setAttribute('data-noicon', '');
    b.style.cssText = 'max-width:86%;padding:8px 12px;border-radius:14px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;' +
      (mine ? 'background:#059669;color:#fff;border-bottom-right-radius:4px'
        : bot ? 'background:#dbeafe;color:#1e3a8a;border:1px solid #bfdbfe;border-bottom-left-radius:4px'
          : 'background:#eef2f7;color:#111827;border-bottom-left-radius:4px');
    if (m.failed) b.style.opacity = '.55';
    b.textContent = m.body;
    d.appendChild(b);
    if (!bot || m.stamp) {
      var t = document.createElement('div');
      t.style.cssText = 'font-size:9px;color:#9ca3af;margin-top:2px';
      t.textContent = m.failed ? 'Not sent. Tap send to try again.' : (m.pending ? 'Sending' : new Date(m.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }));
      d.appendChild(t);
    }
    return d;
  }
  function render() {
    var box = $('help-msgs'); if (!box) return;
    box.innerHTML = '';
    box.appendChild(bubble({ sender_role: 'bot', body: greeting(), created_at: new Date().toISOString() }));
    msgs.forEach(function (m) { box.appendChild(bubble(m)); });
    box.scrollTop = box.scrollHeight;
    var end = $('help-chat-end'); if (end) end.classList.toggle('hidden', !ticketId);
  }
  function askFaq(q) {
    var a = findAnswer(q); if (!a) return;
    var now = Date.now();
    msgs.push({ sender_role: 'user', body: q, local: true, created_at: new Date(now).toISOString(), stamp: true });
    msgs.push({ sender_role: 'bot', body: a + '\n\nStill need help? Type your message below and our team will reply.', local: true, created_at: new Date(now + 1).toISOString() });
    render();
  }
  function merge(list) {
    var have = {}; msgs.forEach(function (m) { if (m.id) have[m.id] = 1; });
    list.forEach(function (m) { if (!have[m.id]) msgs.push(m); });
    msgs = msgs.filter(function (m) { return !(m.pending && list.some(function (x) { return x.sender_role === 'user' && x.body === m.body; })); });
    msgs.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
  }
  async function pull() {
    if (!live() || !user()) return;
    try {
      var r = await window.callApi('GET', '/support/chat');
      var d = r && (r.data || r);
      if (!d || d._ok === false) return;
      if (d.ticket) { ticketId = d.ticket.id; subscribe(); }
      else if (ticketId) { ticketId = null; }
      var keep = msgs.filter(function (m) { return m.pending || m.failed || m.local; });
      msgs = (d.messages || []).concat(keep);
      msgs.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
      render();
    } catch (e) {}
  }
  function subscribe() {
    if (chan || !ticketId || !window.sb) return;
    try {
      chan = window.sb.channel('support-' + ticketId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages', filter: 'ticket_id=eq.' + ticketId }, function (p) {
          if (p.new) { merge([p.new]); render(); }
        }).subscribe();
    } catch (e) {}
  }
  function unsubscribe() { try { if (chan && window.sb) window.sb.removeChannel(chan); } catch (e) {} chan = null; }

  // start/stop live updates when the Help Center tab is shown or hidden
  function startChat() {
    chatOpen = true; render();
    if (!user()) return;
    pull();
    clearInterval(timer); timer = setInterval(function () { if (chatOpen && !document.hidden) pull(); }, 6000);
  }
  function stopChat() { chatOpen = false; clearInterval(timer); }
  async function endChat() {
    if (live() && ticketId) { try { await window.callApi('POST', '/support/chat/close', {}); } catch (e) {} }
    unsubscribe(); ticketId = null; msgs = []; render();
    toast('', 'Chat ended', 'You can start a new chat any time.');
  }
  async function sendMsg() {
    var inp = $('help-inp'); if (!inp) return;
    var text = inp.value.trim(); if (!text) return;
    if (!user()) { toast('', 'Sign in first', 'Sign in to chat with our team.'); try { navTo('auth'); } catch (e) {} return; }
    inp.value = '';
    var local = { sender_role: 'user', body: text, created_at: new Date().toISOString(), pending: true };
    msgs = msgs.filter(function (m) { return !m.failed; });
    msgs.push(local); render();
    if (!live()) {
      local.pending = false; render();
      setTimeout(function () { msgs.push({ sender_role: 'agent', body: 'Live chat starts working once the app is connected to the server.', created_at: new Date().toISOString() }); render(); }, 500);
      return;
    }
    try {
      var r = await window.callApi('POST', '/support/chat', { body: text });
      var d = r && (r.data || r);
      if (!d || d._ok === false || d.error) throw new Error((d && (d._err || d.error)) || 'failed');
      msgs = msgs.filter(function (m) { return m !== local; });
      if (d.ticket_id && d.ticket_id !== ticketId) { ticketId = d.ticket_id; unsubscribe(); subscribe(); }
      if (d.message) merge([d.message]);
      render();
    } catch (e) {
      local.pending = false; local.failed = true; inp.value = text; render();
      toast('', 'Message not sent', String(e && e.message || 'Check your connection and try again.'));
    }
  }

  // hook the tab switch so live updates run only while the Help Center is open
  function hook() {
    if (window._supHooked || typeof window.switchSafetyTab !== 'function') return;
    window._supHooked = true;
    var orig = window.switchSafetyTab;
    window.switchSafetyTab = function (tab) {
      var r = orig.apply(this, arguments);
      try { if (tab === 'support') startChat(); else stopChat(); } catch (e) {}
      return r;
    };
  }
  // open straight on the chat when someone taps a support notification
  window.openSupportChat = function () { try { showPanel('safety'); switchSafetyTab('support'); } catch (e) {} };

  function init() { buildScreen(); hook(); loadSettings(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.addEventListener('load', function () { setTimeout(loadSettings, 1200); });
})();
