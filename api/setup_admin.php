<?php
// setup_admin.php — TEMPORARY ONE-TIME SETUP SCRIPT
// Upload to /api/setup_admin.php, visit it ONCE in your browser
// to create your admin account, then DELETE this file immediately.

require_once 'config.php';

// ============================================================
// ⚠️ EDIT THESE THREE LINES WITH YOUR REAL DETAILS BEFORE UPLOADING
// ============================================================
$admin_name     = 'Charles Anigbogbu';
$admin_email    = 'admin@ememart.com';
$admin_password = 'ChangeThisPassword123!';
// ============================================================

header("Content-Type: application/json");

try {
    // Check if this admin email already exists
    $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
    $stmt->execute([$admin_email]);
    if ($stmt->fetch()) {
        echo json_encode(["success" => false, "message" => "An account with this email already exists."]);
        exit;
    }

    $hash = password_hash($admin_password, PASSWORD_BCRYPT);

    $stmt = $pdo->prepare("
        INSERT INTO users (
            full_name, email, password_hash, phone, role,
            state, lga, town, wallet_balance, kyc_status,
            vendor_tier, is_verified, is_suspended, created_at
        ) VALUES (
            ?, ?, ?, '08000000000', 'admin',
            'Anambra', 'Nnewi North', 'Nnewi',
            0.00, 'verified', 'free', 1, 0, NOW()
        )
    ");
    $stmt->execute([$admin_name, $admin_email, $hash]);

    $admin_id = $pdo->lastInsertId();

    echo json_encode([
        "success" => true,
        "message" => "Admin account created successfully!",
        "admin_id" => $admin_id,
        "email" => $admin_email,
        "next_step" => "DELETE this file from your server right now, then log in to /admin using this email and password."
    ], JSON_PRETTY_PRINT);

} catch (PDOException $e) {
    echo json_encode(["success" => false, "message" => "Database error: " . $e->getMessage()]);
}
?>
