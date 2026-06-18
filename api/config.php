<?php
// api/config.php

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
// DATABASE CREDENTIALS
// ============================================================
define('DB_HOST', 'localhost');
define('DB_USER', 'u287672430_ememartt');
define('DB_PASS', 'Ememart2024!!');
define('DB_NAME', 'u287672430_ememartt');

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

    // Try JSON first
    $json = json_decode($raw, true);
    if (is_array($json)) {
        return $json;
    }

    // Fall back to standard form-encoded POST data ($_POST)
    if (!empty($_POST)) {
        return $_POST;
    }

    // Last resort: manually parse raw urlencoded body
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
