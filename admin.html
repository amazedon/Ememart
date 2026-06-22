<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ememart — Admin Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0e14;color:#e5e7eb}
  .mono{font-family:'SF Mono',Consolas,monospace}
  .glow-border{border:1px solid #1f2937}
  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-thumb{background:#374151;border-radius:3px}
  .sidebar-link.active{background:rgba(16,185,129,.12);color:#34d399;border-left:2px solid #34d399}
  .sidebar-link{border-left:2px solid transparent}
  .badge-perm{font-size:9px;font-weight:900;padding:2px 8px;border-radius:999px;border:1px solid}
  .fade-in{animation:fadeIn .2s ease-out}
  @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
  .skel{background:linear-gradient(90deg,#1f2937 25%,#374151 50%,#1f2937 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
</style>
</head>
<body class="min-h-screen">

<!-- ============================================================ -->
<!-- LOGIN SCREEN -->
<!-- ============================================================ -->
<div id="login-screen" class="min-h-screen flex items-center justify-center p-6">
  <div class="w-full max-w-sm">
    <div class="text-center mb-8">
      <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-2xl">🛡️</div>
      <h1 class="text-xl font-black text-white">Ememart Admin</h1>
      <p class="text-xs text-gray-500 mt-1">Staff access only · Role-based dashboard</p>
    </div>
    <div class="bg-gray-900 glow-border rounded-2xl p-6 flex flex-col gap-4">
      <div class="flex flex-col gap-1.5">
        <label class="text-[10px] font-black text-gray-400 uppercase tracking-wide">Email</label>
        <input id="login-email" type="email" placeholder="you@ememart.com" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600">
      </div>
      <div class="flex flex-col gap-1.5">
        <label class="text-[10px] font-black text-gray-400 uppercase tracking-wide">Password</label>
        <input id="login-password" type="password" placeholder="••••••••" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600" onkeydown="if(event.key==='Enter')doAdminLogin()">
      </div>
      <div id="login-error" class="hidden text-[11px] text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2"></div>
      <button id="login-btn" onclick="doAdminLogin()" class="bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black text-sm py-3 rounded-xl transition">Sign In</button>
      <button onclick="openForgotPasswordModal()" class="text-[11px] text-gray-500 hover:text-emerald-400 transition text-center">Forgot password?</button>
    </div>
    <p class="text-center text-[10px] text-gray-600 mt-6">Access requires an admin role assigned by a Super Admin.</p>
  </div>
</div>

<!-- ============================================================ -->
<!-- FORGOT PASSWORD MODAL -->
<!-- ============================================================ -->
<div id="forgot-modal" class="hidden fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-6">
  <div class="bg-gray-900 glow-border rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-black text-white">Reset Password</h2>
      <button onclick="closeForgotPasswordModal()" class="text-gray-500 hover:text-white text-lg">✕</button>
    </div>

    <!-- Step 1: enter email -->
    <div id="forgot-step-1" class="flex flex-col gap-3">
      <p class="text-[11px] text-gray-400">Enter your admin email — we'll send a 6-digit code.</p>
      <input id="forgot-email" type="email" placeholder="you@ememart.com" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600">
      <button id="forgot-send-btn" onclick="sendForgotOtp()" class="bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black text-sm py-2.5 rounded-xl transition">Send Code</button>
    </div>

    <!-- Step 2: enter OTP + new password -->
    <div id="forgot-step-2" class="hidden flex flex-col gap-3">
      <p class="text-[11px] text-gray-400">Enter the code sent to <span id="forgot-email-display" class="text-emerald-400 font-bold"></span> and choose a new password.</p>
      <input id="forgot-otp" type="text" maxlength="6" placeholder="6-digit code" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white text-center tracking-widest placeholder-gray-600 focus:outline-none focus:border-emerald-600">
      <input id="forgot-new-password" type="password" placeholder="New password (min 8 characters)" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600">
      <button id="forgot-reset-btn" onclick="resetForgotPassword()" class="bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black text-sm py-2.5 rounded-xl transition">Reset Password</button>
    </div>

    <div id="forgot-error" class="hidden text-[11px] text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2"></div>
    <div id="forgot-success" class="hidden text-[11px] text-emerald-400 bg-emerald-950/30 border border-emerald-900/40 rounded-lg px-3 py-2"></div>
  </div>
</div>

<!-- ============================================================ -->
<!-- MAIN DASHBOARD (hidden until login) -->
<!-- ============================================================ -->
<div id="dashboard" class="hidden min-h-screen flex">

  <!-- Sidebar -->
  <aside class="w-60 bg-gray-950 border-r border-gray-900 flex flex-col fixed h-screen overflow-y-auto">
    <div class="p-5 border-b border-gray-900">
      <div class="flex items-center gap-2">
        <div class="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-sm">🛡️</div>
        <div>
          <div class="text-sm font-black text-white">Ememart</div>
          <div class="text-[9px] text-gray-500 -mt-0.5">Admin Dashboard</div>
        </div>
      </div>
    </div>

    <nav class="flex-1 py-3 flex flex-col gap-0.5" id="sidebar-nav">
      <!-- Populated by JS based on permissions -->
    </nav>

    <div class="p-3 border-t border-gray-900">
      <div class="bg-gray-900 rounded-xl p-3 flex items-center gap-2.5 mb-2">
        <div id="admin-avatar" class="w-8 h-8 rounded-full bg-emerald-900 flex items-center justify-center text-xs font-black text-emerald-300 flex-shrink-0">A</div>
        <div class="flex-1 min-w-0">
          <div id="admin-name" class="text-xs font-black text-white truncate">—</div>
          <div id="admin-role" class="text-[9px] text-emerald-400 font-bold truncate">—</div>
        </div>
      </div>
      <button onclick="openChangePasswordModal()" class="w-full text-[10px] font-black text-gray-500 hover:text-emerald-400 transition py-1.5">Change Password</button>
      <button onclick="doAdminLogout()" class="w-full text-[10px] font-black text-gray-500 hover:text-red-400 transition py-1.5">Sign Out</button>
    </div>
  </aside>

  <!-- Main content -->
  <main class="flex-1 ml-60 p-6">
    <div id="page-content" class="fade-in"></div>
  </main>
</div>

<!-- ============================================================ -->
<!-- CHANGE PASSWORD MODAL -->
<!-- ============================================================ -->
<div id="change-pw-modal" class="hidden fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-6">
  <div class="bg-gray-900 glow-border rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-black text-white">Change Password</h2>
      <button onclick="el('change-pw-modal').classList.add('hidden')" class="text-gray-500 hover:text-white text-lg">✕</button>
    </div>
    <input id="change-pw-current" type="password" placeholder="Current password" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600">
    <input id="change-pw-new" type="password" placeholder="New password (min 8 characters)" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600">
    <div id="change-pw-error" class="hidden text-[11px] text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg px-3 py-2"></div>
    <div id="change-pw-success" class="hidden text-[11px] text-emerald-400 bg-emerald-950/30 border border-emerald-900/40 rounded-lg px-3 py-2"></div>
    <button id="change-pw-btn" onclick="doChangePassword()" class="bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black text-sm py-2.5 rounded-xl transition">Update Password</button>
  </div>
</div>

<script>
const API_BASE = 'https://www.ememart.com/api';
let CURRENT_ADMIN = null;
let CURRENT_PAGE = 'overview';

// ============================================================
// API HELPER
// ============================================================
async function adminApi(action, data = {}) {
  try {
    const res = await fetch(`${API_BASE}/admin.php`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data })
    });
    return await res.json();
  } catch (e) {
    return { success: false, message: 'Connection failed. Check your internet.' };
  }
}

async function kycApi(action, data = {}) {
  try {
    const res = await fetch(`${API_BASE}/admin_kyc.php`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data })
    });
    return await res.json();
  } catch (e) {
    return { success: false, message: 'Connection failed.' };
  }
}

