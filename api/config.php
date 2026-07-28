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
// EMAIL (used by otp.php / register.php)
// ============================================================
define('SMTP_EMAIL',    'noreply@ememart.com');
define('SMTP_PASSWORD', 'Amarach50@');

// ============================================================
// FLUTTERWAVE (used by wallet.php)
// ============================================================
define('FLW_PUBLIC_KEY',     'FLWPUBK-202e7692c501e3d9eee7b1a548ab5e6c-X');
define('FLW_SECRET_KEY',     'FLWSECK-b51b432c80dcb21201ba02f118db22ef-19e729c1bc8vt-X');
define('FLW_ENCRYPTION_KEY', 'b51b432c80dccbf5932daf47');

// ============================================================
// BIGISUB (used by vtu.php)
// ============================================================
define('BIGISUB_API_KEY', '9b0069d04cc75b91d4c552f8b5a71a84e01c367a');
define('BIGISUB_BASE_URL', 'https://api.bigisub.ng/api/v2');

// Bigisub's own transaction PIN (set in your Bigisub dashboard, NOT the
// customer's PIN). Required by cable/electricity/betting/data purchase
// endpoints. Replace the placeholder before going live.
define('BIGISUB_PIN', '2255');

// Bigisub endpoints (relative to BIGISUB_BASE_URL) — confirmed against the
// live "View Full API Documentation" page in the Bigisub app (v2.0.0)
define('BIGISUB_ENDPOINTS', [
    'login'                   => '/auth/login/',
    'airtime_purchase'        => '/vtu/airtime/purchase/',
    'data_plans'              => '/vtu/data/plans/',
    'data_purchase'           => '/vtu/data/purchase/',
    'cable_pricing'           => '/vtu/cable/pricing/',
    'cable_verify'            => '/vtu/cable/verify/',
    'cable_purchase'          => '/vtu/cable/purchase/',
    'electricity_providers'   => '/bills/electricity/providers/',
    'electricity_verify'      => '/bills/electricity/verify/',
    'electricity_pay'         => '/bills/electricity/pay/',
    'betting_products'        => '/betting/products/',
    'betting_validate'        => '/betting/validate/',
    'betting_fund'            => '/betting/fund/',
    'betting_requery'         => '/betting/requery/',
    'betting_history'         => '/betting/history/',
    'sms_pricing'             => '/communications/sms/pricing/',
    'sms_send'                => '/communications/sms/send/',
    'result_checker_prices'   => '/bills/result-checker/prices/',
    'result_checker_purchase' => '/bills/result-checker/purchase/',
    'transaction_status'      => '/anubis/transactions/{tranx_id}/',
    'marketinghub_pricing'    => '/marketinghub/pricing-summary/',
    'recharge_pin_plans'      => '/vtu/recharge-pin/plans/',
    'recharge_pin_purchase'   => '/vtu/recharge-pin/purchase/',
]);

// ============================================================
// HELPER: Call the Bigisub API
// $endpointKey  -> key from BIGISUB_ENDPOINTS (e.g. 'airtime_purchase')
// $method       -> 'GET' or 'POST'
// $payload      -> array of data to send (POST only)
// $urlParams    -> array to replace {placeholders} in the endpoint path,
//                  e.g. ['tranx_id' => 'abc123']
// Returns: ['success' => bool, 'status' => int, 'data' => array|null, 'raw' => string]
// ============================================================
function bigisubRequest($endpointKey, $method = 'GET', $payload = [], $urlParams = []) {
    $endpoints = BIGISUB_ENDPOINTS;
    if (!isset($endpoints[$endpointKey])) {
        return ['success' => false, 'status' => 0, 'data' => null, 'raw' => 'Unknown Bigisub endpoint: ' . $endpointKey];
    }

    $path = $endpoints[$endpointKey];
    foreach ($urlParams as $key => $value) {
        $path = str_replace('{' . $key . '}', urlencode($value), $path);
    }

    $url = BIGISUB_BASE_URL . $path;

    $headers = [
        'Authorization: Token ' . BIGISUB_API_KEY,
        'Content-Type: application/json',
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 30,
    ]);

    if (strtoupper($method) === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
    }

    $response  = curl_exec($ch);
    $httpCode  = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        return ['success' => false, 'status' => 0, 'data' => null, 'raw' => 'cURL error: ' . $curlError];
    }

    $decoded = json_decode($response, true);

    return [
        'success' => $httpCode >= 200 && $httpCode < 300,
        'status'  => $httpCode,
        'data'    => $decoded,
        'raw'     => $response,
    ];
}

// ============================================================
// CLOUDINARY (used by media.php)
// ============================================================
define('CLOUDINARY_CLOUD_NAME', 'untitled');
define('CLOUDINARY_API_KEY',    '562979931394534');
define('CLOUDINARY_API_SECRET', 'H2-1c7wKAltKlT4WOU7BDrKxlPE');

// ============================================================
// GOOGLE OAUTH (used by auth.php)
// ============================================================
define('GOOGLE_CLIENT_ID', '972386732120-jeflemnhcm58cgr49mpk4vekp647p2k4.apps.googleusercontent.com');

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
