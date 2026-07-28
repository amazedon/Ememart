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
// BIGISUB — base URL, endpoint map, and bigisubRequest() helper
// all live in config.php (already required above). Do NOT
// redefine BIGISUB_BASE_URL or write a local bigisub() here —
// that caused a wrong domain + wrong auth header (Bearer instead
// of Token) that made every VTU call fail.
// ============================================================
// CASHBACK_RATE is loaded from settings table per-request (see purchase action)

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

        // Map frontend category to the confirmed Bigisub endpoint key
        // (config.php BIGISUB_ENDPOINTS). Bigisub's /plans/ endpoints
        // return the FULL plan list — there's no service_id filter param
        // confirmed in their API, so we fetch everything and filter by
        // network/service_id here instead.
        $endpoint_key_map = [
            'data' => 'data_plans',
            'tv'   => 'cable_pricing',
        ];
        $endpoint_key = $endpoint_key_map[$category] ?? 'data_plans';

        $result = bigisubRequest($endpoint_key, 'GET');

        if (!$result['success'] || empty($result['data']['data'])) {
            respond(false, "Could not fetch plans. Please try again.");
        }

        $all_plans = $result['data']['data'];

        // Filter to the requested network/provider if service_id is a network id
        $plans = array_values(array_filter($all_plans, function ($p) use ($service_id) {
            return (string)($p['network'] ?? '') === (string)$service_id;
        }));

        respond(true, "Plans fetched.", ["plans" => $plans ?: $all_plans]);
        break;

    // ----------------------------------------------------------
    // VALIDATE CUSTOMER — verify meter/smartcard/account before purchase
    // ----------------------------------------------------------
    case 'validate_customer':
        // NOTE: the frontend currently sends { service_id, account_no } only.
        // It ALSO needs to send service_type ('tv' | 'electricity' | 'betting')
        // since each one hits a different Bigisub endpoint with different
        // field names. Add `service_type: _vtu.service` to the apiPost call
        // in index.html (around the validate_customer call, ~line 5435).
        $service_type = clean($body['service_type'] ?? '');
        $service_id   = clean($body['service_id']   ?? ''); // provider/company/biller code
        $account_no   = clean($body['account_no']   ?? ''); // meter/card/customer id

        if (empty($service_type) || empty($account_no)) {
            respond(false, "Service type and account number are required.");
        }

        if ($service_type === 'tv') {
            $result = bigisubRequest('cable_verify', 'POST', [
                'cable_name' => $service_id,   // e.g. "dstv"
                'card_no'    => $account_no,
            ]);
            if (!$result['success'] || empty($result['data'])) {
                respond(false, "Could not validate smartcard. Check the number and try again.");
            }
            respond(true, "Customer validated.", [
                "customer_name" => $result['data']['Customer_Name'] ?? $result['data']['customer_name'] ?? 'Verified',
            ]);

        } elseif ($service_type === 'electricity') {
            $result = bigisubRequest('electricity_verify', 'POST', [
                'company'    => $service_id,   // e.g. "ikeja-electric"
                'meter_no'   => $account_no,
                'meter_type' => clean($body['meter_type'] ?? 'prepaid'),
            ]);
            if (!$result['success'] || empty($result['data'])) {
                respond(false, "Could not validate meter. Check the number and try again.");
            }
            respond(true, "Customer validated.", [
                "customer_name" => $result['data']['Customer_Name'] ?? $result['data']['customer_name'] ?? 'Verified',
                "address"       => $result['data']['Address'] ?? '',
            ]);

        } elseif ($service_type === 'betting') {
            $result = bigisubRequest('betting_validate', 'POST', [
                'biller_code' => $service_id,   // e.g. "BET9JA"
                'customer_id' => $account_no,
            ]);
            if (!$result['success'] || empty($result['data'])) {
                respond(false, "Could not validate betting account. Check the ID and try again.");
            }
            // IMPORTANT: betting needs this validation_reference passed back
            // into the 'purchase' action's request body — store it on the
            // frontend (_vtu.validationRef) and send it along with 'purchase'.
            respond(true, "Customer validated.", [
                "customer_name"        => $result['data']['customer_name'] ?? 'Verified',
                "validation_reference" => $result['data']['validation_reference'] ?? null,
            ]);

        } else {
            respond(false, "Unknown service type for validation.");
        }
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

        // Map service type to the confirmed bigisubRequest() endpoint key
        $endpoint_key_map = [
            'airtime'     => 'airtime_purchase',
            'data'        => 'data_purchase',
            'electricity' => 'electricity_pay',
            'tv'          => 'cable_purchase',
            'betting'     => 'betting_fund',
        ];
        $endpoint_key = $endpoint_key_map[$service_type];

        // Payloads below match Bigisub's confirmed v2 curl examples exactly —
        // note the inconsistent field names/casing across services, that's
        // how their API actually is (cable_type vs cable_name, Customer vs
        // Customer_name, pin vs pin_code).
        if ($service_type === 'airtime') {
            $payload = [
                'network'      => (int)$service_id,       // Bigisub network id, e.g. 1 = MTN
                'phone_number' => $phone ?: $account_no,
                'amount'       => (string)$wholesale_amount,
                'airtime_type' => 'vtu',
                'pin'          => BIGISUB_PIN,
            ];

        } elseif ($service_type === 'data') {
            $payload = [
                'network'        => (int)$service_id,      // Bigisub network id
                'plan'           => (int)$plan_id,          // Bigisub plan id
                'phone_number'   => $phone ?: $account_no,
                'pin'            => BIGISUB_PIN,
                'ported_number'  => (bool)($body['ported_number'] ?? false),
            ];

        } elseif ($service_type === 'tv') {
            $payload = [
                'cable_type'  => $service_id,               // e.g. "dstv"
                'card_no'     => $account_no,
                'phone_number'=> $phone ?: $account_no,
                'amount'      => $wholesale_amount,
                'Customer'    => clean($body['customer_name'] ?? ''), // from validate step
                'pin'         => BIGISUB_PIN,
            ];

        } elseif ($service_type === 'electricity') {
            $payload = [
                'company'        => $service_id,            // e.g. "ikeja-electric"
                'meter_no'       => $account_no,
                'meter_type'     => clean($body['meter_type'] ?? 'prepaid'),
                'phone_number'   => $phone ?: $account_no,
                'amount'         => $wholesale_amount,
                'Customer_name'  => clean($body['customer_name'] ?? ''),
                'pin'            => BIGISUB_PIN,
            ];

        } elseif ($service_type === 'betting') {
            // Betting REQUIRES the validation_reference returned by the
            // 'validate_customer' action's betting branch — the frontend
            // must send it back here as body.validation_reference.
            $validation_reference = clean($body['validation_reference'] ?? '');
            if (empty($validation_reference)) {
                respond(false, "Please validate the betting account before funding.");
            }
            $payload = [
                'biller_code'          => $service_id,      // e.g. "BET9JA"
                'customer_id'          => $account_no,
                'customer_name'        => clean($body['customer_name'] ?? ''),
                'amount'               => $wholesale_amount,
                'validation_reference' => $validation_reference,
                'pin_code'             => BIGISUB_PIN,       // note: pin_code here, not pin
            ];
        }
        // (plan_id is already included inside the 'data' branch above as 'plan')

        // Debit wallet BEFORE calling API (reserve funds) — debit the REAL charge
        if (!debitWallet($pdo, $user_id, $charge_amount)) {
            respond(false, "Insufficient wallet balance.");
        }

        // Call Bigisub
        $api_result = bigisubRequest($endpoint_key, 'POST', $payload);
        $result     = $api_result['data'];

        $service_labels = [
            'airtime'     => 'Airtime Top-up',
            'data'        => 'Data Bundle',
            'electricity' => 'Electricity (NEPA)',
            'tv'          => 'TV Subscription',
            'betting'     => 'Bet Funding',
        ];
        $service_label = $service_labels[$service_type];

        if (
            $api_result['success'] &&
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
