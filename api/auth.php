<?php
// ============================================================
// EMEMART — auth.php
// ============================================================

require_once __DIR__ . '/config.php';

setCORSHeaders();
header('Content-Type: application/json');

$action = post('action');

switch ($action) {

    // ----------------------------------------------------------
    // REGISTER — Step 1: validate + send OTP to email
    // ----------------------------------------------------------
    case 'register_send_otp':
        $full_name = post('full_name');
        $email     = post('email');
        $phone     = post('phone');
        $password  = post('password');

        if (!$full_name || !$email || !$phone || !$password)
            respond(false, 'All fields are required.');

        if (!isEmail($email))
            respond(false, 'Enter a valid email address.');

        if (strlen($password) < 6)
            respond(false, 'Password must be at least 6 characters.');

        $db = getDB();

        $stmt = $db->prepare('SELECT id FROM users WHERE email = ? OR phone = ? LIMIT 1');
        $stmt->execute([$email, $phone]);
        if ($stmt->fetch())
            respond(false, 'An account with this email or phone already exists.');

        $otp = generateOTP();
        $db->prepare('DELETE FROM otp_codes WHERE email = ? AND purpose = ?')
           ->execute([$email, 'register']);
        $db->prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
           ->execute([$email, $otp, 'register', date('Y-m-d H:i:s', time() + OTP_EXPIRY_MINUTES * 60)]);

        if (!sendOTPEmail($email, $full_name, $otp, 'registration'))
            respond(false, 'Could not send OTP email. Please try again.');

        respond(true, 'OTP sent to your email address.', ['email' => $email]);
        break;

    // ----------------------------------------------------------
    // REGISTER — Step 2: verify OTP + create account
    // ----------------------------------------------------------
    case 'register_verify_otp':
        $email     = post('email');
        $code      = post('code');
        $full_name = post('full_name');
        $phone     = post('phone');
        $password  = post('password');
        $role      = post('role') ?: 'user';
        $town      = post('town');
        $lga       = post('lga');
        $state     = post('state');

        if (!$email || !$code)
            respond(false, 'Email and OTP code are required.');

        $db = getDB();

        $stmt = $db->prepare('
            SELECT id FROM otp_codes
            WHERE email = ? AND code = ? AND purpose = ? AND expires_at > NOW() AND used = 0
            LIMIT 1
        ');
        $stmt->execute([$email, $code, 'register']);
        $otp = $stmt->fetch();
        if (!$otp)
            respond(false, 'Invalid or expired OTP. Please try again.');

        $db->prepare('UPDATE otp_codes SET used = 1 WHERE id = ?')
           ->execute([$otp['id']]);

        $username = strtolower(str_replace(' ', '_', $full_name)) . '_' . substr(uniqid(), -4);
        $hash     = password_hash($password, PASSWORD_BCRYPT);

        $db->prepare('
            INSERT INTO users (full_name, email, phone, username, password_hash, role, town, lga, state, verified)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ')->execute([$full_name, $email, $phone, $username, $hash, $role, $town, $lga, $state]);

        $userId = (int) $db->lastInsertId();

        // Create wallet
        $db->prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)')
           ->execute([$userId]);

        $token = generateToken();
        $db->prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
           ->execute([$token, $userId, date('Y-m-d H:i:s', time() + SESSION_EXPIRY_HOURS * 3600)]);

        setcookie('ememart_session', $token, [
            'expires'  => time() + SESSION_EXPIRY_HOURS * 3600,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'None',
            'secure'   => true,
        ]);

        $user = fetchUserById($db, $userId);
        respond(true, 'Account created successfully! Welcome to Ememart.', [
            'token' => $token,
            'user'  => $user,
        ]);
        break;

    // ----------------------------------------------------------
    // LOGIN
    // ----------------------------------------------------------
    case 'login':
        $identifier = post('identifier');
        $password   = post('password');

        if (!$identifier || !$password)
            respond(false, 'Please enter your credentials.');

        $db   = getDB();
        $stmt = $db->prepare('
            SELECT * FROM users
            WHERE (email = ? OR phone = ? OR username = ?)
            AND is_suspended = 0
            LIMIT 1
        ');
        $stmt->execute([$identifier, $identifier, $identifier]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($password, $user['password_hash']))
            respond(false, 'Invalid credentials. Please try again.');

        $token = generateToken();
        $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$user['id']]);
        $db->prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
           ->execute([$token, $user['id'], date('Y-m-d H:i:s', time() + SESSION_EXPIRY_HOURS * 3600)]);

        setcookie('ememart_session', $token, [
            'expires'  => time() + SESSION_EXPIRY_HOURS * 3600,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'None',
            'secure'   => true,
        ]);

        respond(true, 'Welcome back, ' . explode(' ', $user['full_name'])[0] . '!', [
            'token' => $token,
            'user'  => sanitizeUser($user),
        ]);
        break;

    // ----------------------------------------------------------
    // LOGOUT
    // ----------------------------------------------------------
    case 'logout':
        $user = getAuthUser();
        if ($user) {
            getDB()->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$user['id']]);
        }
        setcookie('ememart_session', '', ['expires' => time() - 3600, 'path' => '/']);
        respond(true, 'Logged out successfully.');
        break;

    // ----------------------------------------------------------
    // FORGOT PASSWORD — send OTP
    // ----------------------------------------------------------
    case 'forgot_send_otp':
        $email = post('email');
        if (!$email || !isEmail($email))
            respond(false, 'Enter a valid email address.');

        $db   = getDB();
        $stmt = $db->prepare('SELECT id, full_name FROM users WHERE email = ? LIMIT 1');
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user)
            respond(false, 'No account found with that email address.');

        $otp = generateOTP();
        $db->prepare('DELETE FROM otp_codes WHERE email = ? AND purpose = ?')
           ->execute([$email, 'reset']);
        $db->prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
           ->execute([$email, $otp, 'reset', date('Y-m-d H:i:s', time() + OTP_EXPIRY_MINUTES * 60)]);

        if (!sendOTPEmail($email, $user['full_name'], $otp, 'password reset'))
            respond(false, 'Could not send OTP email. Please try again.');

        respond(true, 'Password reset OTP sent to your email.', ['email' => $email]);
        break;

    // ----------------------------------------------------------
    // FORGOT PASSWORD — verify OTP + reset
    // ----------------------------------------------------------
    case 'forgot_verify_otp':
        $email    = post('email');
        $code     = post('code');
        $password = post('password');

        if (!$email || !$code || !$password)
            respond(false, 'All fields are required.');

        if (strlen($password) < 6)
            respond(false, 'Password must be at least 6 characters.');

        $db   = getDB();
        $stmt = $db->prepare('
            SELECT id FROM otp_codes
            WHERE email = ? AND code = ? AND purpose = ? AND expires_at > NOW() AND used = 0
            LIMIT 1
        ');
        $stmt->execute([$email, $code, 'reset']);
        $otp = $stmt->fetch();
        if (!$otp)
            respond(false, 'Invalid or expired OTP.');

        $db->prepare('UPDATE otp_codes SET used = 1 WHERE id = ?')->execute([$otp['id']]);
        $hash = password_hash($password, PASSWORD_BCRYPT);
        $db->prepare('UPDATE users SET password_hash = ? WHERE email = ?')
           ->execute([$hash, $email]);

        respond(true, 'Password reset successfully. You can now sign in.');
        break;

    // ----------------------------------------------------------
    // GET CURRENT USER
    // ----------------------------------------------------------
    case 'get_user':
        $user = requireAuth();
        respond(true, 'OK', ['user' => sanitizeUser($user)]);
        break;

    // ----------------------------------------------------------
    // GOOGLE LOGIN
    // ----------------------------------------------------------
    case 'google_login':
        $google_id = post('google_id');
        $email     = post('email');
        $name      = post('name');
        $picture   = post('picture');

        if (!$google_id || !$email)
            respond(false, 'Invalid Google credentials.');

        $db   = getDB();
        $stmt = $db->prepare('SELECT * FROM users WHERE google_id = ? OR email = ? LIMIT 1');
        $stmt->execute([$google_id, $email]);
        $user = $stmt->fetch();

        if ($user) {
            if (!$user['google_id']) {
                $db->prepare('UPDATE users SET google_id = ?, avatar = ? WHERE id = ?')
                   ->execute([$google_id, $picture, $user['id']]);
            }
        } else {
            $username = strtolower(str_replace(' ', '_', $name)) . '_' . substr(uniqid(), -4);
            $db->prepare('
                INSERT INTO users (full_name, email, phone, username, password_hash, google_id, avatar, verified)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ')->execute([$name, $email, '', $username, '', $google_id, $picture]);
            $userId = (int) $db->lastInsertId();
            $db->prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)')->execute([$userId]);
            $user = fetchUserById($db, $userId);
        }

        $token = generateToken();
        $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$user['id']]);
        $db->prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
           ->execute([$token, $user['id'], date('Y-m-d H:i:s', time() + SESSION_EXPIRY_HOURS * 3600)]);

        setcookie('ememart_session', $token, [
            'expires'  => time() + SESSION_EXPIRY_HOURS * 3600,
            'path'     => '/',
            'httponly' => true,
            'samesite' => 'None',
            'secure'   => true,
        ]);

        respond(true, 'Signed in with Google.', [
            'token' => $token,
            'user'  => sanitizeUser($user),
        ]);
        break;

    default:
        respond(false, 'Unknown action.');
}

// ============================================================
// HELPERS
// ============================================================

function fetchUserById(PDO $db, int $id): array {
    $stmt = $db->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    return sanitizeUser($stmt->fetch());
}

function sanitizeUser(array $user): array {
    unset($user['password_hash']);
    return $user;
}
