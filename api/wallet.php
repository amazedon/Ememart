<?php
// api/wallet.php
require_once 'config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(["success" => false, "message" => "Method not allowed"]);
    exit;
}

$data = json_decode(file_get_contents("php://input"), true);
$action  = $data['action'] ?? '';  // balance, set_pin, transfer, lock_savings
$user_id = $data['user_id'] ?? '';

if (empty($user_id)) {
    echo json_encode(["success" => false, "message" => "User ID session parameter required."]);
    exit;
}

try {
    switch ($action) {
        
        // ACTION A: BALANCE INQUIRY
        case 'balance':
            $stmt = $pdo->prepare("SELECT balance, locked_savings_balance, savings_unlock_date, (transaction_pin_hash IS NOT NULL) as pin_is_set FROM wallets WHERE user_id = ?");
            $stmt->execute([$user_id]);
            $wallet = $stmt->fetch();
            
            if (!$wallet) {
                echo json_encode(["success" => false, "message" => "Wallet matching session context not found."]);
            } else {
                echo json_encode([
                    "success" => true, 
                    "balance" => (float)$wallet['balance'],
                    "locked_savings" => (float)$wallet['locked_savings_balance'],
                    "unlock_date" => $wallet['savings_unlock_date'],
                    "pin_set" => (bool)$wallet['pin_is_set']
                ]);
            }
            break;

        // ACTION B: SET 4-DIGIT PIN SIGNATURE
        case 'set_pin':
            $pin = $data['pin'] ?? '';
            if (!preg_match('/^\d{4}$/', $pin)) {
                echo json_encode(["success" => false, "message" => "PIN sequence must be exactly 4 digits long."]);
                exit;
            }
            
            $pin_hash = password_hash($pin, PASSWORD_BCRYPT);
            $stmt = $pdo->prepare("UPDATE wallets SET transaction_pin_hash = ? WHERE user_id = ?");
            $stmt->execute([$pin_hash, $user_id]);
            
            echo json_encode(["success" => true, "message" => "Your 4-digit transaction security PIN has been set."]);
            break;

        // ACTION C: PEER-TO-PEER P2P MARKET TRADING TRANSFER
        case 'transfer':
            $recipient_email = $data['recipient_email'] ?? '';
            $amount = (float)($data['amount'] ?? 0);
            $pin = $data['pin'] ?? '';

            if ($amount <= 0 || empty($recipient_email) || empty($pin)) {
                echo json_encode(["success" => false, "message" => "Invalid transfer parameters."]);
                exit;
            }

            // Verify Sender Wallet & Check Security Pin
            $stmt = $pdo->prepare("SELECT * FROM wallets WHERE user_id = ?");
            $stmt->execute([$user_id]);
            $senderWallet = $stmt->fetch();

            if (!$senderWallet || !password_verify($pin, $senderWallet['transaction_pin_hash'])) {
                echo json_encode(["success" => false, "message" => "Security verification failure: Invalid transaction PIN."]);
                exit;
            }

            if ((float)$senderWallet['balance'] < $amount) {
                echo json_encode(["success" => false, "message" => "Insufficient funds inside account wallet balance."]);
                exit;
            }

            // Look up Recipient User Profile
            $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ?");
            $stmt->execute([$recipient_email]);
            $recipient = $stmt->fetch();

            if (!$recipient) {
                echo json_encode(["success" => false, "message" => "Target recipient identity profile not found."]);
                exit;
            }
            
            if ((int)$recipient['id'] === (int)$user_id) {
                echo json_encode(["success" => false, "message" => "Cannot process ledger transfer out to self."]);
                exit;
            }

            // Execute Transaction Ledger Balancing inside Database
            $pdo->beginTransaction();
            
            $stmt = $pdo->prepare("UPDATE wallets SET balance = balance - ? WHERE user_id = ?");
            $stmt->execute([$amount, $user_id]);
            
            $stmt = $pdo->prepare("UPDATE wallets SET balance = balance + ? WHERE user_id = ?");
            $stmt->execute([$amount, $recipient['id']]);
            
            $pdo->commit();
            echo json_encode(["success" => true, "message" => "Ledger transfer completed successfully."]);
            break;

        // ACTION D: FIXED TERM LOCKED SAVINGS PLAN
        case 'lock_savings':
            $amount = (float)($data['amount'] ?? 0);
            $duration_days = (int)($data['duration_days'] ?? 30); // 30, 60, 90, 180 etc

            if ($amount <= 0 || $duration_days <= 0) {
                echo json_encode(["success" => false, "message" => "Invalid savings values."]);
                exit;
            }

            $stmt = $pdo->prepare("SELECT balance FROM wallets WHERE user_id = ?");
            $stmt->execute([$user_id]);
            $wallet = $stmt->fetch();

            if (!$wallet || (float)$wallet['balance'] < $amount) {
                echo json_encode(["success" => false, "message" => "Insufficient balance to lock."]);
                exit;
            }

            $unlock_date = date("Y-m-d H:i:s", strtotime("+$duration_days days"));

            $pdo->beginTransaction();
            $stmt = $pdo->prepare("UPDATE wallets SET balance = balance - ?, locked_savings_balance = locked_savings_balance + ?, savings_unlock_date = ? WHERE user_id = ?");
            $stmt->execute([$amount, $amount, $unlock_date, $user_id]);
            $pdo->commit();

            echo json_encode(["success" => true, "message" => "Funds safely committed to locked savings vault until $unlock_date."]);
            break;

        default:
            echo json_encode(["success" => false, "message" => "Specified wallet action directive unknown."]);
            break;
    }
} catch (Exception $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    echo json_encode(["success" => false, "message" => "Fintech module exception error state."]);
}
?>
