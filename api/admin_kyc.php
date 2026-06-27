<?php
// api/admin_kyc.php
require_once 'config.php';
require_once '_virtual_account_helper.php';
session_start();

// ============================================================
// ADMIN AUTH + PERMISSION CHECK
// ============================================================
$admin_id = (int)($_SESSION['admin_id'] ?? 0);
if (!$admin_id) {
    respond(false, "Admin access required. Please sign in as admin.");
}

$stmt = $pdo->prepare("
    SELECT s.is_active, r.permissions
    FROM admin_staff s
    JOIN admin_roles r ON r.id = s.role_id
    WHERE s.user_id = ? LIMIT 1
");
$stmt->execute([$admin_id]);
$staff = $stmt->fetch();

if (!$staff || !$staff['is_active']) {
    respond(false, "Your admin access has been deactivated.");
}

$permissions = json_decode($staff['permissions'], true) ?? [];
if (empty($permissions['all']) && empty($permissions['kyc'])) {
    respond(false, "You don't have permission to review KYC submissions.");
}

$body   = getBody();
$action = clean($body['action'] ?? $_GET['action'] ?? 'list');

switch ($action) {

    // ----------------------------------------------------------
    // LIST — fetch all pending KYC submissions for manual review
    // ----------------------------------------------------------
    case 'list':
        $status = clean($_GET['status'] ?? $body['status'] ?? 'pending');
        $allowed = ['pending', 'verified', 'rejected', 'all'];
        if (!in_array($status, $allowed)) $status = 'pending';

        $sql = "
            SELECT k.id, k.user_id, k.bvn, k.nin, k.selfie, k.utility_bill,
                   k.status, k.admin_note, k.created_at, k.reviewed_at,
                   u.full_name, u.email, u.phone, u.role
            FROM kyc_verifications k
            JOIN users u ON u.id = k.user_id
        ";
        if ($status !== 'all') {
            $sql .= " WHERE k.status = ? ";
            $stmt = $pdo->prepare($sql . " ORDER BY k.created_at DESC");
            $stmt->execute([$status]);
        } else {
            $stmt = $pdo->prepare($sql . " ORDER BY k.created_at DESC");
            $stmt->execute();
        }
        $records = $stmt->fetchAll();

        respond(true, "KYC submissions fetched.", ["submissions" => $records]);
        break;

    // ----------------------------------------------------------
    // APPROVE — manually verify a user's KYC
    // ----------------------------------------------------------
    case 'approve':
        $kyc_id = (int)($body['kyc_id'] ?? 0);
        if (!$kyc_id) respond(false, "KYC ID is required.");

        $stmt = $pdo->prepare("SELECT user_id FROM kyc_verifications WHERE id = ? LIMIT 1");
        $stmt->execute([$kyc_id]);
        $record = $stmt->fetch();
        if (!$record) respond(false, "KYC submission not found.");

        $pdo->prepare("
            UPDATE kyc_verifications
            SET status='verified', reviewed_by=?, reviewed_at=NOW()
            WHERE id=?
        ")->execute([$admin_id, $kyc_id]);

        $pdo->prepare("UPDATE users SET kyc_status='verified' WHERE id=?")
            ->execute([$record['user_id']]);

        // Notify user
        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'KYC Approved ✅', 'Your identity verification has been approved. You now have full access to all features.', 'kyc', NOW())
        ")->execute([$record['user_id']]);

        $pdo->prepare("
            INSERT INTO admin_activity_log (admin_id, action, target_type, target_id, created_at)
            VALUES (?, 'kyc_approve', 'kyc', ?, NOW())
        ")->execute([$admin_id, $kyc_id]);

        // ============================================================
        // Automatically attempt to create their Flutterwave virtual account
        // using the same BVN they already submitted — this is a SEPARATE,
        // independent check by Flutterwave/the bank, not guaranteed by your approval
        // ============================================================
        $va_result = attemptCreateVirtualAccount($pdo, $record['user_id']);

        if ($va_result['success'] && empty($va_result['already_existed'])) {
            $pdo->prepare("
                INSERT INTO notifications (user_id, title, message, type, created_at)
                VALUES (?, 'Bank Account Ready 🏦', ?, 'virtual_account', NOW())
            ")->execute([
                $record['user_id'],
                "Your dedicated bank account is ready: {$va_result['bank_name']} — {$va_result['account_number']}. Transfer to it anytime to fund your wallet."
            ]);
            respond(true, "KYC approved successfully. Virtual account created: {$va_result['bank_name']} {$va_result['account_number']}.");
        } elseif (!$va_result['success']) {
            // KYC is still approved — only the virtual account step failed
            respond(true, "KYC approved successfully. Note: Flutterwave could not issue a virtual account for this BVN ({$va_result['message']}). The user can still fund via card/checkout.");
        } else {
            respond(true, "KYC approved successfully.");
        }
        break;

    // ----------------------------------------------------------
    // REJECT — manually reject a user's KYC with a reason
    // ----------------------------------------------------------
    case 'reject':
        $kyc_id = (int)($body['kyc_id'] ?? 0);
        $reason = clean($body['reason'] ?? 'Documents unclear or invalid. Please resubmit.');
        if (!$kyc_id) respond(false, "KYC ID is required.");

        $stmt = $pdo->prepare("SELECT user_id FROM kyc_verifications WHERE id = ? LIMIT 1");
        $stmt->execute([$kyc_id]);
        $record = $stmt->fetch();
        if (!$record) respond(false, "KYC submission not found.");

        $pdo->prepare("
            UPDATE kyc_verifications
            SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=NOW()
            WHERE id=?
        ")->execute([$reason, $admin_id, $kyc_id]);

        $pdo->prepare("UPDATE users SET kyc_status='unverified' WHERE id=?")
            ->execute([$record['user_id']]);

        // Refund the ₦100 KYC fee since it was rejected
        $pdo->prepare("UPDATE users SET wallet_balance = wallet_balance + 100 WHERE id=?")
            ->execute([$record['user_id']]);
        $pdo->prepare("
            INSERT INTO transactions (user_id, type, category, amount, description, created_at)
            VALUES (?, 'credit', 'refund', 100, 'KYC fee refunded — submission rejected', NOW())
        ")->execute([$record['user_id']]);

        // Notify user
        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'KYC Rejected ❌', ?, 'kyc', NOW())
        ")->execute([$record['user_id'], "Your KYC submission was rejected: $reason Your ₦100 fee has been refunded."]);

        $pdo->prepare("
            INSERT INTO admin_activity_log (admin_id, action, target_type, target_id, details, created_at)
            VALUES (?, 'kyc_reject', 'kyc', ?, ?, NOW())
        ")->execute([$admin_id, $kyc_id, $reason]);

        respond(true, "KYC rejected and fee refunded.");
        break;

    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
