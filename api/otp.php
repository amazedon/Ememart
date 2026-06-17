<?php
// api/otp.php
require_once 'config.php';

// Only allow POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(false, "Method not allowed");
}

// ============================================================
// GET & VALIDATE INPUT
// ============================================================
$body  = getBody();
$email = clean($body['email'] ?? '');
$name  = clean($body['name']  ?? 'Valued User');

if (empty($email)) {
    respond(false, "Email is required.");
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respond(false, "Invalid email address.");
}

// ============================================================
// RATE LIMITING — max 3 OTP requests per email per 10 minutes
// ============================================================
$stmt = $pdo->prepare("
    SELECT COUNT(*) as total FROM email_otps
    WHERE email = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
");
$stmt->execute([$email]);
$row = $stmt->fetch();
if ((int)$row['total'] >= 3) {
    respond(false, "Too many OTP requests. Please wait 10 minutes before trying again.");
}

// ============================================================
// CHECK IF EMAIL IS ALREADY REGISTERED
// ============================================================
$stmt = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
$stmt->execute([$email]);
if ($stmt->fetch()) {
    respond(false, "This email is already registered. Please sign in instead.");
}

// ============================================================
// DELETE OLD OTPs FOR THIS EMAIL
// ============================================================
$stmt = $pdo->prepare("DELETE FROM email_otps WHERE email = ?");
$stmt->execute([$email]);

// ============================================================
// GENERATE SECURE 6-DIGIT OTP
// ============================================================
$otp        = (string) random_int(100000, 999999);
$expires_at = date("Y-m-d H:i:s", strtotime("+10 minutes"));

// Store OTP in DB (hashed for security)
$otp_hash = password_hash($otp, PASSWORD_DEFAULT);
$stmt = $pdo->prepare("
    INSERT INTO email_otps (email, otp_code, expires_at, created_at)
    VALUES (?, ?, ?, NOW())
");
$stmt->execute([$email, $otp_hash, $expires_at]);

// ============================================================
// SEND EMAIL VIA HOSTINGER SMTP (PHPMailer)
// ============================================================
// If PHPMailer is not installed, falls back to PHP mail()
// To install PHPMailer: composer require phpmailer/phpmailer
// ============================================================

$sent = false;

if (file_exists(__DIR__ . '/vendor/autoload.php')) {
    // --- PHPMailer (recommended) ---
    require __DIR__ . '/vendor/autoload.php';

    $mail = new \PHPMailer\PHPMailer\PHPMailer(true);
    try {
        $mail->isSMTP();
        $mail->Host       = 'smtp.hostinger.com';
        $mail->SMTPAuth   = true;
        $mail->Username   = 'noreply@ememart.com';    // your Hostinger email
        $mail->Password   = 'Amarach50@';    // your Hostinger email password
        $mail->SMTPSecure = 'ssl';
        $mail->Port       = 465;

        $mail->setFrom('noreply@ememart.com', 'Ememart');
        $mail->addAddress($email, $name);
        $mail->isHTML(true);
        $mail->Subject = "$otp is your Ememart Verification Code";
        $mail->Body    = getEmailTemplate($otp, $name);

        $mail->send();
        $sent = true;
    } catch (\PHPMailer\PHPMailer\Exception $e) {
        // Fall through to mail() fallback
    }
}

if (!$sent) {
    // --- PHP mail() fallback ---
    $subject  = "$otp is your Ememart Verification Code";
    $headers  = "MIME-Version: 1.0\r\n";
    $headers .= "Content-type: text/html; charset=UTF-8\r\n";
    $headers .= "From: Ememart <noreply@ememart.com>\r\n";
    $sent = mail($email, $subject, getEmailTemplate($otp, $name), $headers);
}

if ($sent) {
    respond(true, "OTP verification email sent successfully.");
} else {
    respond(false, "Email delivery failed. Please try again.");
}

// ============================================================
// EMAIL TEMPLATE
// ============================================================
function getEmailTemplate($otp, $name) {
    return "
    <div style='font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;
                padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;'>
        <h2 style='color: #0d9488; text-align: center;'>Welcome to Ememart</h2>
        <p>Hello $name,</p>
        <p>Use the secure verification code below to complete your sign up:</p>
        <div style='text-align: center; margin: 30px 0;'>
            <span style='font-size: 32px; font-weight: bold; letter-spacing: 5px;
                         color: #111827; background-color: #f3f4f6;
                         padding: 10px 20px; border-radius: 4px;
                         border: 1px dashed #0d9488;'>
                $otp
            </span>
        </div>
        <p style='font-size: 12px; color: #6b7280; text-align: center;'>
            This code expires in <strong>10 minutes</strong>.<br>
            If you did not request this, ignore this email.
        </p>
        <hr style='border: none; border-top: 1px solid #e0e0e0; margin: 20px 0;'>
        <p style='font-size: 11px; color: #9ca3af; text-align: center;'>
            &copy; " . date('Y') . " Ememart Solutions &bull; Nnewi, Anambra State, Nigeria
        </p>
    </div>
    ";
}
?>
