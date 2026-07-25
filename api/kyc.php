<?php
// api/kyc.php
require_once 'config.php';
session_start();

$user_id = (int)($_SESSION['user_id'] ?? 0);
if (!$user_id) {
    respond(false, "Unauthorised. Please sign in.");
}

$body   = getBody();
$action = clean($body['action'] ?? 'submit');

// ============================================================
// HELPER: Upload a base64 image to Cloudinary (reuses media.php logic)
// ============================================================
function uploadKycImage($base64_data, $folder = 'ememart/kyc') {
    $timestamp = time();
    $params_to_sign = "folder=$folder&timestamp=$timestamp" . CLOUDINARY_API_SECRET;
    $signature = sha1($params_to_sign);

    $url = "https://api.cloudinary.com/v1_1/" . CLOUDINARY_CLOUD_NAME . "/image/upload";
    $payload = [
        'file'      => $base64_data,
        'api_key'   => CLOUDINARY_API_KEY,
        'timestamp' => $timestamp,
        'signature' => $signature,
        'folder'    => $folder,
    ];

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_TIMEOUT        => 30,
    ]);
    $response = curl_exec($ch);
    curl_close($ch);

    $result = json_decode($response, true);
    return $result['secure_url'] ?? null;
}

switch ($action) {

    // ----------------------------------------------------------
    // SUBMIT — buyer/vendor submits KYC documents for manual review
    // ----------------------------------------------------------
    case 'submit':
        $bvn          = clean($body['bvn'] ?? '');
        $nin          = clean($body['nin'] ?? '');
        $selfie       = $body['selfie']       ?? '';
        $utility_bill = $body['utility_bill'] ?? '';

        if (!preg_match('/^\d{11}$/', $bvn)) respond(false, "Enter a valid 11-digit BVN.");
        if (!preg_match('/^\d{11}$/', $nin)) respond(false, "Enter a valid 11-digit NIN.");
        if (empty($selfie)) respond(false, "Selfie with ID is required.");

        // Check if already submitted
        $stmt = $pdo->prepare("SELECT id, status FROM kyc_verifications WHERE user_id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $existing = $stmt->fetch();
        if ($existing && $existing['status'] !== 'rejected') {
            respond(false, "You already have a KYC submission " . $existing['status'] . ".");
        }

        // Check wallet balance for ₦100 fee
        $stmt = $pdo->prepare("SELECT wallet_balance FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch();
        if (!$user || (float)$user['wallet_balance'] < 100) {
            respond(false, "Insufficient wallet balance. Fund your wallet with at least ₦100.");
        }

        // Upload images to Cloudinary
        $selfie_url = uploadKycImage($selfie);
        if (!$selfie_url) respond(false, "Selfie upload failed. Please try again.");

        $bill_url = !empty($utility_bill) ? uploadKycImage($utility_bill) : null;

        // Debit KYC fee (read from settings table)
        $kyc_fee_stmt = $pdo->prepare("SELECT value FROM settings WHERE name = 'kyc_fee' LIMIT 1");
        $kyc_fee_stmt->execute();
        $kyc_fee = (float)(($kyc_fee_stmt->fetch())['value'] ?? 100);

        $pdo->prepare("UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?")
            ->execute([$kyc_fee, $user_id]);
        $pdo->prepare("
            INSERT INTO transactions (user_id, type, category, amount, description, created_at)
            VALUES (?, 'debit', 'kyc', ?, 'KYC verification fee', NOW())
        ")->execute([$user_id, $kyc_fee]);

        // Save or update KYC record (rejected users can resubmit)
        if ($existing) {
            $pdo->prepare("
                UPDATE kyc_verifications
                SET bvn=?, nin=?, selfie=?, utility_bill=?, status='pending',
                    admin_note=NULL, reviewed_by=NULL, reviewed_at=NULL, created_at=NOW()
                WHERE user_id=?
            ")->execute([$bvn, $nin, $selfie_url, $bill_url, $user_id]);
        } else {
            $pdo->prepare("
                INSERT INTO kyc_verifications (user_id, bvn, nin, selfie, utility_bill, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', NOW())
            ")->execute([$user_id, $bvn, $nin, $selfie_url, $bill_url]);
        }

        // Update user's kyc_status to pending
        $pdo->prepare("UPDATE users SET kyc_status = 'pending' WHERE id = ?")->execute([$user_id]);

        respond(true, "KYC submitted successfully. Admin will review within 24-48 hours.");
        break;

    // ----------------------------------------------------------
    // STATUS — check current KYC status for the logged-in user
    // ----------------------------------------------------------
    case 'status':
        $stmt = $pdo->prepare("
            SELECT status, admin_note, created_at FROM kyc_verifications
            WHERE user_id = ? LIMIT 1
        ");
        $stmt->execute([$user_id]);
        $record = $stmt->fetch();

        respond(true, "Status fetched.", [
            "status"     => $record['status']     ?? 'unverified',
            "admin_note" => $record['admin_note']  ?? null,
            "created_at" => $record['created_at']  ?? null,
        ]);
        break;

    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
