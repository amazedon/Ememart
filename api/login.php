<?php
// api/login.php
require_once 'config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(["success" => false, "message" => "Method not allowed"]);
    exit;
}

$data = json_decode(file_get_contents("php://input"), true);
$email = $data['email'] ?? '';
$password = $data['password'] ?? '';

if (empty($email) || empty($password)) {
    echo json_encode(["success" => false, "message" => "Missing login credential criteria."]);
    exit;
}

try {
    // Look up the matching identity profile
    $stmt = $pdo->prepare("SELECT * FROM users WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user) {
        echo json_encode(["success" => false, "message" => "Authentication failure: Credentials mismatch."]);
        exit;
    }

    // Block access if the user is suspended
    if ((int)$user['is_suspended'] === 1) {
        echo json_encode(["success" => false, "message" => "Access denied. Account is temporarily suspended by admin."]);
        exit;
    }

    // Verify hashed passphrase match
    if (!password_verify($password, $user['password_hash'])) {
        echo json_encode(["success" => false, "message" => "Authentication failure: Credentials mismatch."]);
        exit;
    }

    // Return profile data to synchronize your local state metrics safely
    echo json_encode([
        "success" => true,
        "message" => "Authenticated successfully.",
        "user" => [
            "id" => (int)$user['id'],
            "full_name" => $user['full_name'],
            "email" => $user['email'],
            "role" => $user['role'],
            "state" => $user['state'],
            "lga" => $user['lga'],
            "town" => $user['town']
        ]
    ]);
} catch (Exception $e) {
    echo json_encode(["success" => false, "message" => "Authentication exception execution error."]);
}
?>
