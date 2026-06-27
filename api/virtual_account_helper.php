<?php
// api/_virtual_account_helper.php
// Shared helper — included by admin_kyc.php and virtual_account.php
// Not directly accessible as an endpoint (no routing logic here)

// ============================================================
// Create a static virtual account via Flutterwave for one user.
// Returns: ["success" => bool, "message"|"account_number"|"bank_name" => ...]
// ============================================================
function attemptCreateVirtualAccount($pdo, $user_id) {
    // Already has one?
    $stmt = $pdo->prepare("SELECT id FROM virtual_accounts WHERE user_id = ? LIMIT 1");
    $stmt->execute([$user_id]);
    if ($stmt->fetch()) {
        return ["success" => true, "message" => "Account already exists.", "already_existed" => true];
    }

    // Get user + their verified BVN
    $stmt = $pdo->prepare("
        SELECT u.id, u.full_name, u.email, u.phone, k.bvn
        FROM users u
        JOIN kyc_verifications k ON k.user_id = u.id AND k.status = 'verified'
        WHERE u.id = ? LIMIT 1
    ");
    $stmt->execute([$user_id]);
    $user = $stmt->fetch();

    if (!$user || empty($user['bvn'])) {
        return ["success" => false, "message" => "User is not KYC-verified or has no BVN on file."];
    }

    $tx_ref = 'ememart-va-' . $user['id'] . '-' . time();
    $name_parts = explode(' ', trim($user['full_name']), 2);

    $payload = [
        "email"        => $user['email'],
        "tx_ref"       => $tx_ref,
        "phonenumber"  => $user['phone'] ?: '08000000000',
        "is_permanent" => true,
        "firstname"    => $name_parts[0],
        "lastname"     => $name_parts[1] ?? $name_parts[0],
        "narration"    => "Ememart Wallet — " . $user['full_name'],
        "bvn"          => $user['bvn'],
        "amount"       => 0,
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

    if ($err) {
        return ["success" => false, "message" => "Connection to Flutterwave failed."];
    }

    $result = json_decode($response, true);

    if (
        isset($result['status']) && $result['status'] === 'success' &&
        !empty($result['data']['account_number'])
    ) {
        $pdo->prepare("
            INSERT INTO virtual_accounts (user_id, account_number, bank_name, flw_ref, order_ref, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'active', NOW())
        ")->execute([
            $user_id,
            $result['data']['account_number'],
            $result['data']['bank_name'],
            $result['data']['flw_ref'] ?? null,
            $result['data']['order_ref'] ?? null,
        ]);

        return [
            "success"        => true,
            "account_number" => $result['data']['account_number'],
            "bank_name"      => $result['data']['bank_name'],
        ];
    }

    // Flutterwave rejected it — log this clearly so support can see why
    return [
        "success" => false,
        "message" => $result['message'] ?? "Flutterwave could not verify this BVN."
    ];
}
?>
