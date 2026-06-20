<?php
// api/auth.php
require_once 'config.php';
session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(false, "Method not allowed");
}

$body   = getBody();
$action = clean($body['action'] ?? '');

// ============================================================
// HELPER: Build user profile (same shape as login.php)
// ============================================================
function buildUserProfile($user) {
    return [
        "id"             => (int)$user['id'],
        "full_name"      => $user['full_name'],
        "name"           => $user['full_name'],
        "email"          => $user['email'],
        "phone"          => $user['phone']          ?? '',
        "role"           => $user['role']            ?? 'user',
        "state"          => $user['state']           ?? '',
        "lga"            => $user['lga']             ?? '',
        "town"           => $user['town']            ?? '',
        "wallet_balance" => (float)($user['wallet_balance'] ?? 0),
        "balance"        => (float)($user['wallet_balance'] ?? 0),
        "kycStatus"      => $user['kyc_status']      ?? 'unverified',
        "vendorTier"     => $user['vendor_tier']     ?? 'free',
        "avatar"         => $user['avatar']          ?? null,
        "referral_code"  => $user['referral_code']   ?? null,
        "accountNum"     => 'EM-' . $user['id'],
    ];
}

// ============================================================
// HELPER: Fetch full user row
// ============================================================
function fetchUser($pdo, $id) {
    $stmt = $pdo->prepare("
        SELECT id, full_name, email, phone, password_hash, role,
               state, lga, town, wallet_balance, kyc_status,
               vendor_tier, avatar, referral_code, is_suspended, transaction_pin
        FROM users WHERE id = ? LIMIT 1
    ");
    $stmt->execute([$id]);
    return $stmt->fetch();
}

// ============================================================
// ROUTE
// ============================================================
switch ($action) {

    // ----------------------------------------------------------
    // LOGIN — also handles auth.php login path from frontend
    // ----------------------------------------------------------
    case 'login':
        $identifier = clean($body['identifier'] ?? $body['email'] ?? '');
        $password   = $body['password'] ?? '';

        if (empty($identifier) || empty($password)) {
            respond(false, "Email/phone and password are required.");
        }

        // Find user by email or phone
        $is_email = filter_var($identifier, FILTER_VALIDATE_EMAIL);
        $col      = $is_email ? 'email' : 'phone';
        $stmt     = $pdo->prepare("
            SELECT id, full_name, email, phone, password_hash, role,
                   state, lga, town, wallet_balance, kyc_status,
                   vendor_tier, avatar, referral_code, is_suspended
            FROM users WHERE $col = ? LIMIT 1
        ");
        $stmt->execute([$identifier]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password_hash'])) {
            respond(false, "Incorrect email/phone or password.");
        }

        if ((int)$user['is_suspended'] === 1) {
            respond(false, "Account suspended. Contact help@ememart.com");
        }

        // Set session
        $_SESSION['user_id']   = $user['id'];
        $_SESSION['user_role'] = $user['role'];

        // Update last_login
        $pdo->prepare("UPDATE users SET last_login = NOW() WHERE id = ?")
            ->execute([$user['id']]);

        respond(true, "Login successful.", ["user" => buildUserProfile($user)]);
        break;

    // ----------------------------------------------------------
    // LOGOUT
    // ----------------------------------------------------------
    case 'logout':
        $_SESSION = [];
        session_destroy();
        respond(true, "Logged out successfully.");
        break;

    // ----------------------------------------------------------
    // REGISTER PENDING — store pending registration in session
    // while user waits for OTP verification
    // ----------------------------------------------------------
    case 'register_pending':
        $full_name = clean($body['full_name'] ?? '');
        $email     = clean($body['email']     ?? '');
        $phone     = clean($body['phone']     ?? '');
        $password  = $body['password']        ?? '';
        $role      = clean($body['role']      ?? 'user');
        $state     = clean($body['state']     ?? '');
        $lga       = clean($body['lga']       ?? '');
        $town      = clean($body['town']      ?? '');

        if (empty($full_name) || empty($email) || empty($password)) {
            respond(false, "Full name, email and password are required.");
        }

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            respond(false, "Invalid email address.");
        }

        // Check if email already registered
        $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            respond(false, "This email is already registered. Please sign in.");
        }

        // Save to session
        $_SESSION['pending_reg'] = [
            'full_name' => $full_name,
            'email'     => $email,
            'phone'     => $phone,
            'password'  => $password,
            'role'      => $role,
            'state'     => $state,
            'lga'       => $lga,
            'town'      => $town,
            'created_at'=> time(),
        ];

        respond(true, "Registration data saved. OTP sent.");
        break;

    // ----------------------------------------------------------
    // RESEND OTP
    // ----------------------------------------------------------
    case 'resend_otp':
        $pending = $_SESSION['pending_reg'] ?? null;
        $email   = clean($body['email'] ?? ($pending['email'] ?? ''));

        if (empty($email)) {
            respond(false, "Email not found. Please start registration again.");
        }

        // Rate limit: max 3 in 10 minutes
        $stmt = $pdo->prepare("
            SELECT COUNT(*) as total FROM email_otps
            WHERE email = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        ");
        $stmt->execute([$email]);
        $row = $stmt->fetch();
        if ((int)$row['total'] >= 3) {
            respond(false, "Too many OTP requests. Please wait 10 minutes.");
        }

        // Delete old OTPs
        $pdo->prepare("DELETE FROM email_otps WHERE email = ?")
            ->execute([$email]);

        // Generate new OTP
        $otp        = (string)random_int(100000, 999999);
        $otp_hash   = password_hash($otp, PASSWORD_DEFAULT);
        $expires_at = date("Y-m-d H:i:s", strtotime("+10 minutes"));

        $pdo->prepare("
            INSERT INTO email_otps (email, otp_code, expires_at, created_at)
            VALUES (?, ?, ?, NOW())
        ")->execute([$email, $otp_hash, $expires_at]);

        // Send email
        $subject  = "$otp is your Ememart Verification Code";
        $message  = "<p>Your new OTP is: <strong>$otp</strong>. Expires in 10 minutes.</p>";
        $headers  = "MIME-Version: 1.0\r\nContent-type: text/html; charset=UTF-8\r\n";
        $headers .= "From: Ememart <noreply@ememart.com>\r\n";
        @mail($email, $subject, $message, $headers);

        respond(true, "A new OTP has been sent to $email.");
        break;

    // ----------------------------------------------------------
    // FORGOT — SEND OTP
    // ----------------------------------------------------------
    case 'forgot_send_otp':
        $email   = clean($body['email']   ?? '');
        $channel = clean($body['channel'] ?? 'email');

        if (empty($email) || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            respond(false, "Enter a valid email address.");
        }

        // Check email exists
        $stmt = $pdo->prepare("SELECT id, full_name FROM users WHERE email = ? LIMIT 1");
        $stmt->execute([$email]);
        $user = $stmt->fetch();
        if (!$user) {
            respond(false, "No account found with that email address.");
        }

        // Rate limit
        $stmt = $pdo->prepare("
            SELECT COUNT(*) as total FROM email_otps
            WHERE email = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        ");
        $stmt->execute([$email]);
        $row = $stmt->fetch();
        if ((int)$row['total'] >= 3) {
            respond(false, "Too many reset requests. Please wait 10 minutes.");
        }

        // Delete old OTPs
        $pdo->prepare("DELETE FROM email_otps WHERE email = ?")->execute([$email]);

        // Generate OTP
        $otp        = (string)random_int(100000, 999999);
        $otp_hash   = password_hash($otp, PASSWORD_DEFAULT);
        $expires_at = date("Y-m-d H:i:s", strtotime("+10 minutes"));

        $pdo->prepare("
            INSERT INTO email_otps (email, otp_code, expires_at, created_at, purpose)
            VALUES (?, ?, ?, NOW(), 'forgot')
        ")->execute([$email, $otp_hash, $expires_at]);

        // Send email
        $name     = $user['full_name'];
        $subject  = "$otp — Ememart Password Reset Code";
        $message  = "
        <div style='font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;'>
            <h2 style='color:#0d9488;'>Password Reset</h2>
            <p>Hello $name,</p>
            <p>Use this code to reset your Ememart password:</p>
            <div style='font-size:32px;font-weight:bold;letter-spacing:5px;
                        text-align:center;padding:20px;background:#f3f4f6;
                        border-radius:8px;margin:20px 0;'>$otp</div>
            <p style='color:#6b7280;font-size:12px;'>
                Expires in 10 minutes. If you did not request this, ignore this email.
            </p>
        </div>";
        $headers  = "MIME-Version: 1.0\r\nContent-type: text/html; charset=UTF-8\r\n";
        $headers .= "From: Ememart <noreply@ememart.com>\r\n";
        @mail($email, $subject, $message, $headers);

        // Store email in session for next step
        $_SESSION['forgot_email'] = $email;

        respond(true, "Password reset OTP sent to $email.");
        break;

    // ----------------------------------------------------------
    // FORGOT — VERIFY OTP
    // ----------------------------------------------------------
    case 'forgot_verify_otp':
        $otp   = clean($body['otp']   ?? '');
        $email = clean($body['email'] ?? ($_SESSION['forgot_email'] ?? ''));

        if (empty($otp) || empty($email)) {
            respond(false, "OTP and email are required.");
        }

        $stmt = $pdo->prepare("
            SELECT id, otp_code FROM email_otps
            WHERE email = ? AND is_used = 0
            AND expires_at > NOW() AND purpose = 'forgot'
            ORDER BY created_at DESC LIMIT 1
        ");
        $stmt->execute([$email]);
        $record = $stmt->fetch();

        if (!$record || !password_verify($otp, $record['otp_code'])) {
            respond(false, "Invalid or expired OTP.");
        }

        // Mark OTP as used
        $pdo->prepare("UPDATE email_otps SET is_used = 1 WHERE id = ?")
            ->execute([$record['id']]);

        // Store verified state in session
        $_SESSION['forgot_verified'] = $email;

        respond(true, "OTP verified. You may now reset your password.");
        break;

    // ----------------------------------------------------------
    // FORGOT — RESET PASSWORD
    // ----------------------------------------------------------
    case 'forgot_reset_password':
        $email       = clean($body['email']        ?? ($_SESSION['forgot_verified'] ?? ''));
        $password    = $body['new_password']        ?? $body['password'] ?? '';
        $confirm     = $body['confirm_password']    ?? $body['confirm']  ?? '';

        if (empty($email)) {
            respond(false, "Session expired. Please start the reset process again.");
        }

        // Must have passed OTP verification
        if (($_SESSION['forgot_verified'] ?? '') !== $email) {
            respond(false, "OTP verification required before resetting password.");
        }

        if (empty($password)) {
            respond(false, "New password is required.");
        }

        if (strlen($password) < 6) {
            respond(false, "Password must be at least 6 characters.");
        }

        if (!empty($confirm) && $password !== $confirm) {
            respond(false, "Passwords do not match.");
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        $stmt = $pdo->prepare("UPDATE users SET password_hash = ? WHERE email = ?");
        $stmt->execute([$hash, $email]);

        if ($stmt->rowCount() === 0) {
            respond(false, "Account not found.");
        }

        // Clear session
        unset($_SESSION['forgot_email'], $_SESSION['forgot_verified']);

        respond(true, "Password reset successfully. You can now sign in.");
        break;

    // ----------------------------------------------------------
    // GOOGLE LOGIN — verify Google ID token and sign in / register
    // ----------------------------------------------------------
    case 'google_login':
        $id_token = clean($body['id_token'] ?? '');
        if (empty($id_token)) respond(false, "Google token is required.");

        // Verify token with Google
        $google_client_id = GOOGLE_CLIENT_ID;
        $ch = curl_init(
            "https://oauth2.googleapis.com/tokeninfo?id_token=" . urlencode($id_token)
        );
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $google_data = json_decode(curl_exec($ch), true);
        curl_close($ch);

        if (
            empty($google_data['email_verified']) ||
            $google_data['email_verified'] !== 'true' ||
            ($google_data['aud'] ?? '') !== $google_client_id
        ) {
            respond(false, "Google verification failed. Please try again.");
        }

        $g_email  = clean($google_data['email']            ?? '');
        $g_name   = clean($google_data['name']             ?? '');
        $g_avatar = clean($google_data['picture']          ?? '');
        $g_sub    = clean($google_data['sub']              ?? '');

        if (empty($g_email)) respond(false, "Could not retrieve email from Google.");

        // Check if user exists
        $stmt = $pdo->prepare("
            SELECT id, full_name, email, phone, role, state, lga, town,
                   wallet_balance, kyc_status, vendor_tier, avatar,
                   referral_code, is_suspended
            FROM users WHERE email = ? LIMIT 1
        ");
        $stmt->execute([$g_email]);
        $user = $stmt->fetch();

        if ($user) {
            // Existing user — sign in
            if ((int)$user['is_suspended'] === 1) {
                respond(false, "Account suspended. Contact help@ememart.com");
            }

            // Update avatar if changed
            $pdo->prepare("UPDATE users SET avatar = ?, last_login = NOW() WHERE id = ?")
                ->execute([$g_avatar, $user['id']]);
            $user['avatar'] = $g_avatar;

        } else {
            // New user — auto-register via Google
            $referral_code = strtoupper(substr(md5($g_email . time()), 0, 8));
            $stmt = $pdo->prepare("
                INSERT INTO users (
                    full_name, email, password_hash, phone, role,
                    state, lga, town, wallet_balance, kyc_status,
                    vendor_tier, avatar, referral_code, is_verified,
                    is_suspended, google_sub, created_at, last_login
                ) VALUES (
                    ?, ?, '', '', 'user',
                    '', '', '', 0.00, 'unverified',
                    'free', ?, ?, 1,
                    0, ?, NOW(), NOW()
                )
            ");
            $stmt->execute([$g_name, $g_email, $g_avatar, $referral_code, $g_sub]);
            $new_id = (int)$pdo->lastInsertId();

            // Create wallet row
            $pdo->prepare("INSERT INTO wallets (user_id, balance, created_at) VALUES (?, 0.00, NOW())")
                ->execute([$new_id]);

            $user = fetchUser($pdo, $new_id);
        }

        // Set session
        $_SESSION['user_id']   = $user['id'];
        $_SESSION['user_role'] = $user['role'];

        respond(true, "Google sign-in successful.", ["user" => buildUserProfile($user)]);
        break;

    // ----------------------------------------------------------
    // DEFAULT
    // ----------------------------------------------------------
    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
