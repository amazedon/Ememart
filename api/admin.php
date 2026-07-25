<?php
// api/admin.php
require_once 'config.php';
session_start();

$body   = getBody();
$action = clean($body['action'] ?? $_GET['action'] ?? '');

// ============================================================
// HELPER: Get logged-in admin's role + permissions
// ============================================================
function getAdminContext($pdo) {
    $admin_id = (int)($_SESSION['admin_id'] ?? 0);
    if (!$admin_id) return null;

    $stmt = $pdo->prepare("
        SELECT s.id as staff_id, s.is_active, u.id as user_id, u.full_name, u.email,
               r.name as role_name, r.label as role_label, r.permissions
        FROM admin_staff s
        JOIN users u ON u.id = s.user_id
        JOIN admin_roles r ON r.id = s.role_id
        WHERE s.user_id = ? LIMIT 1
    ");
    $stmt->execute([$admin_id]);
    $row = $stmt->fetch();
    if (!$row || !$row['is_active']) return null;

    $row['permissions'] = json_decode($row['permissions'], true) ?? [];
    return $row;
}

// ============================================================
// HELPER: Check if current admin has a specific permission
// ============================================================
function hasPermission($admin, $perm) {
    if (!$admin) return false;
    if (!empty($admin['permissions']['all'])) return true;
    return !empty($admin['permissions'][$perm]);
}

// ============================================================
// HELPER: Log an admin action
// ============================================================
function logAdminAction($pdo, $admin_id, $action, $target_type = null, $target_id = null, $details = null) {
    $pdo->prepare("
        INSERT INTO admin_activity_log (admin_id, action, target_type, target_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
    ")->execute([$admin_id, $action, $target_type, $target_id, $details]);
}

switch ($action) {

    // ----------------------------------------------------------
    // LOGIN — admin login that also checks admin_staff table
    // ----------------------------------------------------------
    case 'login':
        $email    = clean($body['email'] ?? '');
        $password = $body['password'] ?? '';

        if (empty($email) || empty($password)) {
            respond(false, "Email and password are required.");
        }

        $stmt = $pdo->prepare("
            SELECT u.id, u.full_name, u.email, u.password_hash,
                   s.id as staff_id, s.is_active, r.name as role_name, r.label as role_label, r.permissions
            FROM users u
            JOIN admin_staff s ON s.user_id = u.id
            JOIN admin_roles r ON r.id = s.role_id
            WHERE u.email = ? LIMIT 1
        ");
        $stmt->execute([$email]);
        $admin = $stmt->fetch();

        if (!$admin || !password_verify($password, $admin['password_hash'])) {
            respond(false, "Incorrect admin credentials.");
        }

        if (!$admin['is_active']) {
            respond(false, "Your admin access has been deactivated. Contact super admin.");
        }

        $_SESSION['admin_id'] = $admin['id'];

        logAdminAction($pdo, $admin['id'], 'login');

        respond(true, "Login successful.", [
            "admin" => [
                "id"          => (int)$admin['id'],
                "full_name"   => $admin['full_name'],
                "email"       => $admin['email'],
                "role_name"   => $admin['role_name'],
                "role_label"  => $admin['role_label'],
                "permissions" => json_decode($admin['permissions'], true),
            ]
        ]);
        break;

    // ----------------------------------------------------------
    // LOGOUT
    // ----------------------------------------------------------
    // ----------------------------------------------------------
    // CHANGE PASSWORD — logged-in admin updates their own password
    // ----------------------------------------------------------
    case 'change_password':
        $admin_id = (int)($_SESSION['admin_id'] ?? 0);
        if (!$admin_id) respond(false, "Please sign in first.");

        $current_password = $body['current_password'] ?? '';
        $new_password     = $body['new_password']     ?? '';

        if (empty($current_password) || empty($new_password)) {
            respond(false, "Current and new password are required.");
        }
        if (strlen($new_password) < 8) {
            respond(false, "New password must be at least 8 characters.");
        }

        $stmt = $pdo->prepare("SELECT password_hash FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$admin_id]);
        $user = $stmt->fetch();

        if (!$user || !password_verify($current_password, $user['password_hash'])) {
            respond(false, "Current password is incorrect.");
        }

        $new_hash = password_hash($new_password, PASSWORD_BCRYPT);
        $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ?")
            ->execute([$new_hash, $admin_id]);

        logAdminAction($pdo, $admin_id, 'change_password');

        respond(true, "Password changed successfully.");
        break;

    // ----------------------------------------------------------
    // FORGOT PASSWORD — STEP 1: send OTP to admin's email
    // ----------------------------------------------------------
    case 'forgot_password_send_otp':
        $email = clean($body['email'] ?? '');
        if (empty($email) || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            respond(false, "Enter a valid email address.");
        }

        // Confirm this email belongs to an active admin staff member
        $stmt = $pdo->prepare("
            SELECT u.id, u.full_name FROM users u
            JOIN admin_staff s ON s.user_id = u.id
            WHERE u.email = ? AND s.is_active = 1 LIMIT 1
        ");
        $stmt->execute([$email]);
        $admin = $stmt->fetch();
        if (!$admin) {
            respond(false, "No active admin account found with that email.");
        }

        // Rate limit
        $stmt = $pdo->prepare("
            SELECT COUNT(*) as total FROM email_otps
            WHERE email = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        ");
        $stmt->execute([$email]);
        if ((int)$stmt->fetch()['total'] >= 3) {
            respond(false, "Too many reset requests. Please wait 10 minutes.");
        }

        $pdo->prepare("DELETE FROM email_otps WHERE email = ?")->execute([$email]);

        $otp        = (string)random_int(100000, 999999);
        $otp_hash   = password_hash($otp, PASSWORD_DEFAULT);
        $expires_at = date("Y-m-d H:i:s", strtotime("+10 minutes"));

        $pdo->prepare("
            INSERT INTO email_otps (email, otp_code, expires_at, created_at, purpose)
            VALUES (?, ?, ?, NOW(), 'forgot')
        ")->execute([$email, $otp_hash, $expires_at]);

        $subject = "$otp — Ememart Admin Password Reset";
        $message = "
        <div style='font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;'>
            <h2 style='color:#0d9488;'>Admin Password Reset</h2>
            <p>Hello {$admin['full_name']},</p>
            <p>Use this code to reset your Ememart admin dashboard password:</p>
            <div style='font-size:32px;font-weight:bold;letter-spacing:5px;
                        text-align:center;padding:20px;background:#f3f4f6;
                        border-radius:8px;margin:20px 0;'>$otp</div>
            <p style='color:#6b7280;font-size:12px;'>
                Expires in 10 minutes. If you did not request this, ignore this email
                and consider alerting your Super Admin.
            </p>
        </div>";
        $headers  = "MIME-Version: 1.0\r\nContent-type: text/html; charset=UTF-8\r\n";
        $headers .= "From: Ememart <" . SMTP_EMAIL . ">\r\n";
        @mail($email, $subject, $message, $headers);

        respond(true, "Reset code sent to $email.");
        break;

    // ----------------------------------------------------------
    // FORGOT PASSWORD — STEP 2: verify OTP and set new password
    // ----------------------------------------------------------
    case 'forgot_password_reset':
        $email       = clean($body['email'] ?? '');
        $otp         = clean($body['otp']   ?? '');
        $new_password = $body['new_password'] ?? '';

        if (empty($email) || empty($otp) || empty($new_password)) {
            respond(false, "Email, code, and new password are required.");
        }
        if (strlen($new_password) < 8) {
            respond(false, "New password must be at least 8 characters.");
        }

        $stmt = $pdo->prepare("
            SELECT id, otp_code FROM email_otps
            WHERE email = ? AND is_used = 0 AND expires_at > NOW() AND purpose = 'forgot'
            ORDER BY created_at DESC LIMIT 1
        ");
        $stmt->execute([$email]);
        $record = $stmt->fetch();

        if (!$record || !password_verify($otp, $record['otp_code'])) {
            respond(false, "Invalid or expired code.");
        }

        $pdo->prepare("UPDATE email_otps SET is_used = 1 WHERE id = ?")->execute([$record['id']]);

        $new_hash = password_hash($new_password, PASSWORD_BCRYPT);
        $pdo->prepare("UPDATE users SET password_hash = ? WHERE email = ?")
            ->execute([$new_hash, $email]);

        respond(true, "Password reset successfully. You can now sign in.");
        break;

    // ----------------------------------------------------------
    // LIST ROLE APPLICATIONS — fetch pending applications for review
    // ----------------------------------------------------------
    case 'list_role_applications':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'role_applications') && !hasPermission($admin, 'users')) {
            respond(false, "You don't have permission to review role applications.");
        }

        $status = clean($_GET['status'] ?? $body['status'] ?? 'pending');
        $allowed = ['pending', 'approved', 'rejected', 'all'];
        if (!in_array($status, $allowed)) $status = 'pending';

        $sql = "
            SELECT a.id, a.user_id, a.current_role, a.new_role, a.business_name,
                   a.reason, a.status, a.admin_note, a.created_at, a.reviewed_at,
                   u.full_name, u.email, u.phone
            FROM role_applications a
            JOIN users u ON u.id = a.user_id
        ";
        if ($status !== 'all') {
            $stmt = $pdo->prepare($sql . " WHERE a.status = ? ORDER BY a.created_at DESC");
            $stmt->execute([$status]);
        } else {
            $stmt = $pdo->query($sql . " ORDER BY a.created_at DESC");
        }
        $applications = $stmt->fetchAll();

        respond(true, "Applications fetched.", ["applications" => $applications]);
        break;

    // ----------------------------------------------------------
    // APPROVE ROLE APPLICATION — change the user's actual role
    // ----------------------------------------------------------
    case 'approve_role_application':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'role_applications') && !hasPermission($admin, 'users')) {
            respond(false, "You don't have permission to approve role applications.");
        }

        $app_id = (int)($body['app_id'] ?? 0);
        if (!$app_id) respond(false, "Application ID is required.");

        $stmt = $pdo->prepare("SELECT user_id, new_role FROM role_applications WHERE id = ? LIMIT 1");
        $stmt->execute([$app_id]);
        $app = $stmt->fetch();
        if (!$app) respond(false, "Application not found.");

        $pdo->prepare("
            UPDATE role_applications
            SET status='approved', reviewed_by=?, reviewed_at=NOW()
            WHERE id=?
        ")->execute([$admin['user_id'], $app_id]);

        $pdo->prepare("UPDATE users SET role=? WHERE id=?")
            ->execute([$app['new_role'], $app['user_id']]);

        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Role Approved ✅', ?, 'role_change', NOW())
        ")->execute([$app['user_id'], "Your application to become a " . ucfirst($app['new_role']) . " has been approved!"]);

        logAdminAction($pdo, $admin['user_id'], 'approve_role_application', 'role_application', $app_id);

        respond(true, "Role application approved. User is now a " . ucfirst($app['new_role']) . ".");
        break;

    // ----------------------------------------------------------
    // REJECT ROLE APPLICATION
    // ----------------------------------------------------------
    case 'reject_role_application':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'role_applications') && !hasPermission($admin, 'users')) {
            respond(false, "You don't have permission to reject role applications.");
        }

        $app_id = (int)($body['app_id'] ?? 0);
        $reason = clean($body['reason'] ?? 'Application did not meet requirements.');
        if (!$app_id) respond(false, "Application ID is required.");

        $stmt = $pdo->prepare("SELECT user_id, new_role FROM role_applications WHERE id = ? LIMIT 1");
        $stmt->execute([$app_id]);
        $app = $stmt->fetch();
        if (!$app) respond(false, "Application not found.");

        $pdo->prepare("
            UPDATE role_applications
            SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=NOW()
            WHERE id=?
        ")->execute([$reason, $admin['user_id'], $app_id]);

        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Role Application Rejected ❌', ?, 'role_change', NOW())
        ")->execute([$app['user_id'], "Your application to become a " . ucfirst($app['new_role']) . " was rejected: $reason"]);

        logAdminAction($pdo, $admin['user_id'], 'reject_role_application', 'role_application', $app_id, $reason);

        respond(true, "Role application rejected.");
        break;

    // ----------------------------------------------------------
    // LIST VTU PRICING — fetch all pricing rows grouped by service
    // ----------------------------------------------------------
    case 'list_vtu_pricing':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'fees')) {
            respond(false, "You don't have permission to manage VTU pricing.");
        }

        $stmt = $pdo->query("SELECT * FROM vtu_pricing ORDER BY service_type, provider_name, plan_name");
        $rows = $stmt->fetchAll();

        respond(true, "Pricing fetched.", ["pricing" => $rows]);
        break;

    // ----------------------------------------------------------
    // UPSERT VTU PRICING — add or update a wholesale/selling price row
    // ----------------------------------------------------------
    case 'upsert_vtu_pricing':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'fees')) {
            respond(false, "You don't have permission to manage VTU pricing.");
        }

        $service_type    = clean($body['service_type']    ?? '');
        $provider_id     = clean($body['provider_id']     ?? '');
        $provider_name   = clean($body['provider_name']   ?? '');
        $plan_id         = clean($body['plan_id']         ?? null);
        $plan_name       = clean($body['plan_name']       ?? null);
        $wholesale_price = (float)($body['wholesale_price'] ?? 0);
        $markup_type     = clean($body['markup_type']     ?? 'fixed');
        $markup_value    = (float)($body['markup_value']  ?? 0);

        if (empty($service_type) || empty($provider_id)) {
            respond(false, "Service type and provider are required.");
        }
        if (!in_array($markup_type, ['fixed', 'percent'])) $markup_type = 'fixed';

        $selling_price = $markup_type === 'percent'
            ? round($wholesale_price * (1 + $markup_value / 100), 2)
            : round($wholesale_price + $markup_value, 2);

        $stmt = $pdo->prepare("
            INSERT INTO vtu_pricing
                (service_type, provider_id, provider_name, plan_id, plan_name,
                 wholesale_price, selling_price, markup_type, markup_value, last_updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                provider_name = VALUES(provider_name),
                plan_name = VALUES(plan_name),
                wholesale_price = VALUES(wholesale_price),
                selling_price = VALUES(selling_price),
                markup_type = VALUES(markup_type),
                markup_value = VALUES(markup_value),
                last_updated_by = VALUES(last_updated_by)
        ");
        $stmt->execute([
            $service_type, $provider_id, $provider_name, $plan_id, $plan_name,
            $wholesale_price, $selling_price, $markup_type, $markup_value, $admin['user_id']
        ]);

        logAdminAction($pdo, $admin['user_id'], 'update_vtu_pricing', 'vtu_pricing', $provider_id,
            "Set wholesale ₦$wholesale_price, selling ₦$selling_price for $provider_name");

        respond(true, "Pricing updated. Selling price: ₦" . number_format($selling_price, 2));
        break;

    // ----------------------------------------------------------
    // LIST WITHDRAWALS — fetch withdrawal requests for review
    // ----------------------------------------------------------
    case 'list_withdrawals':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'withdrawals')) {
            respond(false, "You don't have permission to review withdrawals.");
        }

        $status = clean($_GET['status'] ?? $body['status'] ?? 'pending');
        $allowed = ['pending', 'approved', 'rejected', 'paid', 'all'];
        if (!in_array($status, $allowed)) $status = 'pending';

        $sql = "
            SELECT w.id, w.user_id, w.amount, w.fee, w.total_debited,
                   w.bank_name, w.account_no, w.account_name, w.reference,
                   w.status, w.admin_note, w.created_at, w.reviewed_at,
                   u.full_name, u.email, u.phone
            FROM withdrawal_requests w
            JOIN users u ON u.id = w.user_id
        ";
        if ($status !== 'all') {
            $stmt = $pdo->prepare($sql . " WHERE w.status = ? ORDER BY w.created_at DESC");
            $stmt->execute([$status]);
        } else {
            $stmt = $pdo->query($sql . " ORDER BY w.created_at DESC");
        }
        $withdrawals = $stmt->fetchAll();

        respond(true, "Withdrawals fetched.", ["withdrawals" => $withdrawals]);
        break;

    // ----------------------------------------------------------
    // APPROVE WITHDRAWAL — mark as approved (you still need to send
    // the actual bank transfer yourself, or mark 'paid' once you have)
    // ----------------------------------------------------------
    case 'approve_withdrawal':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'withdrawals')) {
            respond(false, "You don't have permission to approve withdrawals.");
        }

        $wid = (int)($body['withdrawal_id'] ?? 0);
        if (!$wid) respond(false, "Withdrawal ID is required.");

        $stmt = $pdo->prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending' LIMIT 1");
        $stmt->execute([$wid]);
        $w = $stmt->fetch();
        if (!$w) respond(false, "Withdrawal not found or already reviewed.");

        $pdo->prepare("
            UPDATE withdrawal_requests
            SET status='approved', reviewed_by=?, reviewed_at=NOW()
            WHERE id=?
        ")->execute([$admin['user_id'], $wid]);

        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Withdrawal Approved ✅', ?, 'withdrawal', NOW())
        ")->execute([$w['user_id'], "Your withdrawal of ₦" . number_format($w['amount'],2) . " to {$w['bank_name']} has been approved and is being processed."]);

        logAdminAction($pdo, $admin['user_id'], 'approve_withdrawal', 'withdrawal', $wid,
            "₦{$w['amount']} to {$w['bank_name']} {$w['account_no']}");

        respond(true, "Withdrawal approved. Remember to actually send the bank transfer, then mark it as Paid once sent.");
        break;

    // ----------------------------------------------------------
    // MARK PAID — confirm you've actually sent the money
    // ----------------------------------------------------------
    case 'mark_withdrawal_paid':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'withdrawals')) {
            respond(false, "You don't have permission to manage withdrawals.");
        }

        $wid = (int)($body['withdrawal_id'] ?? 0);
        if (!$wid) respond(false, "Withdrawal ID is required.");

        $stmt = $pdo->prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'approved' LIMIT 1");
        $stmt->execute([$wid]);
        $w = $stmt->fetch();
        if (!$w) respond(false, "Withdrawal not found or not yet approved.");

        $pdo->prepare("UPDATE withdrawal_requests SET status='paid' WHERE id=?")->execute([$wid]);

        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Withdrawal Sent 💸', ?, 'withdrawal', NOW())
        ")->execute([$w['user_id'], "₦" . number_format($w['amount'],2) . " has been sent to your {$w['bank_name']} account ({$w['account_no']})."]);

        logAdminAction($pdo, $admin['user_id'], 'mark_withdrawal_paid', 'withdrawal', $wid);

        respond(true, "Withdrawal marked as paid.");
        break;

    // ----------------------------------------------------------
    // REJECT WITHDRAWAL — refund the held funds back to the wallet
    // ----------------------------------------------------------
    case 'reject_withdrawal':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'withdrawals')) {
            respond(false, "You don't have permission to reject withdrawals.");
        }

        $wid    = (int)($body['withdrawal_id'] ?? 0);
        $reason = clean($body['reason'] ?? 'Could not verify account details.');
        if (!$wid) respond(false, "Withdrawal ID is required.");

        $stmt = $pdo->prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending' LIMIT 1");
        $stmt->execute([$wid]);
        $w = $stmt->fetch();
        if (!$w) respond(false, "Withdrawal not found or already reviewed.");

        $pdo->prepare("
            UPDATE withdrawal_requests
            SET status='rejected', admin_note=?, reviewed_by=?, reviewed_at=NOW()
            WHERE id=?
        ")->execute([$reason, $admin['user_id'], $wid]);

        // Refund the held funds back to the wallet
        $pdo->prepare("UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=?")
            ->execute([$w['total_debited'], $w['user_id']]);

        $pdo->prepare("
            INSERT INTO transactions (user_id, type, category, amount, description, reference, created_at)
            VALUES (?, 'credit', 'refund', ?, ?, ?, NOW())
        ")->execute([$w['user_id'], $w['total_debited'], "Withdrawal rejected — funds returned: $reason", $w['reference']]);

        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Withdrawal Rejected ❌', ?, 'withdrawal', NOW())
        ")->execute([$w['user_id'], "Your withdrawal request was rejected: $reason Your funds have been returned to your wallet."]);

        logAdminAction($pdo, $admin['user_id'], 'reject_withdrawal', 'withdrawal', $wid, $reason);

        respond(true, "Withdrawal rejected and funds returned to the user's wallet.");
        break;

    // ----------------------------------------------------------
    // GET FEES — fetch all platform fee settings
    // ----------------------------------------------------------
    case 'get_fees':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'fees')) {
            respond(false, "You don't have permission to manage fees.");
        }

        $stmt = $pdo->query("SELECT name, value FROM settings ORDER BY name");
        $rows = $stmt->fetchAll();
        $fees = [];
        foreach ($rows as $r) $fees[$r['name']] = $r['value'];

        respond(true, "Fees fetched.", ["fees" => $fees]);
        break;

    // ----------------------------------------------------------
    // UPDATE FEE — change a single fee setting
    // ----------------------------------------------------------
    case 'update_fee':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'fees')) {
            respond(false, "You don't have permission to manage fees.");
        }

        $name  = clean($body['name']  ?? '');
        $value = clean($body['value'] ?? '');

        if (empty($name)) respond(false, "Fee name is required.");

        // Only allow known settings to be changed (prevent SQL injection via name)
        $allowed = [
            'withdrawal_fee', 'transfer_fee', 'kyc_fee',
            'escrow_fee_small', 'escrow_fee_medium', 'escrow_fee_large', 'escrow_fee_xl',
            'boost_fee_basic', 'boost_fee_standard', 'boost_fee_premium',
            'referral_reward', 'cashback_rate', 'auto_release_hours'
        ];
        if (!in_array($name, $allowed)) respond(false, "Unknown fee setting: $name");

        $pdo->prepare("UPDATE settings SET value = ? WHERE name = ?")
            ->execute([$value, $name]);

        logAdminAction($pdo, $admin['user_id'], 'update_fee', 'settings', $name,
            "Changed $name to $value");

        respond(true, "Fee updated successfully.");
        break;

    // ----------------------------------------------------------
    // USERS — list, suspend, unsuspend, view profile
    // ----------------------------------------------------------
    case 'list_users':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'users')) respond(false, "Permission denied.");

        $search = clean($body['search'] ?? $_GET['search'] ?? '');
        $role   = clean($body['role']   ?? $_GET['role']   ?? '');
        $page   = max(1, (int)($body['page'] ?? $_GET['page'] ?? 1));
        $limit  = 20;
        $offset = ($page - 1) * $limit;

        $where = [];
        $params = [];
        if ($search) {
            $where[] = "(full_name LIKE ? OR email LIKE ? OR phone LIKE ?)";
            $params[] = "%$search%"; $params[] = "%$search%"; $params[] = "%$search%";
        }
        if ($role) { $where[] = "role = ?"; $params[] = $role; }
        $whereSQL = $where ? 'WHERE ' . implode(' AND ', $where) : '';

        $total_stmt = $pdo->prepare("SELECT COUNT(*) FROM users $whereSQL");
        $total_stmt->execute($params);
        $total = (int)$total_stmt->fetchColumn();

        $stmt = $pdo->prepare("
            SELECT id, full_name, email, phone, role, kyc_status, vendor_tier,
                   wallet_balance, is_suspended, created_at, last_login
            FROM users $whereSQL ORDER BY created_at DESC LIMIT $limit OFFSET $offset
        ");
        $stmt->execute($params);
        $users = $stmt->fetchAll();

        respond(true, "Users fetched.", [
            "users" => $users,
            "total" => $total,
            "page"  => $page,
            "pages" => ceil($total / $limit),
        ]);
        break;

    case 'suspend_user':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'users')) respond(false, "Permission denied.");

        $uid    = (int)($body['user_id'] ?? 0);
        $reason = clean($body['reason'] ?? 'Violation of platform terms.');
        if (!$uid) respond(false, "User ID required.");

        $pdo->prepare("UPDATE users SET is_suspended = 1 WHERE id = ?")->execute([$uid]);
        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Account Suspended 🚫', ?, 'system', NOW())
        ")->execute([$uid, "Your account has been suspended: $reason. Contact help@ememart.com to appeal."]);

        logAdminAction($pdo, $admin['user_id'], 'suspend_user', 'user', $uid, $reason);
        respond(true, "User suspended.");
        break;

    case 'unsuspend_user':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'users')) respond(false, "Permission denied.");

        $uid = (int)($body['user_id'] ?? 0);
        if (!$uid) respond(false, "User ID required.");

        $pdo->prepare("UPDATE users SET is_suspended = 0 WHERE id = ?")->execute([$uid]);
        $pdo->prepare("
            INSERT INTO notifications (user_id, title, message, type, created_at)
            VALUES (?, 'Account Reinstated ✅', 'Your account has been reinstated. Welcome back!', 'system', NOW())
        ")->execute([$uid]);

        logAdminAction($pdo, $admin['user_id'], 'unsuspend_user', 'user', $uid);
        respond(true, "User unsuspended.");
        break;

    // ----------------------------------------------------------
    // POSTS — list, delete, clear reports
    // ----------------------------------------------------------
    case 'list_posts':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'posts')) respond(false, "Permission denied.");

        $search = clean($body['search'] ?? $_GET['search'] ?? '');
        $page   = max(1, (int)($body['page'] ?? $_GET['page'] ?? 1));
        $limit  = 20;
        $offset = ($page - 1) * $limit;

        $where  = $search ? "WHERE p.caption LIKE ? OR u.full_name LIKE ?" : '';
        $params = $search ? ["%$search%", "%$search%"] : [];

        $total_stmt = $pdo->prepare("SELECT COUNT(*) FROM posts p JOIN users u ON u.id = p.author_id $where");
        $total_stmt->execute($params);
        $total = (int)$total_stmt->fetchColumn();

        $stmt = $pdo->prepare("
            SELECT p.id, p.caption, p.author_id, p.author_role, p.status,
                   p.is_food, p.escrow_enabled, p.created_at,
                   u.full_name as author_name, u.is_suspended as author_suspended
            FROM posts p JOIN users u ON u.id = p.author_id
            $where ORDER BY p.created_at DESC LIMIT $limit OFFSET $offset
        ");
        $stmt->execute($params);
        $posts = $stmt->fetchAll();

        respond(true, "Posts fetched.", [
            "posts" => $posts, "total" => $total,
            "page" => $page, "pages" => ceil($total / $limit),
        ]);
        break;

    case 'delete_post':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'posts')) respond(false, "Permission denied.");

        $pid = clean($body['post_id'] ?? '');
        if (!$pid) respond(false, "Post ID required.");

        $pdo->prepare("UPDATE posts SET status = 'deleted' WHERE id = ?")->execute([$pid]);
        logAdminAction($pdo, $admin['user_id'], 'delete_post', 'post', $pid);
        respond(true, "Post deleted.");
        break;

    // ----------------------------------------------------------
    // DISPUTES — list, resolve
    // ----------------------------------------------------------
    case 'list_disputes':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'disputes')) respond(false, "Permission denied.");

        $status = clean($body['status'] ?? $_GET['status'] ?? 'open');
        $where  = $status !== 'all' ? "WHERE d.status = ?" : '';
        $params = $status !== 'all' ? [$status] : [];

        $stmt = $pdo->prepare("
            SELECT d.id, d.order_id, d.reason, d.description, d.status,
                   d.resolution, d.created_at,
                   u1.full_name as raised_by_name, u1.email as raised_by_email,
                   u2.full_name as against_name
            FROM disputes d
            JOIN users u1 ON u1.id = d.raised_by
            JOIN users u2 ON u2.id = d.against
            $where ORDER BY d.created_at DESC
        ");
        $stmt->execute($params);
        $disputes = $stmt->fetchAll();

        respond(true, "Disputes fetched.", ["disputes" => $disputes]);
        break;

    case 'resolve_dispute':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'disputes')) respond(false, "Permission denied.");

        $did        = (int)($body['dispute_id'] ?? 0);
        $resolution = clean($body['resolution'] ?? '');
        $winner     = clean($body['winner'] ?? ''); // 'buyer' or 'seller'
        if (!$did || !$resolution) respond(false, "Dispute ID and resolution are required.");

        $pdo->prepare("
            UPDATE disputes SET status='resolved', resolution=?, resolved_by=?, resolved_at=NOW()
            WHERE id=?
        ")->execute([$resolution, $admin['user_id'], $did]);

        logAdminAction($pdo, $admin['user_id'], 'resolve_dispute', 'dispute', $did, "Winner: $winner — $resolution");
        respond(true, "Dispute resolved.");
        break;

    // ----------------------------------------------------------
    // ORDERS — list, view details
    // ----------------------------------------------------------
    case 'list_orders':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'orders')) respond(false, "Permission denied.");

        $status = clean($body['status'] ?? $_GET['status'] ?? 'all');
        $page   = max(1, (int)($body['page'] ?? $_GET['page'] ?? 1));
        $limit  = 20;
        $offset = ($page - 1) * $limit;

        $where  = $status !== 'all' ? "WHERE o.status = ?" : '';
        $params = $status !== 'all' ? [$status] : [];

        $total_stmt = $pdo->prepare("SELECT COUNT(*) FROM orders o $where");
        $total_stmt->execute($params);
        $total = (int)$total_stmt->fetchColumn();

        $stmt = $pdo->prepare("
            SELECT o.id, o.post_id, o.amount, o.status, o.escrow_status,
                   o.created_at, o.updated_at,
                   u1.full_name as buyer_name, u1.email as buyer_email,
                   u2.full_name as seller_name, u2.email as seller_email
            FROM orders o
            JOIN users u1 ON u1.id = o.buyer_id
            JOIN users u2 ON u2.id = o.seller_id
            $where ORDER BY o.created_at DESC LIMIT $limit OFFSET $offset
        ");
        $stmt->execute($params);
        $orders = $stmt->fetchAll();

        respond(true, "Orders fetched.", [
            "orders" => $orders, "total" => $total,
            "page" => $page, "pages" => ceil($total / $limit),
        ]);
        break;

    case 'logout':
        $admin_id = (int)($_SESSION['admin_id'] ?? 0);
        if ($admin_id) logAdminAction($pdo, $admin_id, 'logout');
        unset($_SESSION['admin_id']);
        respond(true, "Logged out successfully.");
        break;

    // ----------------------------------------------------------
    // ME — fetch current admin's role/permissions (for page reloads)
    // ----------------------------------------------------------
    case 'me':
        $admin = getAdminContext($pdo);
        if (!$admin) respond(false, "Not logged in.");
        respond(true, "Admin context fetched.", [
            "admin" => [
                "id"          => (int)$admin['user_id'],
                "full_name"   => $admin['full_name'],
                "email"       => $admin['email'],
                "role_name"   => $admin['role_name'],
                "role_label"  => $admin['role_label'],
                "permissions" => $admin['permissions'],
            ]
        ]);
        break;

    // ----------------------------------------------------------
    // LIST ROLES — fetch all available admin roles
    // ----------------------------------------------------------
    case 'list_roles':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'all')) respond(false, "Only super admins can manage roles.");

        $stmt = $pdo->query("SELECT id, name, label, permissions FROM admin_roles ORDER BY id");
        $roles = $stmt->fetchAll();
        foreach ($roles as &$r) $r['permissions'] = json_decode($r['permissions'], true);

        respond(true, "Roles fetched.", ["roles" => $roles]);
        break;

    // ----------------------------------------------------------
    // LIST STAFF — fetch all current admin staff members
    // ----------------------------------------------------------
    case 'list_staff':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'all')) respond(false, "Only super admins can manage staff.");

        $stmt = $pdo->query("
            SELECT s.id, s.is_active, s.created_at, u.id as user_id, u.full_name, u.email,
                   r.id as role_id, r.name as role_name, r.label as role_label
            FROM admin_staff s
            JOIN users u ON u.id = s.user_id
            JOIN admin_roles r ON r.id = s.role_id
            ORDER BY s.created_at DESC
        ");
        $staff = $stmt->fetchAll();

        respond(true, "Staff fetched.", ["staff" => $staff]);
        break;

    // ----------------------------------------------------------
    // ASSIGN ROLE — give an existing user admin access with a role
    // ----------------------------------------------------------
    case 'assign_role':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'all')) respond(false, "Only super admins can assign roles.");

        $target_email = clean($body['email']   ?? '');
        $role_id      = (int)($body['role_id'] ?? 0);

        if (empty($target_email) || !$role_id) {
            respond(false, "Email and role are required.");
        }

        // Find the target user
        $stmt = $pdo->prepare("SELECT id, full_name FROM users WHERE email = ? LIMIT 1");
        $stmt->execute([$target_email]);
        $target = $stmt->fetch();
        if (!$target) respond(false, "No user found with that email. They must register first.");

        // Confirm role exists
        $stmt = $pdo->prepare("SELECT label FROM admin_roles WHERE id = ? LIMIT 1");
        $stmt->execute([$role_id]);
        $role = $stmt->fetch();
        if (!$role) respond(false, "Invalid role selected.");

        // Check if already staff
        $stmt = $pdo->prepare("SELECT id FROM admin_staff WHERE user_id = ? LIMIT 1");
        $stmt->execute([$target['id']]);
        if ($stmt->fetch()) {
            // Update existing role instead
            $pdo->prepare("UPDATE admin_staff SET role_id = ?, is_active = 1 WHERE user_id = ?")
                ->execute([$role_id, $target['id']]);
        } else {
            $pdo->prepare("
                INSERT INTO admin_staff (user_id, role_id, added_by, is_active, created_at)
                VALUES (?, ?, ?, 1, NOW())
            ")->execute([$target['id'], $role_id, $admin['user_id']]);
        }

        logAdminAction($pdo, $admin['user_id'], 'assign_role', 'user', $target['id'], "Assigned role: {$role['label']}");

        respond(true, "{$target['full_name']} has been assigned the role: {$role['label']}.");
        break;

    // ----------------------------------------------------------
    // REVOKE ACCESS — remove a staff member's admin access
    // ----------------------------------------------------------
    case 'revoke_access':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'all')) respond(false, "Only super admins can revoke access.");

        $staff_id = (int)($body['staff_id'] ?? 0);
        if (!$staff_id) respond(false, "Staff ID is required.");

        $pdo->prepare("UPDATE admin_staff SET is_active = 0 WHERE id = ?")->execute([$staff_id]);

        logAdminAction($pdo, $admin['user_id'], 'revoke_access', 'staff', $staff_id);

        respond(true, "Admin access revoked.");
        break;

    // ----------------------------------------------------------
    // ACTIVITY LOG — view recent admin actions (super admin only)
    // ----------------------------------------------------------
    case 'activity_log':
        $admin = getAdminContext($pdo);
        if (!hasPermission($admin, 'all')) respond(false, "Only super admins can view the activity log.");

        $stmt = $pdo->query("
            SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.created_at,
                   u.full_name as admin_name
            FROM admin_activity_log l
            JOIN users u ON u.id = l.admin_id
            ORDER BY l.created_at DESC LIMIT 100
        ");
        $logs = $stmt->fetchAll();

        respond(true, "Activity log fetched.", ["logs" => $logs]);
        break;

    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
