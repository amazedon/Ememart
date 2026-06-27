<?php
// api/virtual_account.php
require_once 'config.php';
require_once '_virtual_account_helper.php';
session_start();

$user_id = (int)($_SESSION['user_id'] ?? 0);
if (!$user_id) {
    respond(false, "Unauthorised. Please sign in.");
}

$body   = getBody();
$action = clean($body['action'] ?? 'get');

switch ($action) {

    // ----------------------------------------------------------
    // GET — fetch the user's virtual account (created automatically
    // by admin_kyc.php right after approval; this just retrieves it,
    // or retries creation if it failed before for a fixable reason)
    // ----------------------------------------------------------
    case 'get':
        $stmt = $pdo->prepare("
            SELECT account_number, bank_name, status, created_at
            FROM virtual_accounts WHERE user_id = ? LIMIT 1
        ");
        $stmt->execute([$user_id]);
        $existing = $stmt->fetch();

        if ($existing) {
            respond(true, "Virtual account fetched.", ["account" => $existing]);
        }

        // Check KYC status to give an accurate reason
        $stmt = $pdo->prepare("SELECT kyc_status FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch();

        if (!$user || $user['kyc_status'] !== 'verified') {
            respond(true, "No virtual account yet.", [
                "account" => null,
                "reason"  => "kyc_required"
            ]);
        }

        // KYC is verified but no account exists — likely failed at approval time.
        // Let the user retry once from their side.
        $result = attemptCreateVirtualAccount($pdo, $user_id);

        if (!$result['success']) {
            respond(true, "No virtual account yet.", [
                "account" => null,
                "reason"  => "flutterwave_failed",
                "detail"  => $result['message']
            ]);
        }

        respond(true, "Virtual account created.", [
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
