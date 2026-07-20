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
// CASHBACK_RATE is loaded from settings table per-request (see purchase action)

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
    // GET PLANS — fetch data/TV plans from Bigisub
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
            'data' => '/data/plans',
            'tv'   => '/tv/plans',
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
    // PURCHASE — buy airtime / data / electricity / TV / betting
    // ----------------------------------------------------------
    // ----------------------------------------------------------
    // PREVIEW PRICE — tell the frontend what the real charge will be
    // (including our markup), before the customer confirms
    // ----------------------------------------------------------
    case 'preview_price':
        $service_type = clean($body['service_type'] ?? '');
        $service_id   = clean($body['service_id']   ?? '');
        $plan_id      = clean($body['plan_id']       ?? '');
        $requested_amount = (float)($body['amount']  ?? 0);

        $charge_amount = $requested_amount;

        if ($service_type === 'data' || $service_type === 'tv') {
            $stmt = $pdo->prepare("
                SELECT selling_price FROM vtu_pricing
                WHERE service_type = ? AND provider_id = ? AND plan_id = ? LIMIT 1
            ");
            $stmt->execute([$service_type, $service_id, $plan_id]);
            $pricing = $stmt->fetch();
            if ($pricing) $charge_amount = (float)$pricing['selling_price'];
        } else {
            $stmt = $pdo->prepare("
                SELECT markup_type, markup_value FROM vtu_pricing
                WHERE service_type = ? AND provider_id = 'all' LIMIT 1
            ");
            $stmt->execute([$service_type]);
            $fee = $stmt->fetch();
            if ($fee) {
                $fee_amount = $fee['markup_type'] === 'percent'
                    ? round($requested_amount * ((float)$fee['markup_value'] / 100), 2)
                    : (float)$fee['markup_value'];
                $charge_amount = $requested_amount + $fee_amount;
            }
        }

        respond(true, "Price calculated.", ["charge_amount" => $charge_amount]);
        break;

    case 'purchase':
        $service_type = clean($body['service_type'] ?? '');
        $service_id   = clean($body['service_id']   ?? '');
        $requested_amount = (float)($body['amount']  ?? 0);
        $phone        = clean($body['phone']         ?? '');
        $account_no   = clean($body['account_no']   ?? $body['phone'] ?? '');
        $plan_id      = clean($body['plan_id']       ?? '');

        // Validate inputs
        if (empty($service_type)) respond(false, "Service type is required.");
        if (empty($account_no))   respond(false, "Account number or phone is required.");

        $allowed_services = ['airtime', 'data', 'electricity', 'tv', 'betting'];
        if (!in_array($service_type, $allowed_services)) {
            respond(false, "Invalid service type.");
        }

        // ============================================================
        // DETERMINE THE REAL CHARGE — never trust the amount sent by the
        // frontend on its own. Look up your set pricing instead.
        // ============================================================
        $wholesale_amount = $requested_amount; // what we'll send to Bigisub
        $charge_amount    = $requested_amount; // what we'll debit the customer

        if ($service_type === 'data' || $service_type === 'tv') {
            // Plan-based services: look up the exact plan's wholesale + selling price
            $stmt = $pdo->prepare("
                SELECT wholesale_price, selling_price FROM vtu_pricing
                WHERE service_type = ? AND provider_id = ? AND plan_id = ? LIMIT 1
            ");
            $stmt->execute([$service_type, $service_id, $plan_id]);
            $pricing = $stmt->fetch();

            if ($pricing) {
                $wholesale_amount = (float)$pricing['wholesale_price'];
                $charge_amount    = (float)$pricing['selling_price'];
            }
            // If no pricing row exists yet, falls back to the raw amount sent
            // (i.e. no markup applied) — set this in admin "VTU Pricing" to fix.
        } else {
            // Flat-fee services (airtime, electricity, betting): customer chooses
            // the top-up amount, your markup is an added service fee on top
            $stmt = $pdo->prepare("
                SELECT markup_type, markup_value FROM vtu_pricing
                WHERE service_type = ? AND provider_id = 'all' LIMIT 1
            ");
            $stmt->execute([$service_type]);
            $fee = $stmt->fetch();

            if ($fee) {
                $fee_amount = $fee['markup_type'] === 'percent'
                    ? round($requested_amount * ((float)$fee['markup_value'] / 100), 2)
                    : (float)$fee['markup_value'];
                $charge_amount = $requested_amount + $fee_amount;
            }
            $wholesale_amount = $requested_amount; // Bigisub still gets the exact top-up amount requested
        }

        if ($charge_amount < 50) respond(false, "Minimum purchase is ₦50.");

        // Check wallet balance against the REAL charge (with your markup)
        $stmt = $pdo->prepare("SELECT wallet_balance FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch();

        if (!$user || (float)$user['wallet_balance'] < $charge_amount) {
            respond(false, "Insufficient wallet balance. You need " . number_format($charge_amount, 2) . " (includes service fee). Please fund your wallet.");
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
        ];
        $endpoint = $endpoint_map[$service_type];

        // Build payload for Bigisub — uses the WHOLESALE amount, not what we charge the customer
        $payload = [
            'reference'  => $reference,
            'service_id' => $service_id,
            'amount'     => $wholesale_amount,
            'phone'      => $phone ?: $account_no,
            'account_no' => $account_no,
        ];
        if (!empty($plan_id)) $payload['plan_id'] = $plan_id;

        // Debit wallet BEFORE calling API (reserve funds) — debit the REAL charge
        if (!debitWallet($pdo, $user_id, $charge_amount)) {
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
        ];
        $service_label = $service_labels[$service_type];

        if (
            $result &&
            isset($result['status']) &&
            in_array($result['status'], ['success', 'successful', 'delivered'])
        ) {
            // SUCCESS — log debit transaction (the real amount charged, including your markup)
            logTxn($pdo, $user_id, 'debit', 'vtu', $charge_amount,
                "$service_label — $account_no", $reference);

            // Log your profit margin separately for your own records
            $profit = round($charge_amount - $wholesale_amount, 2);
            if ($profit > 0) {
                logTxn($pdo, $user_id, 'debit', 'vtu_margin_internal', 0,
                    "Internal: margin ₦$profit on $service_label ($reference)", $reference);
            }

            // Apply 1% cashback (based on what the customer actually paid)
            // Apply cashback (rate loaded live from settings table)
            $cr_stmt = $pdo->prepare("SELECT value FROM settings WHERE name = 'cashback_rate' LIMIT 1");
            $cr_stmt->execute();
            $cashback_rate = (float)(($cr_stmt->fetch())['value'] ?? 0.01);
            $cashback = (int)floor($charge_amount * $cashback_rate);
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
                "amount_charged" => $charge_amount,
                "cashback"    => $cashback,
            ]);

        } else {
            // FAILED — refund wallet the full amount we actually charged
            creditWallet($pdo, $user_id, $charge_amount);
            logTxn($pdo, $user_id, 'credit', 'refund', $charge_amount,
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
