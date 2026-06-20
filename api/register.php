<?php
// api/register.php
require_once 'config.php';

// Only allow POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(false, "Method not allowed");
}

// ============================================================
// GET & VALIDATE INPUT
// ============================================================
$body      = getBody();
$full_name = clean($body['full_name'] ?? '');
$email     = clean($body['email']     ?? '');
$password  = $body['password']        ?? '';
$phone     = clean($body['phone']     ?? '');
$role      = clean($body['role']      ?? 'user');
$state     = clean($body['state']     ?? '');
$lga       = clean($body['lga']       ?? '');
$town      = clean($body['town']      ?? '');
$otp_code  = clean($body['otp_code']  ?? '');

// Required field check
if (empty($full_name) || empty($email) || empty($password) ||
    empty($state)     || empty($lga)   || empty($town) || empty($otp_code)) {
    respond(false, "All required fields must be filled.");
}

// Validate email
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(false, "Invalid email address.");
}

// Validate password length
if (strlen($password) < 6) {
    respond(false, "Password must be at least 6 characters.");
}

// Validate role
$allowed_roles = ['user', 'vendor', 'artisan', 'rider'];
if (!in_array($role, $allowed_roles)) {
    $role = 'user';
}

// ============================================================
// VERIFY OTP — compare against hashed OTP stored by otp.php
// ============================================================
try {
    $stmt = $pdo->prepare("
        SELECT id, otp_code FROM email_otps
        WHERE email = ? AND is_used = 0 AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
    ");
    $stmt->execute([$email]);
    $otpRecord = $stmt->fetch();

    if (!$otpRecord || !password_verify($otp_code, $otpRecord['otp_code'])) {
        respond(false, "Invalid or expired verification code. Please request a new OTP.");
    }

    // ============================================================
    // CHECK EMAIL NOT ALREADY REGISTERED
    // ============================================================
    $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        respond(false, "This email is already registered. Please sign in instead.");
    }

    // Check phone not already taken (if provided)
    if (!empty($phone)) {
        $stmt = $pdo->prepare("SELECT id FROM users WHERE phone = ? LIMIT 1");
        $stmt->execute([$phone]);
        if ($stmt->fetch()) {
            respond(false, "This phone number is already linked to an account.");
        }
    }

    // ============================================================
    // GENERATE UNIQUE REFERRAL CODE
    // ============================================================
    $referral_code = strtoupper(substr(md5($email . time()), 0, 8));

    // Make sure it's unique
    do {
        $stmt = $pdo->prepare("SELECT id FROM users WHERE referral_code = ? LIMIT 1");
        $stmt->execute([$referral_code]);
        $exists = $stmt->fetch();
        if ($exists) {
            $referral_code = strtoupper(substr(md5($email . microtime()), 0, 8));
        }
    } while ($exists);

    // ============================================================
    // HASH PASSWORD & INSERT USER
    // ============================================================
    $password_hash = password_hash($password, PASSWORD_BCRYPT);

    $stmt = $pdo->prepare("
        INSERT INTO users (
            full_name, email, password_hash, phone, role,
            state, lga, town, wallet_balance, kyc_status,
            vendor_tier, referral_code, is_verified, is_suspended,
            created_at, last_login
        ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, 0.00, 'unverified',
            'free', ?, 1, 0,
            NOW(), NOW()
        )
    ");
    $stmt->execute([
        $full_name, $email, $password_hash, $phone, $role,
        $state, $lga, $town, $referral_code
    ]);

    $new_user_id = (int)$pdo->lastInsertId();

    // ============================================================
    // CREATE WALLET ROW (keeps wallets table in sync too)
    // ============================================================
    $stmt = $pdo->prepare("
        INSERT INTO wallets (user_id, balance, created_at)
        VALUES (?, 0.00, NOW())
    ");
    $stmt->execute([$new_user_id]);

    // ============================================================
    // MARK OTP AS USED
    // ============================================================
    $stmt = $pdo->prepare("UPDATE email_otps SET is_used = 1 WHERE id = ?");
    $stmt->execute([$otpRecord['id']]);

    // ============================================================
    // SEND WELCOME EMAIL
    // ============================================================
    $welcome_subject = "Welcome to Ememart, $full_name!";
    $welcome_body    = "
    <div style='font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;
                padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;'>
        <h2 style='color: #0d9488; text-align: center;'>Welcome to Ememart! 🎉</h2>
        <p>Hello $full_name,</p>
        <p>Your account has been created successfully. Here are your details:</p>
        <ul style='line-height: 2;'>
            <li><strong>Email:</strong> $email</li>
            <li><strong>Role:</strong> " . ucfirst($role) . "</li>
            <li><strong>Referral Code:</strong> <span style='color:#0d9488;font-weight:bold;'>$referral_code</span></li>
            <li><strong>Account ID:</strong> EM-$new_user_id</li>
        </ul>
        <p>Share your referral code with friends and earn cashback on every successful referral!</p>
        <hr style='border:none; border-top:1px solid #e0e0e0; margin:20px 0;'>
        <p style='font-size: 11px; color: #9ca3af; text-align: center;'>
            &copy; " . date('Y') . " Ememart Solutions &bull; Nnewi, Anambra State, Nigeria<br>
            Need help? <a href='mailto:help@ememart.com'>help@ememart.com</a>
        </p>
    </div>";

    $headers  = "MIME-Version: 1.0\r\n";
    $headers .= "Content-type: text/html; charset=UTF-8\r\n";
    $headers .= "From: Ememart <" . SMTP_EMAIL . ">\r\n";
    @mail($email, $welcome_subject, $welcome_body, $headers);

    // ============================================================
    // RETURN FULL USER PROFILE (same shape as login.php)
    // ============================================================
    respond(true, "Account created successfully! Welcome to Ememart.", [
        "user" => [
            "id"             => $new_user_id,
            "full_name"      => $full_name,
            "name"           => $full_name,
            "email"          => $email,
            "phone"          => $phone,
            "role"           => $role,
            "state"          => $state,
            "lga"            => $lga,
            "town"           => $town,
            "wallet_balance" => 0.00,
            "balance"        => 0.00,
            "kycStatus"      => "unverified",
            "vendorTier"     => "free",
            "avatar"         => null,
            "referral_code"  => $referral_code,
            "accountNum"     => "EM-$new_user_id",
        ]
    ]);

} catch (Exception $e) {
    http_response_code(500);
    respond(false, "Registration failed. Please try again.");
}
?>