function el(id) { return document.getElementById(id); }
function hasPerm(perm) {
  if (!CURRENT_ADMIN) return false;
  return !!(CURRENT_ADMIN.permissions.all || CURRENT_ADMIN.permissions[perm]);
}
function fmtCurrency(n) { return '₦' + parseFloat(n||0).toLocaleString('en-NG',{minimumFractionDigits:2}); }
function fmtDate(d) { return new Date(d).toLocaleString('en-NG', { dateStyle:'medium', timeStyle:'short' }); }

// ============================================================
// FORGOT PASSWORD FLOW
// ============================================================
function openForgotPasswordModal() {
  el('forgot-modal').classList.remove('hidden');
  el('forgot-step-1').classList.remove('hidden');
  el('forgot-step-2').classList.add('hidden');
  el('forgot-error').classList.add('hidden');
  el('forgot-success').classList.add('hidden');
  el('forgot-email').value = '';
  el('forgot-otp').value = '';
  el('forgot-new-password').value = '';
}

function closeForgotPasswordModal() {
  el('forgot-modal').classList.add('hidden');
}

async function sendForgotOtp() {
  const email = el('forgot-email').value.trim();
  const errBox = el('forgot-error');
  errBox.classList.add('hidden');

  if (!email) { errBox.textContent = 'Enter your email.'; errBox.classList.remove('hidden'); return; }

  const btn = el('forgot-send-btn');
  btn.textContent = 'Sending...'; btn.disabled = true;
  const res = await adminApi('forgot_password_send_otp', { email });
  btn.textContent = 'Send Code'; btn.disabled = false;

  if (res.success) {
    el('forgot-email-display').textContent = email;
    el('forgot-step-1').classList.add('hidden');
    el('forgot-step-2').classList.remove('hidden');
  } else {
    errBox.textContent = res.message;
    errBox.classList.remove('hidden');
  }
}

