<?php
// api/virtual_account.php
require_once 'config.php';
session_start();

$user_id = (int)($_SESSION['user_id'] ?? 0);
if (!$user_id) {
    respond(false, "Unauthorised. Please sign in.");
}

$body   = getBody();
$action = clean($body['action'] ?? 'get');

// ============================================================
// HELPER: Create a static virtual account via Flutterwave
// ============================================================
function createFlutterwaveVirtualAccount($pdo, $user) {
    $tx_ref = 'ememart-va-' . $user['id'] . '-' . time();

    $payload = [
        "email"       => $user['email'],
        "tx_ref"      => $tx_ref,
        "phonenumber" => $user['phone'] ?: '08000000000',
        "is_permanent"=> true,
        "firstname"   => explode(' ', $user['full_name'])[0],
        "lastname"    => count(explode(' ', $user['full_name'])) > 1
                            ? explode(' ', $user['full_name'], 2)[1]
                            : $user['full_name'],
        "narration"   => "Ememart Wallet — " . $user['full_name'],
        "bvn"         => $user['bvn'],
        "amount"      => 0,
    ];

    $ch = curl_init("https://api.flutterwave.com/v3/virtual-account-numbers");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_HTTPHEADER     => [
            "Authorization: Bearer " . FLW_SECRET_KEY,
            "Content-Type: application/json",
        ],
        CURLOPT_TIMEOUT => 30,
    ]);
    $response = curl_exec($ch);
    $err      = curl_error($ch);
    curl_close($ch);

    if ($err) return ["success" => false, "message" => "Connection to Flutterwave failed."];

    $result = json_decode($response, true);

    if (
        isset($result['status']) && $result['status'] === 'success' &&
        !empty($result['data']['account_number'])
    ) {
        return [
            "success"        => true,
            "account_number" => $result['data']['account_number'],
            "bank_name"      => $result['data']['bank_name'],
            "flw_ref"        => $result['data']['flw_ref'] ?? null,
            "order_ref"      => $result['data']['order_ref'] ?? null,
        ];
    }

    return ["success" => false, "message" => $result['message'] ?? "Could not create virtual account."];
}

switch ($action) {

    // ----------------------------------------------------------
    // GET — fetch the user's virtual account (creates one if eligible and none exists)
    // ----------------------------------------------------------
    case 'get':
        // Check if already has one
        $stmt = $pdo->prepare("
            SELECT account_number, bank_name, status, created_at
            FROM virtual_accounts WHERE user_id = ? LIMIT 1
        ");
        $stmt->execute([$user_id]);
        $existing = $stmt->fetch();

        if ($existing) {
            respond(true, "Virtual account fetched.", ["account" => $existing]);
        }

        // No account yet — check if user is KYC-verified (required: real BVN)
        $stmt = $pdo->prepare("
            SELECT u.id, u.full_name, u.email, u.phone, u.kyc_status, k.bvn
            FROM users u
            LEFT JOIN kyc_verifications k ON k.user_id = u.id AND k.status = 'verified'
            WHERE u.id = ? LIMIT 1
        ");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch();

        if (!$user || $user['kyc_status'] !== 'verified' || empty($user['bvn'])) {
            respond(true, "No virtual account yet.", [
                "account" => null,
                "reason"  => "kyc_required"
            ]);
        }

        // Eligible — create the virtual account now
        $result = createFlutterwaveVirtualAccount($pdo, $user);

        if (!$result['success']) {
            respond(false, $result['message']);
        }

        $stmt = $pdo->prepare("
            INSERT INTO virtual_accounts (user_id, account_number, bank_name, flw_ref, order_ref, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'active', NOW())
        ");
        $stmt->execute([
            $user_id, $result['account_number'], $result['bank_name'],
            $result['flw_ref'], $result['order_ref']
        ]);

        respond(true, "Virtual account created successfully.", [
            "account" => [
                "account_number" => $result['account_number'],
                "bank_name"      => $result['bank_name'],
                "status"         => "active",
                "created_at"     => date('Y-m-d H:i:s'),
            ]
        ]);
        break;

    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
