<?php
// api/config.php

// ============================================================
// LOAD .env FILE — reads secrets from .env into PHP variables
// ============================================================
function loadEnv($path) {
    if (!file_exists($path)) {
        http_response_code(500);
        echo json_encode(["success" => false, "message" => "Server configuration missing. Contact admin."]);
        exit;
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $line = trim($line);
        if (empty($line) || $line[0] === '#') continue;
        if (strpos($line, '=') === false) continue;
        list($key, $value) = explode('=', $line, 2);
        $key   = trim($key);
        $value = trim($value);
        if (!array_key_exists($key, $_ENV)) {
            putenv("$key=$value");
            $_ENV[$key] = $value;
        }
    }
}

loadEnv(__DIR__ . '/.env');

// ============================================================
// CORS — allow both www and non-www
// ============================================================
$allowed_origins = ['https://www.ememart.com', 'https://ememart.com'];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowed_origins)) {
    header("Access-Control-Allow-Origin: $origin");
}
header("Access-Control-Allow-Headers: Content-Type, Authorization");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Credentials: true");
header("Content-Type: application/json; charset=UTF-8");

// Handle preflight CORS requests
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit(0);
}

// ============================================================
// DATABASE CREDENTIALS — now pulled from .env
// ============================================================
define('DB_HOST', getenv('DB_HOST'));
define('DB_USER', getenv('DB_USER'));
define('DB_PASS', getenv('DB_PASS'));
define('DB_NAME', getenv('DB_NAME'));

// ============================================================
// OTHER SECRETS — now pulled from .env, used by other API files
// ============================================================
define('SMTP_EMAIL',          getenv('SMTP_EMAIL'));
define('SMTP_PASSWORD',       getenv('SMTP_PASSWORD'));
define('FLW_PUBLIC_KEY',      getenv('FLW_PUBLIC_KEY'));
define('FLW_SECRET_KEY',      getenv('FLW_SECRET_KEY'));
define('FLW_ENCRYPTION_KEY',  getenv('FLW_ENCRYPTION_KEY'));
define('BIGISUB_API_KEY',     getenv('BIGISUB_API_KEY'));
define('CLOUDINARY_CLOUD_NAME', getenv('CLOUDINARY_CLOUD_NAME'));
define('CLOUDINARY_API_KEY',    getenv('CLOUDINARY_API_KEY'));
define('CLOUDINARY_API_SECRET', getenv('CLOUDINARY_API_SECRET'));
define('GOOGLE_CLIENT_ID',    getenv('GOOGLE_CLIENT_ID'));

// ============================================================
// PDO CONNECTION
// ============================================================
try {
    $pdo = new PDO(
        "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]
    );
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(["success" => false, "message" => "Database connection failed"]);
    exit;
}

// ============================================================
// HELPER: Return JSON response and exit
// ============================================================
function respond($success, $message, $data = []) {
    echo json_encode(array_merge(
        ["success" => $success, "message" => $message],
        $data
    ));
    exit;
}

// ============================================================
// HELPER: Get request body — supports both JSON and form-encoded POST
// ============================================================
function getBody() {
    $raw = file_get_contents('php://input');

    $json = json_decode($raw, true);
    if (is_array($json)) {
        return $json;
    }

    if (!empty($_POST)) {
        return $_POST;
    }

    if (!empty($raw)) {
        parse_str($raw, $parsed);
        if (!empty($parsed)) {
            return $parsed;
        }
    }

    return [];
}

// ============================================================
// HELPER: Sanitize string input
// ============================================================
function clean($str) {
    return htmlspecialchars(strip_tags(trim($str ?? '')));
}
?>