async function resetForgotPassword() {
  const email = el('forgot-email').value.trim();
  const otp = el('forgot-otp').value.trim();
  const new_password = el('forgot-new-password').value;
  const errBox = el('forgot-error');
  const successBox = el('forgot-success');
  errBox.classList.add('hidden');
  successBox.classList.add('hidden');

  if (!otp || !new_password) { errBox.textContent = 'Enter the code and a new password.'; errBox.classList.remove('hidden'); return; }

  const btn = el('forgot-reset-btn');
  btn.textContent = 'Resetting...'; btn.disabled = true;
  const res = await adminApi('forgot_password_reset', { email, otp, new_password });
  btn.textContent = 'Reset Password'; btn.disabled = false;

  if (res.success) {
    successBox.textContent = 'Password reset! You can now sign in.';
    successBox.classList.remove('hidden');
    setTimeout(() => closeForgotPasswordModal(), 2000);
  } else {
    errBox.textContent = res.message;
    errBox.classList.remove('hidden');
  }
}

// ============================================================
// LOGIN / LOGOUT
// ============================================================
async function doAdminLogin() {
  const email = el('login-email').value.trim();
  const password = el('login-password').value;
  const btn = el('login-btn');
  const errBox = el('login-error');
  errBox.classList.add('hidden');

  if (!email || !password) {
    errBox.textContent = 'Enter both email and password.';
    errBox.classList.remove('hidden');
    return;
  }

  btn.textContent = 'Signing in...'; btn.disabled = true;
  const res = await adminApi('login', { email, password });
  btn.textContent = 'Sign In'; btn.disabled = false;

  if (res.success) {
    CURRENT_ADMIN = res.admin;
    enterDashboard();
  } else {
    errBox.textContent = res.message || 'Login failed.';
    errBox.classList.remove('hidden');
  }
}

