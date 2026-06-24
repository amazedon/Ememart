<?php
// api/role_application.php
require_once 'config.php';
session_start();

$user_id = (int)($_SESSION['user_id'] ?? 0);
if (!$user_id) {
    respond(false, "Unauthorised. Please sign in.");
}

$body   = getBody();
$action = clean($body['action'] ?? 'submit');

switch ($action) {

    // ----------------------------------------------------------
    // SUBMIT — user applies to change their role
    // ----------------------------------------------------------
    case 'submit':
        $new_role  = clean($body['new_role'] ?? '');
        $biz_name  = clean($body['business_name'] ?? '');
        $reason    = clean($body['reason'] ?? '');

        $allowed_roles = ['vendor', 'rider', 'artisan'];
        if (!in_array($new_role, $allowed_roles)) {
            respond(false, "Invalid role selected.");
        }
        if (strlen($reason) < 10) {
            respond(false, "Please explain your reason (at least 10 characters).");
        }

        // Get current role
        $stmt = $pdo->prepare("SELECT role FROM users WHERE id = ? LIMIT 1");
        $stmt->execute([$user_id]);
        $user = $stmt->fetch();
        if (!$user) respond(false, "User not found.");

        if ($user['role'] === $new_role) {
            respond(false, "You already have this role.");
        }

        // Check for an existing pending application
        $stmt = $pdo->prepare("
            SELECT id FROM role_applications
            WHERE user_id = ? AND status = 'pending' LIMIT 1
        ");
        $stmt->execute([$user_id]);
        if ($stmt->fetch()) {
            respond(false, "You already have a pending application. Please wait for it to be reviewed.");
        }

        $stmt = $pdo->prepare("
            INSERT INTO role_applications (user_id, current_role, new_role, business_name, reason, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', NOW())
        ");
        $stmt->execute([$user_id, $user['role'], $new_role, $biz_name, $reason]);

        respond(true, "Application submitted. You'll be notified once it's reviewed.");
        break;

    // ----------------------------------------------------------
    // STATUS — check current application status for this user
    // ----------------------------------------------------------
    case 'status':
        $stmt = $pdo->prepare("
            SELECT id, new_role, status, admin_note, created_at
            FROM role_applications WHERE user_id = ?
            ORDER BY created_at DESC LIMIT 1
        ");
        $stmt->execute([$user_id]);
        $app = $stmt->fetch();

        respond(true, "Status fetched.", ["application" => $app ?: null]);
        break;

    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
