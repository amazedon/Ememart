<?php
// api/register.php
require_once 'config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(["success" => false, "message" => "Method not allowed"]);
    exit;
}

$data = json_decode(file_get_contents("php://input"), true);

$full_name    = $data['full_name'] ?? '';
$email        = $data['email'] ?? '';
$password     = $data['password'] ?? '';
$role         = $data['role'] ?? 'user'; // user, vendor, artisan, rider
$phone_number = $data['phone_number'] ?? '';
$state        = $data['state'] ?? '';
$lga          = $data['lga'] ?? '';
$town         = $data['town'] ?? '';
$otp_code     = $data['otp_code'] ?? '';

// Check inputs
if (empty($full_name) || empty($email) || empty($password) || empty($state) || empty($lga) || empty($town) || empty($otp_code)) {
    echo json_encode(["success" => false, "message" => "All required fields must be filled."]);
    exit;
}

try {
    // 1. Verify OTP code against database record
    $stmt = $pdo->prepare("SELECT * FROM email_otps WHERE email = ? AND otp_code = ? AND is_used = 0 AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1");
    $stmt->execute([$email, $otp_code]);
    $otpRecord = $stmt->fetch();

    if (!$otpRecord) {
        echo json_encode(["success" => false, "message" => "Invalid or expired verification code."]);
        exit;
    }

    // 2. Check if email is already taken
    $stmt = $pdo->prepare("SELECT id FROM users WHERE email = ?");
    $stmt->execute([$email]);
    if ($stmt->fetch()) {
        echo json_encode(["success" => false, "message" => "This email is already registered."]);
        exit;
    }

    // 3. Securely hash the user's password
    $password_hash = password_hash($password, PASSWORD_BCRYPT);

    // 4. Save User Profile to the database
    $stmt = $pdo->prepare("INSERT INTO users (full_name, email, password_hash, role, phone_number, state, lga, town, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)");
    $stmt->execute([$full_name, $email, $password_hash, $role, $phone_number, $state, $lga, $town]);
    
    // Get the newly created User ID
    $newUserId = $pdo->lastInsertId();

    // 5. Automatically create their empty market wallet account
    $stmt = $pdo->prepare("INSERT INTO wallets (user_id, balance) VALUES (?, 0.00)");
    $stmt->execute([$newUserId]);

    // 6. Mark OTP code as used
    $stmt = $pdo->prepare("UPDATE email_otps SET is_used = 1 WHERE id = ?");
    $stmt->execute([$otpRecord['id']]);

    echo json_encode(["success" => true, "message" => "Account and wallet deployed successfully!"]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "message" => "Server error: " . $e->getMessage()]);
}
?>
