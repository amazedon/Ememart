// backend.js  (save in the SAME folder as app.html)
// Connects the Ememart app to the new Supabase backend. Phase 1: sign-up, login, logout, Google, password reset, transaction PIN.
// It replaces the old PHP calls without touching the rest of app.html.
(function () {
  'use strict';

  // ---- 1. YOUR SETTINGS ----------------------------------------------------------------------
  const SUPABASE_URL = 'https://jjiiuwhybqagorygfarh.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_V87YLH0V1lQ_45ZHR_XiRw_zbi1bVLc';   // Supabase > Project Settings > API > "anon public" key (safe to put here)
  const API = SUPABASE_URL + '/functions/v1/api';
  // ---------------------------------------------------------------------------------------------

  // ---- DEV MODE: no login while the app is being built --------------------------------------
  // true  = nobody has to sign in. The app opens straight away as a test user and the backend is not used.
  // false = real Supabase sign-up / login (set your anon key above first).
  const DEV_NO_LOGIN = false;

  if (DEV_NO_LOGIN) {
    const testUser = {
      id: 'dev-test-user', name: 'Test User', full_name: 'Test User', email: 'test@ememart.com', phone: '',
      role: 'user', balance: 0, wallet_balance: 0, town: 'Lagos', lga: '', state: 'Lagos',
      accountNum: 'EM-TEST', verified: false, has_pin: false, admin_role: null, avatar: null,
    };
    window.checkBackendSession = async function () {
      state.session = testUser;
      try { localStorage.setItem('ememart_user', JSON.stringify(testUser)); } catch (e) {}
      try { syncAccountDisplay(); } catch (e) {}
      try { initPresenceSystem(); } catch (e) {}
    };
    const notYet = { success: false, message: 'Dev mode: this feature is not connected to the new backend yet.' };
    window.apiPost = async function () { return notYet; };
    window.apiGet = async function () { return notYet; };
    window.EMEMART_BACKEND = { mode: 'dev' };
    window.fundWallet = async function () { return notYet; };
    window.submitVerification = async function () { return notYet; };
    window.handleSignOut = function () { showPopupNotif('ℹ️', 'Dev mode', 'Login is switched off while the app is being built.'); };
    return;
  }

  if (!window.supabase || SUPABASE_ANON_KEY.startsWith('PASTE_')) {
    console.error('backend.js: Supabase library missing or anon key not set.');
    window.addEventListener('load', function () {
      try { showPopupNotif('⚠️', 'Setup needed', 'The Supabase anon key has not been added to backend.js yet.'); } catch (e) {}
    });
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  window.sb = sb;

  // ---- helpers -------------------------------------------------------------------------------
  async function callApi(method, path, body) {
    const { data: s } = await sb.auth.getSession();
    const token = s && s.session ? s.session.access_token : null;
    let res;
    try {
      res = await fetch(API + path, {
        method: method,
        headers: Object.assign({ 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
          token ? { Authorization: 'Bearer ' + token } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { return { success: false, message: 'Connection failed. Check your internet.' }; }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    return Object.assign({}, data, { success: res.ok, message: res.ok ? (data.message || '') : (data.error || 'Request failed') });
  }
  window.callApi = callApi;
  // Push notifications: paste your VAPID public key here (see DEPLOY notes). Leave empty to keep push off.
  window.EMEMART_VAPID_PUBLIC_KEY = window.EMEMART_VAPID_PUBLIC_KEY || 'BCl0CT-PfPokR4EscVxFIjUHo4W8eKyxsplCg1-Qm6ldtuK7r6HMyAqGcZpI3eDkf_nHzxdEvEcoIB56KwKVyVY';

  // Builds the "session" object the rest of the app expects.
  async function buildSession() {
    const { data: u } = await sb.auth.getUser();
    const authUser = u && u.user;
    if (!authUser) return null;
    const meta = authUser.user_metadata || {};
    const me = await callApi('GET', '/me');
    const p = (me.success && me.profile) || {};
    const role = p.role === 'buyer' || !p.role ? 'user' : p.role;
    const name = p.full_name || meta.full_name || (authUser.email || '').split('@')[0];
    return {
      id: authUser.id, name: name, full_name: name,
      email: authUser.email || p.email || '', phone: p.phone || meta.phone || '',
      role: role, username: p.username || '', role_changes: p.role_changes || 0, balance: Number(me.balance_kobo || 0) / 100, wallet_balance: Number(me.balance_kobo || 0) / 100,
      town: meta.town || '', lga: meta.lga || '', state: meta.state || '', business: meta.business || '',
      accountNum: 'EM-' + authUser.id.slice(0, 8).toUpperCase(),
      verified: !!p.verified, vendorTier: p.tier || 'free', has_pin: !!me.has_pin, admin_role: me.admin_role || null,
      avatar: meta.avatar_url || meta.picture || null,
    };
  }
  window.buildSession = buildSession;

  // Saves the profile form: details live in auth metadata (town/LGA/state/business) and name/phone also in profiles.
  window.persistProfile = async function (f) {
    const { error } = await sb.auth.updateUser({ data: { full_name: f.full_name, phone: f.phone, business: f.business, town: f.town, lga: f.lga, state: f.state } });
    if (error) throw new Error(error.message);
    try {
      const { data: u } = await sb.auth.getUser();
      if (u && u.user) await sb.from('profiles').update({ full_name: f.full_name, phone: f.phone || null, area: [f.town, f.lga, f.state].filter(Boolean).join(', ') }).eq('id', u.user.id);
    } catch (e) { /* metadata is the source of truth; ignore profile-table errors */ }
  };

  function setSession(sess) {
    state.session = sess;
    localStorage.setItem('ememart_user', JSON.stringify(sess));
    syncAccountDisplay();
  }

  function niceError(err) {
    const m = (err && err.message) || 'Something went wrong';
    if (/invalid login/i.test(m)) return 'Wrong email or password';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the code.';
    if (/already registered|already been registered/i.test(m)) return 'An account with this email already exists. Sign in instead.';
    if (/not authorized/i.test(m)) return 'This email address cannot receive codes yet while the app is in testing. Use the email you use for Supabase, or ask the admin.';
    if (/email rate limit/i.test(m)) return 'The email limit was reached (testing mode allows only a few codes per hour). Wait an hour and try again.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a few minutes and try again.';
    if (/token has expired|invalid/i.test(m)) return 'That code is wrong or has expired.';
    return m;
  }

  // ---- 2. old PHP calls -> new backend -------------------------------------------------------
  const NOT_YET = { success: false, message: 'This feature is not connected to the new backend yet.' };

  window.apiPost = async function (file, action, data) {
    data = data || {};
    const key = file + ':' + action;
    switch (key) {
      case 'auth.php:login': {
        const id = String(data.identifier || '').trim();
        let loginEmail = id;
        if (!id.includes('@')) {
          const lk = await sb.rpc('login_email', { p_identifier: id.replace(/^@/, '') });
          if (lk.error || !lk.data) return { success: false, message: 'No account found with that username or phone number.' };
          loginEmail = lk.data;
        }
        const r = await sb.auth.signInWithPassword({ email: loginEmail, password: data.password });
        if (r.error) {
          if (/not confirmed/i.test(r.error.message || '')) {
            // account exists but the email was never confirmed: send a fresh code and ask for it
            const rs = await sb.auth.resend({ type: 'signup', email: loginEmail });
            window._pendingReg = { email: id, password: data.password, full_name: '', role: 'buyer' };
            _otpPurpose = 'register';
            if (!rs.error) {
              el('otp-verify-info').textContent = 'Confirm your email first. A new 6-digit code was sent to ' + id + '.';
              el('otp-verify-modal').classList.remove('hidden');
              return { success: false, message: 'Confirm your email with the code we just sent.' };
            }
            return { success: false, message: niceError(rs.error) };
          }
          return { success: false, message: niceError(r.error) };
        }
        const sess = await buildSession();
        return { success: true, data: { user: sess }, user: sess };
      }
      case 'role.php:switch': {
        const r = await callApi('POST', '/me/role', { role: data.role === 'user' ? 'buyer' : data.role });
        if (r.success && r.approved) {
          const sess = await buildSession(); if (sess) setSession(sess);
        }
        return r;
      }
      case 'role.php:status': {
        const r = await callApi('GET', '/me');
        if (!r.success) return r;
        const p = r.profile || {};
        return { success: true, role: p.role === 'buyer' || !p.role ? 'user' : p.role, pending_role: r.pending_role ? (r.pending_role === 'buyer' ? 'user' : r.pending_role) : null };
      }
      case 'auth.php:logout':
        await sb.auth.signOut();
        return { success: true };
      case 'auth.php:google_login': {
        const r = await sb.auth.signInWithIdToken({ provider: 'google', token: data.id_token });
        if (r.error) return { success: false, message: niceError(r.error) };
        const sess = await buildSession();
        return { success: true, user: sess, data: { user: sess } };
      }
      case 'wallet.php:reset_pin': {
        const r = await callApi('POST', '/me/pin/reset', { password: data.password, pin: data.pin });
        if (r.success && state.session) { state.session.has_pin = true; localStorage.setItem('ememart_user', JSON.stringify(state.session)); }
        return r;
      }
      case 'wallet.php:set_pin': {
        const r = await callApi('POST', '/me/pin', { pin: data.pin, old_pin: data.old_pin });
        if (r.success && state.session) { state.session.has_pin = true; localStorage.setItem('ememart_user', JSON.stringify(state.session)); }
        return r;
      }
      default:
        return NOT_YET;
    }
  };
  window.apiGet = async function () { return NOT_YET; };

  // ---- 3. sign-up with email code ------------------------------------------------------------
  async function finishRegistration(d) {
    const sess = await buildSession();
    if (d && d.remember) { try { localStorage.setItem('ememart_saved_email', d.email); } catch (e) {} }
    el('otp-verify-modal') && el('otp-verify-modal').classList.add('hidden');
    el('otp-channel-modal') && el('otp-channel-modal').classList.add('hidden');
    setSession(sess);
    showPopupNotif('🎉', 'Account Created!', 'Welcome, ' + String(sess.name || '').split(' ')[0] + '! Set your transaction PIN.');
    navTo('home');
    setTimeout(function () { showPinSetup(); }, 1500);
    window._pendingReg = null;
  }

  window.sendRegistrationOTP = async function () {
    const btn = el('send-otp-btn') || el('auth-submit-btn');
    const btnText = btn && btn.id === 'auth-submit-btn' ? 'Create Account' : 'Send OTP to Email';
    if (btn) { btn.textContent = 'Creating account...'; btn.disabled = true; }
    try {
      const d = window._pendingReg;
      if (!d || !d.email) { showPopupNotif('❌', 'Error', 'Please fill in your details first.'); return; }
      const av = await sb.rpc('signup_available', { p_username: d.username, p_phone: d.phone });
      if (av.data && av.data.username_taken) { showPopupNotif('⚠️', 'Username taken', 'Pick a different username.'); return; }
      if (av.data && av.data.phone_taken) { showPopupNotif('⚠️', 'Phone already used', 'That phone number belongs to another account. Sign in instead.'); return; }
      const r = await sb.auth.signUp({
        email: d.email, password: d.password,
        options: { data: { full_name: d.full_name, username: d.username, phone: d.phone } },
      });
      if (r.error) { showPopupNotif('❌', 'Sign-up failed', niceError(r.error)); return; }
      // Supabase returns a user with no identities when the email is already registered
      if (r.data.user && r.data.user.identities && r.data.user.identities.length === 0) {
        showPopupNotif('⚠️', 'Already registered', 'An account with this email already exists. Sign in instead.'); return;
      }
      if (r.data.session) { await finishRegistration(d); return; }   // no email confirmation: signed in straight away
      _otpPurpose = 'register';
      el('otp-channel-modal').classList.add('hidden');
      el('otp-verify-info').textContent = 'A 6-digit code was sent to ' + d.email + '. Enter it below.';
      el('otp-verify-modal').classList.remove('hidden');
    } catch (e) {
      console.error(e); showPopupNotif('❌', 'Error', 'Connection failed. Check your internet and try again.');
    } finally { if (btn) { btn.textContent = btnText; btn.disabled = false; } }
  };

  window.verifyOTP = async function () {
    const otp = el('otp-code-input').value.trim();
    if (!otp || otp.length !== 6) { showPopupNotif('⚠️', 'OTP Required', 'Enter the 6-digit OTP.'); return; }
    const btn = el('verify-otp-btn');
    btn.textContent = 'Verifying...'; btn.disabled = true;
    try {
      if (_otpPurpose === 'register') {
        const d = window._pendingReg;
        if (!d) { showPopupNotif('❌', 'Error', 'Registration data lost. Please start again.'); return; }
        const r = await sb.auth.verifyOtp({ email: d.email, token: otp, type: 'signup' });
        if (r.error) { showPopupNotif('❌', 'Invalid OTP', niceError(r.error)); return; }
        await finishRegistration(d);
      } else {
        const email = window._resetEmail || '';
        const r = await sb.auth.verifyOtp({ email: email, token: otp, type: 'recovery' });
        if (r.error) { showPopupNotif('❌', 'Invalid OTP', niceError(r.error)); return; }
        el('otp-verify-modal').classList.add('hidden');
        el('reset-password-modal').classList.remove('hidden');
      }
    } catch (e) { showPopupNotif('❌', 'Error', 'Connection failed.'); }
    finally { btn.textContent = 'Verify OTP'; btn.disabled = false; }
  };

  window.resendOTP = async function () {
    try {
      let r;
      if (_otpPurpose === 'register') {
        const d = window._pendingReg || {};
        r = await sb.auth.resend({ type: 'signup', email: d.email });
      } else {
        r = await sb.auth.resetPasswordForEmail(window._resetEmail || '');
      }
      showPopupNotif(r.error ? '❌' : '✅', r.error ? 'Error' : 'OTP Resent', r.error ? niceError(r.error) : 'A new code was sent to your email.');
    } catch (e) { showPopupNotif('❌', 'Error', 'Connection failed.'); }
  };

  // ---- 4. forgot password --------------------------------------------------------------------
  window.sendForgotOTP = async function () {
    const email = (state.session && state.session.email) || (el('inp-email') && el('inp-email').value.trim()) || '';
    const btn = el('send-forgot-otp-btn');
    btn.textContent = 'Sending...'; btn.disabled = true;
    try {
      const r = await sb.auth.resetPasswordForEmail(email);
      if (r.error) { showPopupNotif('❌', 'Error', niceError(r.error)); return; }
      window._resetEmail = email; _otpPurpose = 'reset';
      el('forgot-password-modal').classList.add('hidden');
      el('otp-verify-info').textContent = 'A 6-digit reset code was sent to ' + email + '. Enter it below.';
      el('otp-verify-modal').classList.remove('hidden');
    } catch (e) { showPopupNotif('❌', 'Error', 'Connection failed.'); }
    finally { btn.textContent = 'Send OTP'; btn.disabled = false; }
  };

  window.submitNewPassword = async function () {
    const pw = el('reset-new-pw').value, pw2 = el('reset-confirm-pw').value;
    if (pw.length < 6) { showPopupNotif('⚠️', 'Too Short', 'Min 6 characters.'); return; }
    if (pw !== pw2) { showPopupNotif('⚠️', 'Mismatch', 'Passwords do not match.'); return; }
    const btn = el('reset-pw-btn');
    btn.textContent = 'Resetting...'; btn.disabled = true;
    try {
      const r = await sb.auth.updateUser({ password: pw });
      if (r.error) { showPopupNotif('❌', 'Error', niceError(r.error)); return; }
      await sb.auth.signOut();
      el('reset-password-modal').classList.add('hidden');
      showPopupNotif('✅', 'Password Reset', 'Sign in with your new password.');
      switchAuthTab('signin');
    } catch (e) { showPopupNotif('❌', 'Error', 'Connection failed.'); }
    finally { btn.textContent = 'Reset Password'; btn.disabled = false; }
  };

  // ---- wallet funding (Squad checkout) and verification upload ---------------------------------
  window.fundWallet = function (amountNaira) {
    return callApi('POST', '/wallet/fund', { amount_kobo: Math.round(Number(amountNaira) * 100) });
  };

  window.getVirtualAccount = function () { return callApi('GET', '/wallet/va'); };
  window.createVirtualAccount = function (d) { return callApi('POST', '/wallet/va', d); };

  async function uploadPrivate(file, label) {
    if (!file) return null;
    const { data } = await sb.auth.getUser();
    const uid = data.user.id;
    const ext = ((file.name.split('.').pop() || 'jpg') + '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = uid + '/' + Date.now() + '-' + label + '.' + ext;   // must start with your own user id
    const r = await sb.storage.from('kyc-docs').upload(path, file, { contentType: file.type });
    if (r.error) throw r.error;
    return path;
  }

  window.submitVerification = async function (v) {
    try {
      const document_path = await uploadPrivate(v.docFile, 'doc');
      const selfie_path = await uploadPrivate(v.selfieFile, 'selfie');
      return await callApi('POST', '/verification', {
        kind: v.kind, document_number: v.number,
        document_path: document_path || undefined, selfie_path: selfie_path || undefined,
      });
    } catch (e) { return { success: false, message: 'Upload failed: ' + ((e && e.message) || 'try again') }; }
  };

  // ---- bookings and escrow actions used by rules.js -------------------------------------------
  window.EMEMART_BACKEND = {
    mode: 'live',
    createBooking: function (b) { return callApi('POST', '/bookings', b); },
    listBookings: function () { return callApi('GET', '/bookings'); },
    respondBooking: function (id, accept) { return callApi('POST', '/bookings/' + id + '/respond', { accept: !!accept }); },
    fulfilBooking: function (id) { return callApi('POST', '/bookings/' + id + '/fulfil'); },
    confirmOrder: function (orderId) { return callApi('POST', '/orders/' + orderId + '/confirm'); },
    disputeOrder: function (orderId, reason) { return callApi('POST', '/orders/' + orderId + '/dispute', { reason: reason }); },
  };

  // ---- 5. restore the session when the page opens --------------------------------------------
  window.checkBackendSession = async function () {
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) {
        const sess = await buildSession();
        if (sess) setSession(sess);
      } else {
        localStorage.removeItem('ememart_user');
        state.session = null;
      }
    } catch (e) { console.warn('Session restore failed:', e); }
    try { initPresenceSystem(); } catch (e) {}
  };

  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') { try { localStorage.removeItem('ememart_user'); } catch (e) {} }
  });
})();
