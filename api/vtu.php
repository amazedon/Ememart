<?php
// api/vtu.php
require_once 'config.php';
session_start();

// ============================================================
// AUTH CHECK
// ============================================================
$user_id = (int)($_SESSION['user_id'] ?? 0);
if (!$user_id) {
    respond(false, "Unauthorised. Please sign in.");
}

// ============================================================
// BIGISUB API CREDENTIALS
// Get these from your Bigisub dashboard
// ============================================================
define('BIGISUB_BASE_URL', 'https://bigisub.com/api');
define('CASHBACK_RATE',    0.01);                     // 1% cashback

// ============================================================
// HELPER: Call Bigisub API
// ============================================================
function bigisub($endpoint, $payload = [], $method = 'POST') {
    $url = BIGISUB_BASE_URL . $endpoint;
    $ch  = curl_init($url);

    $headers = [
        'Authorization: Bearer ' . BIGISUB_API_KEY,
        'Content-Type: application/json',
        'Accept: application/json',
    ];

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 30,
    ]);

    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
    }

    $response = curl_exec($ch);
    $err      = curl_error($ch);
    curl_close($ch);

    if ($err) return null;
    return json_decode($response, true);
}

// ============================================================
// HELPER: Debit wallet
// ============================================================
function debitWallet($pdo, $user_id, $amount) {
    $stmt = $pdo->prepare("
        UPDATE users SET wallet_balance = wallet_balance - ?
        WHERE id = ? AND wallet_balance >= ?
    ");
    $stmt->execute([$amount, $user_id, $amount]);
    return $stmt->rowCount() > 0;
}

// ============================================================
// HELPER: Credit wallet (for cashback / refunds)
// ============================================================
function creditWallet($pdo, $user_id, $amount) {
    $pdo->prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?")
        ->execute([$amount, $user_id]);
}

// ============================================================
// HELPER: Log transaction
// ============================================================
function logTxn($pdo, $user_id, $type, $category, $amount, $desc, $ref = null) {
    $pdo->prepare("
        INSERT INTO transactions
            (user_id, type, category, amount, description, reference, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
    ")->execute([$user_id, $type, $category, $amount, $desc, $ref]);
}

// ============================================================
// ROUTE
// ============================================================
$method = $_SERVER['REQUEST_METHOD'];
$body   = getBody();
$action = clean($body['action'] ?? $_GET['action'] ?? '');

switch ($action) {

    // ----------------------------------------------------------
    // GET PLANS — fetch data/TV/internet plans from Bigisub
    // Called via apiGet('vtu.php', { action:'get_plans', ... })
    // ----------------------------------------------------------
    case 'get_plans':
        $service_id = clean($_GET['service_id'] ?? $body['service_id'] ?? '');
        $category   = clean($_GET['category']   ?? $body['category']   ?? '');

        if (empty($service_id)) {
            respond(false, "Service ID is required.");
        }

        // Map frontend category to Bigisub endpoint
        $endpoint_map = [
            'data'     => '/data/plans',
            'tv'       => '/tv/plans',
            'internet' => '/internet/plans',
        ];

        $endpoint = $endpoint_map[$category] ?? '/data/plans';
        $result   = bigisub($endpoint . '?service_id=' . urlencode($service_id), [], 'GET');

        if (!$result || !isset($result['data'])) {
            // Return cached/default plans if API fails
            respond(false, "Could not fetch plans. Please try again.");
        }

        respond(true, "Plans fetched.", ["plans" => $result['data']]);
        break;

    // ----------------------------------------------------------
    // VALIDATE CUSTOMER — verify meter/smartcard/account before purchase
    // ----------------------------------------------------------
    case 'validate_customer':
        $service_id = clean($body['service_id'] ?? '');
        $account_no = clean($body['account_no'] ?? '');

        if (empty($service_id) || empty($account_no)) {
            respond(false, "Service ID and account number are required.");
        }

        $result = bigisub('/validate', [
            'service_id' => $service_id,
            'account_no' => $account_no,
        ]);

        if (!$result || empty($result['data'])) {
            respond(false, "Could not validate account. Check the number and try again.");
        }

        if (isset($result['status']) && $result['status'] === 'error') {
            respond(false, $result['message'] ?? "Invalid account number.");
        }

        respond(true, "Customer validated.", [
            "customer_name"    => $result['data']['customer_name']    ?? 'Verified',
            "customer_address" => $result['data']['customer_address'] ?? '',
            "meter_type"       => $result['data']['meter_type']       ?? '',
        ]);
        break;

    // ----------------------------------------------------------
    // PURCHASE — buy airtime / data / electricity / TV / betting / internet
    // ----------------------------------------------------------
    case 'purchase':
        $service_type = clean($body['service_type'] ?? '');
        $service_id   = clean($body['service_id']   ?? '');
        $amount       = (float)($body['amount']      ?? 0);
        $phone        = clean($body['phone']         ?? '');
        $account_no   = clean($body['account_no']   ?? $body['phone'] ?? '');
        $plan_id      = clean($body['plan_id']       ?? '');

        // Validate inputs
        if (empty($service_type)) respond(false, "Service type is required.");
        if ($amount < 50)         respond(false, "Minimum purchase is ₦50.");
        if (empty($account_no))   respond(false, "Account number or phone is required.");

        $allowed_services = ['airtime', 'data', 'electricity', 'tv', 'betting', 'internet'];
        if (!in_array($service_type, $allowed_services)) {
            respond(false, "Invalid service type.");
        }

        // Check wallet balance
        $stmt = $pdo->prepare("SELECT wallet_balance FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch();

        if (!$user || (float)$user['wallet_balance'] < $amount) {
            respond(false, "Insufficient wallet balance. Please fund your wallet.");
        }

        // Generate unique reference
        $reference = 'VTU-' . strtoupper(bin2hex(random_bytes(6))) . '-' . time();

        // Map service type to Bigisub endpoint
        $endpoint_map = [
            'airtime'     => '/airtime/purchase',
            'data'        => '/data/purchase',
            'electricity' => '/electricity/purchase',
            'tv'          => '/tv/purchase',
            'betting'     => '/betting/purchase',
            'internet'    => '/internet/purchase',
        ];
        $endpoint = $endpoint_map[$service_type];

        // Build payload for Bigisub
        $payload = [
            'reference'  => $reference,
            'service_id' => $service_id,
            'amount'     => $amount,
            'phone'      => $phone ?: $account_no,
            'account_no' => $account_no,
        ];
        if (!empty($plan_id)) $payload['plan_id'] = $plan_id;

        // Debit wallet BEFORE calling API (reserve funds)
        if (!debitWallet($pdo, $user_id, $amount)) {
            respond(false, "Insufficient wallet balance.");
        }

        // Call Bigisub
        $result = bigisub($endpoint, $payload);

        $service_labels = [
            'airtime'     => 'Airtime Top-up',
            'data'        => 'Data Bundle',
            'electricity' => 'Electricity (NEPA)',
            'tv'          => 'TV Subscription',
            'betting'     => 'Bet Funding',
            'internet'    => 'Internet Bill',
        ];
        $service_label = $service_labels[$service_type];

        if (
            $result &&
            isset($result['status']) &&
            in_array($result['status'], ['success', 'successful', 'delivered'])
        ) {
            // SUCCESS — log debit transaction
            logTxn($pdo, $user_id, 'debit', 'vtu', $amount,
                "$service_label — $account_no", $reference);

            // Apply 1% cashback
            $cashback = (int)floor($amount * CASHBACK_RATE);
            if ($cashback > 0) {
                creditWallet($pdo, $user_id, $cashback);
                logTxn($pdo, $user_id, 'credit', 'cashback', $cashback,
                    "1% cashback on $service_label", $reference);
            }

            // Get new balance
            $stmt = $pdo->prepare("SELECT wallet_balance FROM users WHERE id = ? LIMIT 1");
            $stmt->execute([$user_id]);
            $updated = $stmt->fetch();

            respond(true, "$service_label purchase successful!", [
                "reference"   => $reference,
                "token"       => $result['data']['token']  ?? null, // electricity token
                "new_balance" => number_format((float)$updated['wallet_balance'], 2),
                "cashback"    => $cashback,
            ]);

        } else {
            // FAILED — refund wallet
            creditWallet($pdo, $user_id, $amount);
            logTxn($pdo, $user_id, 'credit', 'refund', $amount,
                "Refund: failed $service_label purchase", $reference);

            $error = $result['message'] ?? "Purchase failed. Your wallet has been refunded.";
            respond(false, $error);
        }
        break;

    // ----------------------------------------------------------
    // DEFAULT
    // ----------------------------------------------------------
    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
