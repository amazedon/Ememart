<?php
// api/otp.php
require_once 'config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(["success" => false, "message" => "Method not allowed"]);
    exit;
}

// Get the request data (Email & Name)
$data = json_decode(file_get_contents("php://input"), true);
$email = $data['email'] ?? '';
$name = $data['name'] ?? 'Valued User';

if (empty($email)) {
    echo json_encode(["success" => false, "message" => "Email is required."]);
    exit;
}

try {
    // Generate 6-digit OTP
    $otp = (string)rand(100000, 999999);
    
    // Set expiry time (10 minutes from now)
    $expires_at = date("Y-m-d H:i:s", strtotime("+10 minutes"));

    // Save OTP to your database table
    $stmt = $pdo->prepare("INSERT INTO email_otps (email, otp_code, expires_at) VALUES (?, ?, ?)");
    $stmt->execute([$email, $otp, $expires_at]);

    // Send Email via Hostinger Server Mailer
    $to = $email;
    $subject = "$otp is your Ememart Verification Code";
    
    // Email Template Layout
    $message = "
    <div style='font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;'>
        <h2 style='color: #0d9488; text-align: center;'>Welcome to Ememart</h2>
        <p>Hello $name,</p>
        <p>Use the secure verification code below to complete your sign up:</p>
        <div style='text-align: center; margin: 30px 0;'>
            <span style='font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #111827; background-color: #f3f4f6; padding: 10px 20px; border-radius: 4px; border: 1px dashed #0d9488;'>
                $otp
            </span>
        </div>
        <p style='font-size: 12px; color: #6b7280; text-align: center;'>This code will expire in 10 minutes.</p>
    </div>
    ";

    // Headers to send HTML email from your business mail
    $headers = "MIME-Version: 1.0" . "\r\n";
    $headers .= "Content-type:text/html;charset=UTF-8" . "\r\n";
    $headers .= "From: Ememart <noreply@ememart.com>" . "\r\n";

    if (mail($to, $subject, $message, $headers)) {
        echo json_encode(["success" => true, "message" => "OTP verification email sent successfully."]);
    } else {
        echo json_encode(["success" => false, "message" => "Email delivery failed."]);
    }

} catch (Exception $e) {
    echo json_encode(["success" => false, "message" => "Server error: " . $e->getMessage()]);
}
?>
