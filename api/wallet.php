<?php
// api/wallet.php
require_once 'config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(false, "Method not allowed");
}

$body   = getBody();
$action = clean($body['action'] ?? '');

// ============================================================
// AUTH CHECK — all wallet actions require a logged-in user
// except verify_funding (called from Flutterwave callback)
// ============================================================
session_start();
$user_id = (int)($_SESSION['user_id'] ?? $body['user_id'] ?? 0);

if (!$user_id && $action !== 'verify_funding') {
    respond(false, "Unauthorised. Please sign in.");
}

// ============================================================
// HELPER: Get fresh user row from DB
// ============================================================
function getUser($pdo, $user_id) {
    $stmt = $pdo->prepare("
        SELECT id, full_name, email, phone, wallet_balance,
               kyc_status, vendor_tier, role, referral_code
        FROM users WHERE id = ? LIMIT 1
    ");
    $stmt->execute([$user_id]);
    return $stmt->fetch();
}

// ============================================================
// HELPER: Debit wallet safely (with balance check)
// ============================================================
function debitWallet($pdo, $user_id, $amount) {
    $stmt = $pdo->prepare("
        UPDATE users SET wallet_balance = wallet_balance - ?
        WHERE id = ? AND wallet_balance >= ?
    ");
    $stmt->execute([$amount, $user_id, $amount]);
    return $stmt->rowCount() > 0; // returns false if insufficient balance
}

// ============================================================
// HELPER: Credit wallet
// ============================================================
function creditWallet($pdo, $user_id, $amount) {
    $stmt = $pdo->prepare("
        UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?
    ");
    $stmt->execute([$amount, $user_id]);
    // Keep wallets table in sync
    $pdo->prepare("
        UPDATE wallets SET balance = balance + ? WHERE user_id = ?
    ")->execute([$amount, $user_id]);
}

// ============================================================
// HELPER: Log transaction
// ============================================================
function logTransaction($pdo, $user_id, $type, $category, $amount, $desc, $reference = null) {
    $stmt = $pdo->prepare("
        INSERT INTO transactions
            (user_id, type, category, amount, description, reference, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
    ");
    $stmt->execute([$user_id, $type, $category, $amount, $desc, $reference]);
}

// ============================================================
// ROUTE ACTIONS
// ============================================================
switch ($action) {

    // ----------------------------------------------------------
    // BALANCE — fetch live wallet balance
    // ----------------------------------------------------------
    case 'balance':
        $user = getUser($pdo, $user_id);
        if (!$user) respond(false, "User not found.");
        respond(true, "Balance fetched.", [
            "balance"     => (float)$user['wallet_balance'],
            "new_balance" => number_format((float)$user['wallet_balance'], 2)
        ]);
        break;

    // ----------------------------------------------------------
    // INITIATE FUNDING — generate Flutterwave payment reference
    // ----------------------------------------------------------
    case 'initiate_funding':
        $amount = (float)($body['amount'] ?? 0);
        if ($amount < 100) respond(false, "Minimum funding amount is ₦100.");

        $user = getUser($pdo, $user_id);
        if (!$user) respond(false, "User not found.");

        // Generate unique reference
        $reference = 'EMW-' . strtoupper(bin2hex(random_bytes(8))) . '-' . time();

        // Store pending transaction
        $stmt = $pdo->prepare("
            INSERT INTO pending_payments
                (user_id, reference, amount, type, status, created_at)
            VALUES (?, ?, ?, 'funding', 'pending', NOW())
        ");
        $stmt->execute([$user_id, $reference, $amount]);

        respond(true, "Payment initiated.", [
            "reference"  => $reference,
            "public_key" => "FLWPUBK-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-X", // replace with your Flutterwave public key
            "email"      => $user['email'],
            "phone"      => $user['phone'],
            "name"       => $user['full_name'],
            "amount"     => $amount,
        ]);
        break;

    // ----------------------------------------------------------
    // VERIFY FUNDING — confirm Flutterwave payment and credit wallet
    // ----------------------------------------------------------
    case 'verify_funding':
        $transaction_id = clean($body['transaction_id'] ?? '');
        $reference      = clean($body['reference']      ?? '');

        if (empty($transaction_id) || empty($reference)) {
            respond(false, "Transaction ID and reference are required.");
        }

        // Check reference exists and is still pending
        $stmt = $pdo->prepare("
            SELECT * FROM pending_payments
            WHERE reference = ? AND status = 'pending' LIMIT 1
        ");
        $stmt->execute([$reference]);
        $pending = $stmt->fetch();
        if (!$pending) respond(false, "Invalid or already processed reference.");

        // Verify with Flutterwave API
        $flw_secret = "FLWSECK-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-X"; // replace with your Flutterwave secret key
        $ch = curl_init("https://api.flutterwave.com/v3/transactions/$transaction_id/verify");
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER     => [
                "Authorization: Bearer $flw_secret",
                "Content-Type: application/json"
            ],
        ]);
        $flw_response = json_decode(curl_exec($ch), true);
        curl_close($ch);

        if (
            isset($flw_response['status']) &&
            $flw_response['status'] === 'success' &&
            $flw_response['data']['status'] === 'successful' &&
            (float)$flw_response['data']['amount'] >= (float)$pending['amount'] &&
            $flw_response['data']['currency'] === 'NGN'
        ) {
            $amount  = (float)$pending['amount'];
            $fund_uid = (int)$pending['user_id'];

            // Credit wallet
            creditWallet($pdo, $fund_uid, $amount);

            // Mark payment as completed
            $pdo->prepare("
                UPDATE pending_payments SET status = 'completed', transaction_id = ?
                WHERE reference = ?
            ")->execute([$transaction_id, $reference]);

            // Log transaction
            logTransaction($pdo, $fund_uid, 'credit', 'deposit', $amount,
                "Wallet funded via Flutterwave", $reference);

            // Get new balance
            $user = getUser($pdo, $fund_uid);
            respond(true, "Wallet funded successfully.", [
                "new_balance" => number_format((float)$user['wallet_balance'], 2),
                "amount"      => $amount,
            ]);
        } else {
            respond(false, "Payment verification failed. Contact support if charged.");
        }
        break;

    // ----------------------------------------------------------
    // WITHDRAW — bank withdrawal
    // ----------------------------------------------------------
    case 'withdraw':
        $amount     = (float)($body['amount']     ?? 0);
        $bank       = clean($body['bank']         ?? '');
        $account_no = clean($body['account_no']   ?? '');
        $account_name = clean($body['account_name'] ?? '');

        if ($amount < 100)   respond(false, "Minimum withdrawal is ₦100.");
        if (empty($bank))    respond(false, "Please select a bank.");
        if (strlen($account_no) !== 10) respond(false, "Enter a valid 10-digit account number.");

        $user = getUser($pdo, $user_id);
        if (!$user) respond(false, "User not found.");

        // Get admin withdrawal fee
        $stmt = $pdo->prepare("SELECT value FROM settings WHERE name = 'withdrawal_fee' LIMIT 1");
        $stmt->execute();
        $fee_row = $stmt->fetch();
        $fee = (float)($fee_row['value'] ?? 0);

        $total_debit = $amount + $fee;
        if ($total_debit > (float)$user['wallet_balance']) {
            respond(false, "Insufficient wallet balance. Available: ₦" .
                number_format((float)$user['wallet_balance'], 2));
        }

        // Daily withdrawal limit check (3 per day)
        $stmt = $pdo->prepare("
            SELECT COUNT(*) as cnt FROM transactions
            WHERE user_id = ? AND category = 'withdrawal'
            AND DATE(created_at) = CURDATE()
        ");
        $stmt->execute([$user_id]);
        $daily = $stmt->fetch();
        if ((int)$daily['cnt'] >= 3) {
            respond(false, "Daily withdrawal limit reached (3 per day). Try again tomorrow.");
        }

        // 30-minute cooldown check
        $stmt = $pdo->prepare("
            SELECT created_at FROM transactions
            WHERE user_id = ? AND category = 'withdrawal'
            ORDER BY created_at DESC LIMIT 1
        ");
        $stmt->execute([$user_id]);
        $last = $stmt->fetch();
        if ($last && strtotime($last['created_at']) > strtotime('-30 minutes')) {
            respond(false, "Please wait 30 minutes between withdrawals.");
        }

        // Debit wallet
        if (!debitWallet($pdo, $user_id, $total_debit)) {
            respond(false, "Insufficient balance.");
        }

        // Log withdrawal transaction
        $ref = 'WDR-' . strtoupper(bin2hex(random_bytes(6))) . '-' . time();
        logTransaction($pdo, $user_id, 'debit', 'withdrawal', $total_debit,
            "Withdrawal to $bank — $account_no ($account_name)", $ref);

        // Log platform fee if any
        if ($fee > 0) {
            logTransaction($pdo, $user_id, 'debit', 'withdrawal_fee', $fee,
                "Withdrawal fee", $ref);
        }

        // Get new balance
        $user = getUser($pdo, $user_id);
        respond(true, "Withdrawal of ₦" . number_format($amount, 2) . " is being processed.", [
            "new_balance" => number_format((float)$user['wallet_balance'], 2),
            "reference"   => $ref,
        ]);
        break;

    // ----------------------------------------------------------
    // TRANSFER — wallet to wallet
    // ----------------------------------------------------------
    case 'transfer':
        $amount    = (float)($body['amount']    ?? 0);
        $recipient = clean($body['recipient']   ?? ''); // EM-ID or email

        if ($amount < 100)    respond(false, "Minimum transfer is ₦100.");
        if (empty($recipient)) respond(false, "Enter a recipient account ID or email.");

        $user = getUser($pdo, $user_id);
        if (!$user) respond(false, "User not found.");

        // Find recipient
        if (strpos($recipient, 'EM-') === 0) {
            $rec_id = (int)str_replace('EM-', '', $recipient);
            $stmt   = $pdo->prepare("SELECT id, full_name, email FROM users WHERE id = ? LIMIT 1");
            $stmt->execute([$rec_id]);
        } else {
            $stmt = $pdo->prepare("SELECT id, full_name, email FROM users WHERE email = ? LIMIT 1");
            $stmt->execute([$recipient]);
        }
        $rec = $stmt->fetch();
        if (!$rec) respond(false, "Recipient not found. Check the account ID or email.");
        if ((int)$rec['id'] === $user_id) respond(false, "You cannot transfer to yourself.");

        if ($amount > (float)$user['wallet_balance']) {
            respond(false, "Insufficient wallet balance.");
        }

        // Debit sender
        if (!debitWallet($pdo, $user_id, $amount)) {
            respond(false, "Insufficient balance.");
        }

        // Credit recipient
        creditWallet($pdo, (int)$rec['id'], $amount);

        $ref = 'TRF-' . strtoupper(bin2hex(random_bytes(6))) . '-' . time();

        // Log for sender
        logTransaction($pdo, $user_id, 'debit', 'transfer',
            $amount, "Transfer to {$rec['full_name']} (EM-{$rec['id']})", $ref);

        // Log for recipient
        logTransaction($pdo, (int)$rec['id'], 'credit', 'transfer',
            $amount, "Transfer from {$user['full_name']} (EM-$user_id)", $ref);

        $user = getUser($pdo, $user_id);
        respond(true, "₦" . number_format($amount, 2) . " sent to {$rec['full_name']}.", [
            "new_balance" => number_format((float)$user['wallet_balance'], 2),
            "reference"   => $ref,
        ]);
        break;

    // ----------------------------------------------------------
    // SET PIN — create or change wallet transaction PIN
    // ----------------------------------------------------------
    case 'set_pin':
        $pin         = $body['pin']         ?? '';
        $confirm_pin = $body['confirm_pin'] ?? '';

        if (strlen($pin) !== 4 || !ctype_digit($pin)) {
            respond(false, "PIN must be exactly 4 digits.");
        }
        if ($pin !== $confirm_pin) {
            respond(false, "PINs do not match.");
        }

        // Weak PIN check
        if (preg_match('/^(\d)\1{3}$/', $pin)) {
            respond(false, "PIN too weak. Avoid repeating digits like 1111.");
        }

        $pin_hash = password_hash($pin, PASSWORD_BCRYPT);
        $stmt = $pdo->prepare("UPDATE users SET transaction_pin = ? WHERE id = ?");
        $stmt->execute([$pin_hash, $user_id]);

        respond(true, "Transaction PIN set successfully.");
        break;

    // ----------------------------------------------------------
    // VERIFY PIN — check PIN before sensitive actions
    // ----------------------------------------------------------
    case 'verify_pin':
        $pin = $body['pin'] ?? '';
        if (empty($pin)) respond(false, "PIN is required.");

        $stmt = $pdo->prepare("SELECT transaction_pin FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $row = $stmt->fetch();

        if (!$row || empty($row['transaction_pin'])) {
            respond(false, "No PIN set. Please set a transaction PIN first.");
        }

        if (!password_verify($pin, $row['transaction_pin'])) {
            respond(false, "Incorrect PIN.");
        }

        respond(true, "PIN verified.");
        break;

    // ----------------------------------------------------------
    // TRANSACTIONS — fetch transaction history
    // ----------------------------------------------------------
    case 'transactions':
        $limit  = min((int)($body['limit']  ?? 30), 100);
        $offset = (int)($body['offset'] ?? 0);

        $stmt = $pdo->prepare("
            SELECT type, category, amount, description, reference, created_at
            FROM transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        ");
        $stmt->execute([$user_id, $limit, $offset]);
        $txns = $stmt->fetchAll();

        respond(true, "Transactions fetched.", ["transactions" => $txns]);
        break;

    // ----------------------------------------------------------
    // DEFAULT
    // ----------------------------------------------------------
    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