async function doAdminLogout() {
  await adminApi('logout');
  CURRENT_ADMIN = null;
  el('dashboard').classList.add('hidden');
  el('login-screen').classList.remove('hidden');
  el('login-email').value = '';
  el('login-password').value = '';
}

async function checkExistingSession() {
  const res = await adminApi('me');
  if (res.success) {
    CURRENT_ADMIN = res.admin;
    enterDashboard();
  }
}

// ============================================================
// CHANGE PASSWORD (for logged-in admin)
// ============================================================
function openChangePasswordModal() {
  el('change-pw-modal').classList.remove('hidden');
  el('change-pw-current').value = '';
  el('change-pw-new').value = '';
  el('change-pw-error').classList.add('hidden');
  el('change-pw-success').classList.add('hidden');
}

async function doChangePassword() {
  const current_password = el('change-pw-current').value;
  const new_password = el('change-pw-new').value;
  const errBox = el('change-pw-error');
  const successBox = el('change-pw-success');
  errBox.classList.add('hidden');
  successBox.classList.add('hidden');

  if (!current_password || !new_password) {
    errBox.textContent = 'Fill in both fields.';
    errBox.classList.remove('hidden');
    return;
  }

  const btn = el('change-pw-btn');
  btn.textContent = 'Updating...'; btn.disabled = true;
  const res = await adminApi('change_password', { current_password, new_password });
  btn.textContent = 'Update Password'; btn.disabled = false;

  if (res.success) {
    successBox.textContent = 'Password updated successfully.';
    successBox.classList.remove('hidden');
    setTimeout(() => el('change-pw-modal').classList.add('hidden'), 1500);
  } else {
    errBox.textContent = res.message;
    errBox.classList.remove('hidden');
  }
}

// ============================================================
// SIDEBAR NAV — built dynamically from permissions
// ============================================================
const NAV_ITEMS = [
  { id: 'overview',   label: 'Overview',        icon: '📊', perm: null },
  { id: 'kyc',         label: 'KYC Review',      icon: '🪪', perm: 'kyc' },
  { id: 'users',       label: 'Users',           icon: '👥', perm: 'users' },
  { id: 'posts',       label: 'Posts',           icon: '📝', perm: 'posts' },
  { id: 'disputes',    label: 'Disputes',        icon: '⚖️', perm: 'disputes' },
  { id: 'orders',      label: 'Orders',          icon: '📦', perm: 'orders' },
  { id: 'finance',     label: 'Finance & Fees',  icon: '💰', perm: 'fees' },
  { id: 'withdrawals', label: 'Withdrawals',     icon: '🏦', perm: 'withdrawals' },
  { id: 'staff',       label: 'Staff & Roles',   icon: '🔑', perm: 'all' },
  { id: 'activity',    label: 'Activity Log',    icon: '📜', perm: 'all' },
];

function buildSidebar() {
  const nav = el('sidebar-nav');
  nav.innerHTML = NAV_ITEMS
    .filter(item => !item.perm || hasPerm(item.perm))
    .map(item => `
      <button onclick="navigateTo('${item.id}')" id="nav-${item.id}" class="sidebar-link flex items-center gap-3 px-5 py-2.5 text-xs font-bold text-gray-400 hover:text-white hover:bg-gray-900 transition">
        <span class="text-base">${item.icon}</span>${item.label}
      </button>
    `).join('');
}

function enterDashboard() {
  el('login-screen').classList.add('hidden');
  el('dashboard').classList.remove('hidden');
  el('admin-name').textContent = CURRENT_ADMIN.full_name;
  el('admin-role').textContent = CURRENT_ADMIN.role_label;
  el('admin-avatar').textContent = CURRENT_ADMIN.full_name.charAt(0).toUpperCase();
  buildSidebar();
  navigateTo('overview');
}

