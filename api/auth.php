<?php
// ============================================================
// EMEMART — auth.php
// Handles: register, send OTP, verify OTP,
//          login (email/phone/username), logout,
//          forgot password, reset password
// ============================================================

require_once __DIR__ . '/config.php';

// PHPMailer (install via Composer or upload manually)
use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;
require_once __DIR__ . '/vendor/autoload.php';

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

        // Check duplicates
        $stmt = $db->prepare('SELECT id FROM users WHERE email = ? OR phone = ? LIMIT 1');
        $stmt->execute([$email, $phone]);
        if ($stmt->fetch())
            respond(false, 'An account with this email or phone already exists.');

        // Generate and store OTP
        $otp = generateOTP();
        $db->prepare('DELETE FROM otp_codes WHERE email = ? AND purpose = ?')
           ->execute([$email, 'register']);
        $db->prepare('INSERT INTO otp_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)')
           ->execute([$email, $otp, 'register', date('Y-m-d H:i:s', time() + OTP_EXPIRY_MINUTES * 60)]);

        // Send email
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

        // Validate OTP
        $stmt = $db->prepare('
            SELECT id FROM otp_codes
            WHERE email = ? AND code = ? AND purpose = ? AND expires_at > NOW() AND used = 0
            LIMIT 1
        ');
        $stmt->execute([$email, $code, 'register']);
        $otp = $stmt->fetch();
        if (!$otp)
            respond(false, 'Invalid or expired OTP. Please try again.');

        // Mark OTP used
        $db->prepare('UPDATE otp_codes SET used = 1 WHERE id = ?')
           ->execute([$otp['id']]);

        // Create username from name
        $username = strtolower(str_replace(' ', '_', $full_name)) . '_' . substr(uniqid(), -4);

        // Create user
        $hash = password_hash($password, PASSWORD_BCRYPT);
        $db->prepare('
            INSERT INTO users (full_name, email, phone, username, password_hash, role, town, lga, state, verified)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ')->execute([$full_name, $email, $phone, $username, $hash, $role, $town, $lga, $state]);

        $userId = (int) $db->lastInsertId();

        // Create session
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
    // LOGIN — accepts email, phone, or username
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

        // Create session
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
    // FORGOT PASSWORD — verify OTP + set new password
    // ----------------------------------------------------------
    case 'forgot_verify_otp':
        $email    = post('email');
        $code     = post('code');
        $password = post('password');

        if (!$email || !$code || !$password)
            respond(false, 'All fields are required.');

        if (strlen($password) < 6)
            respond(false, 'Password must be at least 6 characters.');

        $db = getDB();

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
    // GET CURRENT USER (from session)
    // ----------------------------------------------------------
    case 'get_user':
        $user = requireAuth();
        respond(true, 'OK', ['user' => sanitizeUser($user)]);
        break;

    // ----------------------------------------------------------
    // GOOGLE LOGIN
    // ----------------------------------------------------------
    case 'google_login':
        $google_id  = post('google_id');
        $email      = post('email');
        $name       = post('name');
        $picture    = post('picture');

        if (!$google_id || !$email)
            respond(false, 'Invalid Google credentials.');

        $db = getDB();

        // Check if user exists
        $stmt = $db->prepare('SELECT * FROM users WHERE google_id = ? OR email = ? LIMIT 1');
        $stmt->execute([$google_id, $email]);
        $user = $stmt->fetch();

        if ($user) {
            // Update Google ID if missing
            if (!$user['google_id']) {
                $db->prepare('UPDATE users SET google_id = ?, avatar = ? WHERE id = ?')
                   ->execute([$google_id, $picture, $user['id']]);
            }
        } else {
            // Create new Google user
            $username = strtolower(str_replace(' ', '_', $name)) . '_' . substr(uniqid(), -4);
            $db->prepare('
                INSERT INTO users (full_name, email, phone, username, password_hash, google_id, avatar, verified)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            ')->execute([$name, $email, '', $username, '', $google_id, $picture]);
            $userId = (int) $db->lastInsertId();
            $user   = fetchUserById($db, $userId);
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

function sendOTPEmail(string $to, string $name, string $otp, string $purpose): bool {
    $mail = new PHPMailer(true);
    try {
        $mail->isSMTP();
        $mail->Host       = SMTP_HOST;
        $mail->SMTPAuth   = true;
        $mail->Username   = SMTP_USERNAME;
        $mail->Password   = SMTP_PASSWORD;
        $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Port       = SMTP_PORT;

        $mail->setFrom(SMTP_FROM, SMTP_FROM_NAME);
        $mail->addAddress($to, $name);
        $mail->isHTML(true);
        $mail->Subject = APP_NAME . ' — Your ' . ucfirst($purpose) . ' OTP';
        $mail->Body    = "
            <div style='font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0f172a;color:#f1f5f9;border-radius:16px;'>
              <h2 style='color:#10b981;margin:0 0 8px'>Ememart</h2>
              <p style='color:#94a3b8;margin:0 0 24px'>Hi {$name},</p>
              <p style='color:#f1f5f9;margin:0 0 16px'>Your {$purpose} OTP is:</p>
              <div style='font-size:40px;font-weight:900;letter-spacing:12px;color:#10b981;background:#1e293b;padding:20px 24px;border-radius:12px;text-align:center;margin:0 0 24px'>{$otp}</div>
              <p style='color:#94a3b8;font-size:13px;margin:0'>This code expires in " . OTP_EXPIRY_MINUTES . " minutes. Do not share it with anyone.</p>
            </div>
        ";
        $mail->AltBody = "Your Ememart {$purpose} OTP: {$otp}. Expires in " . OTP_EXPIRY_MINUTES . " minutes.";
        $mail->send();
        return true;
    } catch (Exception $e) {
        error_log('PHPMailer error: ' . $mail->ErrorInfo);
        return false;
    }
}
