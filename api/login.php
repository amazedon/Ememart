<?php
// api/login.php
require_once 'config.php';

// Only allow POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(false, "Method not allowed");
}

// ============================================================
// GET & VALIDATE INPUT
// ============================================================
$body       = getBody();
$identifier = clean($body['email'] ?? $body['identifier'] ?? '');
$password   = $body['password'] ?? '';

if (empty($identifier) || empty($password)) {
    respond(false, "Email/phone and password are required.");
}

// Validate: must be email or phone number
$is_email = filter_var($identifier, FILTER_VALIDATE_EMAIL);
$is_phone = preg_match('/^[0-9+\s\-]{7,15}$/', $identifier);

if (!$is_email && !$is_phone) {
    respond(false, "Enter a valid email address or phone number.");
}

// ============================================================
// BRUTE FORCE PROTECTION — max 5 failed attempts per 15 mins
// ============================================================
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$stmt = $pdo->prepare("
    SELECT COUNT(*) as attempts FROM login_attempts
    WHERE identifier = ? AND ip_address = ?
    AND attempted_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
    AND success = 0
");
$stmt->execute([$identifier, $ip]);
$row = $stmt->fetch();
if ((int)$row['attempts'] >= 5) {
    respond(false, "Too many failed login attempts. Please wait 15 minutes and try again.");
}

// ============================================================
// LOOK UP USER BY EMAIL OR PHONE
// ============================================================
if ($is_email) {
    $stmt = $pdo->prepare("
        SELECT id, full_name, email, phone, password_hash, role,
               state, lga, town, wallet_balance, kyc_status,
               vendor_tier, avatar, referral_code, is_suspended
        FROM users WHERE email = ? LIMIT 1
    ");
    $stmt->execute([$identifier]);
} else {
    $stmt = $pdo->prepare("
        SELECT id, full_name, email, phone, password_hash, role,
               state, lga, town, wallet_balance, kyc_status,
               vendor_tier, avatar, referral_code, is_suspended
        FROM users WHERE phone = ? LIMIT 1
    ");
    $stmt->execute([$identifier]);
}

$user = $stmt->fetch();

// ============================================================
// VERIFY USER EXISTS & PASSWORD MATCHES
// ============================================================
if (!$user || !password_verify($password, $user['password_hash'])) {
    // Log failed attempt
    $stmt = $pdo->prepare("
        INSERT INTO login_attempts (identifier, ip_address, success, attempted_at)
        VALUES (?, ?, 0, NOW())
    ");
    $stmt->execute([$identifier, $ip]);
    respond(false, "Incorrect email/phone or password.");
}

// ============================================================
// CHECK IF ACCOUNT IS SUSPENDED
// ============================================================
if ((int)$user['is_suspended'] === 1) {
    respond(false, "Your account has been suspended. Contact support at help@ememart.com");
}

// ============================================================
// LOG SUCCESSFUL ATTEMPT & UPDATE last_login
// ============================================================
$stmt = $pdo->prepare("
    INSERT INTO login_attempts (identifier, ip_address, success, attempted_at)
    VALUES (?, ?, 1, NOW())
");
$stmt->execute([$identifier, $ip]);

$stmt = $pdo->prepare("UPDATE users SET last_login = NOW() WHERE id = ?");
$stmt->execute([$user['id']]);

// ============================================================
// RETURN FULL USER PROFILE TO FRONTEND
// ============================================================
respond(true, "Login successful.", [
    "user" => [
        "id"            => (int)$user['id'],
        "full_name"     => $user['full_name'],
        "name"          => $user['full_name'],
        "email"         => $user['email'],
        "phone"         => $user['phone'],
        "role"          => $user['role'] ?? 'user',
        "state"         => $user['state'],
        "lga"           => $user['lga'],
        "town"          => $user['town'],
        "wallet_balance"=> (float)($user['wallet_balance'] ?? 0),
        "balance"       => (float)($user['wallet_balance'] ?? 0),
        "kycStatus"     => $user['kyc_status'] ?? 'unverified',
        "vendorTier"    => $user['vendor_tier'] ?? 'free',
        "avatar"        => $user['avatar'] ?? null,
        "referral_code" => $user['referral_code'] ?? null,
        "accountNum"    => 'EM-' . $user['id'],
    ]
]);
?>