function navigateTo(page) {
  CURRENT_PAGE = page;
  document.querySelectorAll('.sidebar-link').forEach(b => b.classList.remove('active'));
  el(`nav-${page}`)?.classList.add('active');

  const renderers = {
    overview: renderOverviewPage,
    kyc: renderKycPage,
    staff: renderStaffPage,
    activity: renderActivityPage,
    users: renderComingSoon,
    posts: renderComingSoon,
    disputes: renderComingSoon,
    orders: renderComingSoon,
    finance: renderComingSoon,
    withdrawals: renderComingSoon,
  };
  (renderers[page] || renderComingSoon)();
}

function pageHeader(title, subtitle) {
  return `<div class="mb-6"><h1 class="text-xl font-black text-white">${title}</h1><p class="text-xs text-gray-500 mt-1">${subtitle}</p></div>`;
}

function renderComingSoon() {
  el('page-content').innerHTML = pageHeader(
    NAV_ITEMS.find(i=>i.id===CURRENT_PAGE)?.label || 'Page',
    'This section is being built next.'
  ) + `<div class="bg-gray-900 glow-border rounded-2xl p-12 text-center"><div class="text-3xl mb-2">🚧</div><div class="text-sm text-gray-500">Coming soon</div></div>`;
}

// ============================================================
// OVERVIEW PAGE
// ============================================================
function renderOverviewPage() {
  el('page-content').innerHTML = pageHeader('Overview', `Welcome back, ${CURRENT_ADMIN.full_name.split(' ')[0]}.`) + `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="bg-gray-900 glow-border rounded-2xl p-5">
        <div class="text-[10px] text-gray-500 font-black uppercase">Your Role</div>
        <div class="text-lg font-black text-emerald-400 mt-1">${CURRENT_ADMIN.role_label}</div>
      </div>
      <div class="bg-gray-900 glow-border rounded-2xl p-5">
        <div class="text-[10px] text-gray-500 font-black uppercase">Access Level</div>
        <div class="text-lg font-black text-white mt-1">${CURRENT_ADMIN.permissions.all ? 'Full Access' : Object.keys(CURRENT_ADMIN.permissions).length + ' permission(s)'}</div>
      </div>
      <div class="bg-gray-900 glow-border rounded-2xl p-5">
        <div class="text-[10px] text-gray-500 font-black uppercase">Signed in as</div>
        <div class="text-sm font-bold text-white mt-1 truncate">${CURRENT_ADMIN.email}</div>
      </div>
    </div>
    <div class="mt-6 bg-gray-900 glow-border rounded-2xl p-5">
      <div class="text-xs font-black text-white mb-3">Your accessible sections</div>
      <div class="flex flex-wrap gap-2">
        ${NAV_ITEMS.filter(i=>!i.perm||hasPerm(i.perm)).map(i=>`<span class="badge-perm border-emerald-800 text-emerald-400 bg-emerald-950/30">${i.icon} ${i.label}</span>`).join('')}
      </div>
    </div>`;
}

