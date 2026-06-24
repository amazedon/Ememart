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
