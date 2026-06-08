<?php
// ============================================================
// EMEMART — config.php
// Place this file in: public_html/api/config.php
// ============================================================

define('DB_HOST',     'localhost');
define('DB_NAME',     'u287672430_ememartt');
define('DB_USER',     'u287672430_ememartt');
define('DB_PASS',     'Amarach50');
define('DB_CHARSET',  'utf8mb4');

// App settings
define('APP_NAME',    'Ememart');
define('APP_URL',     'https://www.ememart.com');
define('API_URL',     'https://www.ememart.com/api');

// OTP settings
define('OTP_EXPIRY_MINUTES', 10);

// Session settings
define('SESSION_EXPIRY_HOURS', 720); // 30 days

// Escrow fees (percentage)
define('ESCROW_FEE_BUYER',  5);
define('ESCROW_FEE_SELLER', 10);

// PHPMailer SMTP (Hostinger)
define('SMTP_HOST',     'smtp.hostinger.com');
define('SMTP_PORT',     587);
define('SMTP_USERNAME', 'noreply@ememart.com');
define('SMTP_PASSWORD', 'your_email_password');
define('SMTP_FROM',     'noreply@ememart.com');
define('SMTP_FROM_NAME','Ememart');

// ============================================================
// DATABASE CONNECTION
// ============================================================
function getDB(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $dsn = sprintf(
        'mysql:host=%s;dbname=%s;charset=%s',
        DB_HOST, DB_NAME, DB_CHARSET
    );
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        http_response_code(500);
        die(json_encode(['success' => false, 'message' => 'Database connection failed.']));
    }
    return $pdo;
}

// ============================================================
// SHARED HELPERS
// ============================================================

function respond(bool $success, string $message, array $data = []): void {
    header('Content-Type: application/json');
    echo json_encode(array_merge(['success' => $success, 'message' => $message], $data));
    exit;
}

function post(string $key, $default = ''): string {
    return trim($_POST[$key] ?? $default);
}

function isEmail(string $v): bool {
    return filter_var($v, FILTER_VALIDATE_EMAIL) !== false;
}

function generateOTP(int $length = 6): string {
    return str_pad((string) random_int(0, 10 ** $length - 1), $length, '0', STR_PAD_LEFT);
}

function generateToken(int $bytes = 32): string {
    return bin2hex(random_bytes($bytes));
}

function getAuthUser(): ?array {
    $token = $_COOKIE['ememart_session'] ?? $_SERVER['HTTP_X_SESSION_TOKEN'] ?? '';
    if (!$token) return null;

    $db   = getDB();
    $stmt = $db->prepare('
        SELECT u.* FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > NOW()
        LIMIT 1
    ');
    $stmt->execute([$token]);
    return $stmt->fetch() ?: null;
}

function requireAuth(): array {
    $user = getAuthUser();
    if (!$user) {
        http_response_code(401);
        respond(false, 'Please sign in to continue.');
    }
    return $user;
}

function setCORSHeaders(): void {
    $allowed = APP_URL;
    header("Access-Control-Allow-Origin: $allowed");
    header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Session-Token');
    header('Access-Control-Allow-Credentials: true');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(200);
        exit;
    }
}

function addTransaction(int $userId, string $type, string $category, float $amount, string $desc, string $ref = ''): void {
    $db  = getDB();
    $ref = $ref ?: generateToken(8);
    $db->prepare('
        INSERT INTO transactions (user_id, type, category, amount, description, reference)
        VALUES (?, ?, ?, ?, ?, ?)
    ')->execute([$userId, $type, $category, $amount, $desc, $ref]);
}

function addNotification(int $userId, string $title, string $body, string $type = ''): void {
    $db = getDB();
    $db->prepare('
        INSERT INTO notifications (user_id, title, body, type) VALUES (?, ?, ?, ?)
    ')->execute([$userId, $title, $body, $type]);
}