// ============================================================
// KYC REVIEW PAGE
// ============================================================
async function renderKycPage() {
  el('page-content').innerHTML = pageHeader('KYC Review', 'Manually verify user identity submissions.') +
    `<div id="kyc-list" class="flex flex-col gap-4"><div class="skel h-32 rounded-2xl"></div></div>`;

  const res = await kycApi('list', { status: 'pending' });
  const list = el('kyc-list');

  if (!res.success) {
    list.innerHTML = `<div class="bg-red-950/30 border border-red-900/40 rounded-2xl p-6 text-center text-sm text-red-400">${res.message}</div>`;
    return;
  }

  const submissions = res.submissions || [];
  if (!submissions.length) {
    list.innerHTML = `<div class="bg-gray-900 glow-border rounded-2xl p-12 text-center"><div class="text-3xl mb-2">✅</div><div class="text-sm text-gray-500">No pending KYC submissions.</div></div>`;
    return;
  }

  list.innerHTML = submissions.map(k => `
    <div class="bg-gray-900 glow-border rounded-2xl p-5 flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-amber-950 border border-amber-800 flex items-center justify-center font-black text-amber-300">${k.full_name.charAt(0)}</div>
          <div><div class="text-sm font-black text-white">${k.full_name}</div><div class="text-[10px] text-gray-500">${k.role} · ${k.email}</div></div>
        </div>
        <span class="badge-perm border-amber-800 text-amber-400 bg-amber-950/30">⏳ Pending</span>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <div class="text-[9px] text-gray-500 uppercase font-black mb-1">Selfie with ID</div>
          <img src="${k.selfie}" class="w-full h-40 object-cover rounded-xl border border-gray-800 cursor-pointer" onclick="window.open('${k.selfie}','_blank')">
        </div>
        ${k.utility_bill ? `<div><div class="text-[9px] text-gray-500 uppercase font-black mb-1">Utility Bill</div><img src="${k.utility_bill}" class="w-full h-40 object-cover rounded-xl border border-gray-800 cursor-pointer" onclick="window.open('${k.utility_bill}','_blank')"></div>` : `<div class="flex items-center justify-center text-xs text-gray-600 italic">No utility bill provided</div>`}
      </div>
      <div class="bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs text-gray-400 flex flex-col gap-1">
        <span>🆔 BVN: <span class="mono text-gray-300">${k.bvn}</span></span>
        <span>🪪 NIN: <span class="mono text-gray-300">${k.nin}</span></span>
        <span>📅 Submitted: ${fmtDate(k.created_at)}</span>
      </div>
      <div class="flex gap-2">
        <button onclick="approveKyc(${k.id})" class="flex-1 bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black text-xs py-2.5 rounded-xl transition">✅ Approve</button>
        <button onclick="rejectKyc(${k.id})" class="flex-1 bg-gray-800 hover:bg-red-950 border border-gray-700 hover:border-red-800 text-red-400 font-black text-xs py-2.5 rounded-xl transition">❌ Reject</button>
      </div>
    </div>
  `).join('');
}

async function approveKyc(id) {
  if (!confirm('Approve this KYC submission?')) return;
  const res = await kycApi('approve', { kyc_id: id });
  alert(res.message);
  if (res.success) renderKycPage();
}

async function rejectKyc(id) {
  const reason = prompt('Reason for rejection (shown to the user):', 'Documents unclear. Please retake your selfie with better lighting.');
  if (reason === null) return;
  const res = await kycApi('reject', { kyc_id: id, reason });
  alert(res.message);
  if (res.success) renderKycPage();
}

