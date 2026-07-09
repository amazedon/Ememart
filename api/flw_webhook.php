<?php
// api/flw_webhook.php
// This file is called DIRECTLY BY FLUTTERWAVE, not by your frontend.
// It has no session/login check — Flutterwave verifies itself via a secret hash header.
require_once 'config.php';

// ============================================================
// VERIFY THE WEBHOOK IS GENUINELY FROM FLUTTERWAVE
// ============================================================
// Set this secret hash in your Flutterwave dashboard:
// Settings → Webhooks → Secret Hash
define('FLW_WEBHOOK_SECRET_HASH', 'CHANGE_THIS_TO_A_RANDOM_STRING_AND_SET_SAME_IN_FLUTTERWAVE_DASHBOARD');

$signature = $_SERVER['HTTP_VERIF_HASH'] ?? '';
if (empty($signature) || $signature !== FLW_WEBHOOK_SECRET_HASH) {
    http_response_code(401);
    exit('Unauthorised');
}

$raw_body = file_get_contents('php://input');
$payload  = json_decode($raw_body, true);

if (!$payload) {
    http_response_code(400);
    exit('Invalid payload');
}

// Log every webhook received, regardless of outcome (for debugging)
$tx_ref       = $payload['data']['tx_ref']        ?? $payload['txRef'] ?? ('unknown-' . time());
$flw_ref      = $payload['data']['flw_ref']        ?? null;
$event_type   = $payload['event']                  ?? ($payload['data']['event.type'] ?? null);
$amount       = $payload['data']['amount']         ?? 0;
$status       = $payload['data']['status']         ?? null;
$account_no   = $payload['data']['account_number'] ?? ($payload['data']['narration'] ?? null);

try {
    $stmt = $pdo->prepare("
        INSERT IGNORE INTO webhook_log
            (tx_ref, flw_ref, event_type, amount, account_number, status, raw_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    ");
    $stmt->execute([$tx_ref, $flw_ref, $event_type, $amount, $account_no, $status, $raw_body]);

    // If this tx_ref was already processed before, stop here (prevents double-crediting)
    $stmt = $pdo->prepare("SELECT processed FROM webhook_log WHERE tx_ref = ? LIMIT 1");
    $stmt->execute([$tx_ref]);
    $log = $stmt->fetch();
    if ($log && (int)$log['processed'] === 1) {
        http_response_code(200);
        exit('Already processed');
    }

    // ============================================================
    // ROUTE BY EVENT TYPE
    // ============================================================

    // ── OUTGOING TRANSFER COMPLETED (withdrawal payout) ──────────
    if ($event_type === 'transfer.completed') {
        $ref = $payload['data']['reference'] ?? null;
        if (!$ref) { http_response_code(200); exit('No reference'); }

        $stmt = $pdo->prepare("SELECT id, user_id, amount FROM withdrawal_requests WHERE reference = ? LIMIT 1");
        $stmt->execute([$ref]);
        $wr = $stmt->fetch();

        if ($wr) {
            $new_status = in_array($status, ['successful', 'completed']) ? 'paid' : 'rejected';
            $pdo->prepare("UPDATE withdrawal_requests SET status=? WHERE id=?")->execute([$new_status, $wr['id']]);

            if ($new_status === 'paid') {
                $pdo->prepare("
                    INSERT INTO notifications (user_id, title, message, type, created_at)
                    VALUES (?, '💸 Withdrawal Successful', ?, 'withdrawal', NOW())
                ")->execute([$wr['user_id'],
                    "₦" . number_format($wr['amount'], 2) . " has been successfully sent to your bank account."
                ]);
            } else {
                // Transfer failed after approval — refund the user
                $stmt = $pdo->prepare("SELECT total_debited FROM withdrawal_requests WHERE id=? LIMIT 1");
                $stmt->execute([$wr['id']]);
                $amount_to_refund = (float)($stmt->fetch()['total_debited'] ?? 0);
                if ($amount_to_refund > 0) {
                    $pdo->prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?")
                        ->execute([$amount_to_refund, $wr['user_id']]);
                    $pdo->prepare("
                        INSERT INTO notifications (user_id, title, message, type, created_at)
                        VALUES (?, '❌ Withdrawal Failed', ?, 'withdrawal', NOW())
                    ")->execute([$wr['user_id'],
                        "Your withdrawal could not be completed. ₦" . number_format($amount_to_refund, 2) . " has been returned to your wallet."
                    ]);
                }
            }
        }

        $pdo->prepare("UPDATE webhook_log SET processed = 1 WHERE tx_ref = ?")->execute([$tx_ref]);
        http_response_code(200);
        exit('Transfer webhook handled');
    }

    // ── INCOMING DEPOSIT (virtual account credit) ─────────────────
    if ($event_type !== 'charge.completed' || !in_array($status, ['successful', 'completed'])) {
        http_response_code(200);
        exit('Event ignored');
    }

    $account_number = $payload['data']['account_number']
        ?? $payload['data']['meta']['account_number']
        ?? null;

    if (empty($account_number)) {
        http_response_code(200);
        exit('No account number found in payload');
    }

    // Match the account number to a real Ememart user
    $stmt = $pdo->prepare("
        SELECT va.user_id, va.account_number, u.full_name, u.wallet_balance
        FROM virtual_accounts va
        JOIN users u ON u.id = va.user_id
        WHERE va.account_number = ? AND va.status = 'active' LIMIT 1
    ");
    $stmt->execute([$account_number]);
    $owner = $stmt->fetch();

    if (!$owner) {
        http_response_code(200);
        exit('No matching wallet found for this account number');
    }

    // ============================================================
    // CREDIT THE WALLET
    // ============================================================
    $pdo->beginTransaction();

    $pdo->prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?")
        ->execute([$amount, $owner['user_id']]);

    $pdo->prepare("
        INSERT INTO transactions (user_id, type, category, amount, description, reference, created_at)
        VALUES (?, 'credit', 'deposit', ?, ?, ?, NOW())
    ")->execute([
        $owner['user_id'], $amount,
        "Bank transfer to wallet — {$account_number}", $tx_ref
    ]);

    $pdo->prepare("
        INSERT INTO notifications (user_id, title, message, type, created_at)
        VALUES (?, 'Wallet Funded 💰', ?, 'deposit', NOW())
    ")->execute([
        $owner['user_id'],
        "Your wallet has been credited with ₦" . number_format($amount, 2) . " via bank transfer."
    ]);

    $pdo->prepare("UPDATE webhook_log SET processed = 1 WHERE tx_ref = ?")
        ->execute([$tx_ref]);

    $pdo->commit();

    http_response_code(200);
    echo "Wallet credited successfully.";

} catch (Exception $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    http_response_code(500);
    echo "Error processing webhook: " . $e->getMessage();
}
?>