// ============================================================
// STAFF & ROLES PAGE (Super Admin only)
// ============================================================
async function renderStaffPage() {
  el('page-content').innerHTML = pageHeader('Staff & Roles', 'Assign admin access to team members.') +
    `<div class="bg-gray-900 glow-border rounded-2xl p-5 mb-5">
      <div class="text-xs font-black text-white mb-3">Assign a role</div>
      <div class="flex flex-col sm:flex-row gap-2">
        <input id="assign-email" type="email" placeholder="staff@email.com (must already have an account)" class="flex-1 bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600">
        <select id="assign-role" class="bg-gray-950 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-600">
          <option value="">Loading roles...</option>
        </select>
        <button onclick="assignStaffRole()" class="bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black text-xs px-5 py-2.5 rounded-xl transition whitespace-nowrap">Assign</button>
      </div>
    </div>
    <div id="staff-list" class="bg-gray-900 glow-border rounded-2xl overflow-hidden">
      <div class="skel h-40"></div>
    </div>`;

  const [rolesRes, staffRes] = await Promise.all([
    adminApi('list_roles'),
    adminApi('list_staff')
  ]);

  if (rolesRes.success) {
    el('assign-role').innerHTML = rolesRes.roles.map(r => `<option value="${r.id}">${r.label}</option>`).join('');
  }

  const listEl = el('staff-list');
  if (!staffRes.success) {
    listEl.innerHTML = `<div class="p-6 text-center text-sm text-red-400">${staffRes.message}</div>`;
    return;
  }

  const staff = staffRes.staff || [];
  if (!staff.length) {
    listEl.innerHTML = `<div class="p-10 text-center text-sm text-gray-500">No staff assigned yet.</div>`;
    return;
  }

  listEl.innerHTML = `
    <table class="w-full text-left">
      <thead><tr class="border-b border-gray-800 text-[9px] text-gray-500 uppercase font-black">
        <th class="px-4 py-3">Name</th><th class="px-4 py-3">Email</th><th class="px-4 py-3">Role</th><th class="px-4 py-3">Status</th><th class="px-4 py-3"></th>
      </tr></thead>
      <tbody>
        ${staff.map(s => `
          <tr class="border-b border-gray-900 text-xs">
            <td class="px-4 py-3 font-bold text-white">${s.full_name}</td>
            <td class="px-4 py-3 text-gray-400">${s.email}</td>
            <td class="px-4 py-3"><span class="badge-perm border-emerald-800 text-emerald-400 bg-emerald-950/30">${s.role_label}</span></td>
            <td class="px-4 py-3">${s.is_active ? '<span class="text-emerald-400 font-bold">Active</span>' : '<span class="text-gray-600 font-bold">Revoked</span>'}</td>
            <td class="px-4 py-3 text-right">${s.is_active ? `<button onclick="revokeStaffAccess(${s.id})" class="text-[10px] font-black text-red-400 hover:text-red-300">Revoke</button>` : ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

async function assignStaffRole() {
  const email = el('assign-email').value.trim();
  const role_id = el('assign-role').value;
  if (!email || !role_id) { alert('Enter an email and select a role.'); return; }
  const res = await adminApi('assign_role', { email, role_id });
  alert(res.message);
  if (res.success) { el('assign-email').value = ''; renderStaffPage(); }
}

async function revokeStaffAccess(staffId) {
  if (!confirm('Revoke this staff member\'s admin access?')) return;
  const res = await adminApi('revoke_access', { staff_id: staffId });
  alert(res.message);
  if (res.success) renderStaffPage();
}

// ============================================================
// ACTIVITY LOG PAGE (Super Admin only)
// ============================================================
async function renderActivityPage() {
  el('page-content').innerHTML = pageHeader('Activity Log', 'Recent actions taken by admin staff.') +
    `<div id="activity-list" class="bg-gray-900 glow-border rounded-2xl overflow-hidden"><div class="skel h-40"></div></div>`;

  const res = await adminApi('activity_log');
  const listEl = el('activity-list');

  if (!res.success) {
    listEl.innerHTML = `<div class="p-6 text-center text-sm text-red-400">${res.message}</div>`;
    return;
  }

  const logs = res.logs || [];
  if (!logs.length) {
    listEl.innerHTML = `<div class="p-10 text-center text-sm text-gray-500">No activity recorded yet.</div>`;
    return;
  }

  listEl.innerHTML = `
    <table class="w-full text-left">
      <thead><tr class="border-b border-gray-800 text-[9px] text-gray-500 uppercase font-black">
        <th class="px-4 py-3">Admin</th><th class="px-4 py-3">Action</th><th class="px-4 py-3">Details</th><th class="px-4 py-3">When</th>
      </tr></thead>
      <tbody>
        ${logs.map(l => `
          <tr class="border-b border-gray-900 text-xs">
            <td class="px-4 py-3 font-bold text-white">${l.admin_name}</td>
            <td class="px-4 py-3 text-emerald-400 font-bold">${l.action}</td>
            <td class="px-4 py-3 text-gray-400">${l.details || (l.target_type ? `${l.target_type} #${l.target_id}` : '—')}</td>
            <td class="px-4 py-3 text-gray-500">${fmtDate(l.created_at)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

// ============================================================
// INIT
// ============================================================
checkExistingSession();
</script>
</body>
</html>
