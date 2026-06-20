<?php
// api/media.php
require_once 'config.php';
session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(false, "Method not allowed");
}

$user_id = (int)($_SESSION['user_id'] ?? 0);
if (!$user_id) {
    respond(false, "Unauthorised. Please sign in.");
}

// ============================================================
// CLOUDINARY CREDENTIALS
// ============================================================
// Cloudinary credentials now loaded from .env via config.php

// ============================================================
// HELPER: Upload a base64 image to Cloudinary
// ============================================================
function uploadToCloudinary($base64_data, $folder = 'ememart/posts') {
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
    $err      = curl_error($ch);
    curl_close($ch);

    if ($err) return null;
    return json_decode($response, true);
}

// ============================================================
// ROUTE
// ============================================================
$body   = getBody();
$action = clean($body['action'] ?? 'upload');

switch ($action) {

    // ----------------------------------------------------------
    // UPLOAD — single or multiple images (max 5)
    // ----------------------------------------------------------
    case 'upload':
        $images = $body['images'] ?? []; // array of base64 data URIs
        $folder = clean($body['folder'] ?? 'ememart/posts');

        if (empty($images) || !is_array($images)) {
            respond(false, "No images provided.");
        }

        if (count($images) > 5) {
            respond(false, "Maximum 5 images allowed per upload.");
        }

        $uploaded_urls = [];
        foreach ($images as $img) {
            if (empty($img) || strpos($img, 'data:image') !== 0) {
                continue; // skip invalid entries
            }

            $result = uploadToCloudinary($img, $folder);

            if ($result && isset($result['secure_url'])) {
                $uploaded_urls[] = [
                    "url"        => $result['secure_url'],
                    "public_id"  => $result['public_id'],
                    "width"      => $result['width']  ?? null,
                    "height"     => $result['height'] ?? null,
                ];
            }
        }

        if (empty($uploaded_urls)) {
            respond(false, "Image upload failed. Please try again.");
        }

        respond(true, "Images uploaded successfully.", [
            "images" => $uploaded_urls,
            "count"  => count($uploaded_urls),
        ]);
        break;

    // ----------------------------------------------------------
    // UPLOAD AVATAR — single profile photo
    // ----------------------------------------------------------
    case 'upload_avatar':
        $image = $body['image'] ?? '';

        if (empty($image) || strpos($image, 'data:image') !== 0) {
            respond(false, "Invalid image data.");
        }

        $result = uploadToCloudinary($image, 'ememart/avatars');

        if (!$result || !isset($result['secure_url'])) {
            respond(false, "Avatar upload failed. Please try again.");
        }

        // Save avatar URL to user profile
        $stmt = $pdo->prepare("UPDATE users SET avatar = ? WHERE id = ?");
        $stmt->execute([$result['secure_url'], $user_id]);

        respond(true, "Avatar updated successfully.", [
            "url" => $result['secure_url'],
        ]);
        break;

    // ----------------------------------------------------------
    // UPLOAD KYC DOCUMENT — ID card, selfie, utility bill
    // ----------------------------------------------------------
    case 'upload_kyc':
        $image = $body['image'] ?? '';
        $type  = clean($body['type'] ?? 'id'); // id | selfie | utility_bill

        if (empty($image) || strpos($image, 'data:image') !== 0) {
            respond(false, "Invalid image data.");
        }

        $allowed_types = ['id', 'selfie', 'utility_bill'];
        if (!in_array($type, $allowed_types)) {
            respond(false, "Invalid document type.");
        }

        $result = uploadToCloudinary($image, 'ememart/kyc');

        if (!$result || !isset($result['secure_url'])) {
            respond(false, "Document upload failed. Please try again.");
        }

        respond(true, "Document uploaded successfully.", [
            "url"  => $result['secure_url'],
            "type" => $type,
        ]);
        break;

    // ----------------------------------------------------------
    // DELETE — remove an image from Cloudinary
    // ----------------------------------------------------------
    case 'delete':
        $public_id = clean($body['public_id'] ?? '');
        if (empty($public_id)) respond(false, "public_id is required.");

        $timestamp = time();
        $params_to_sign = "public_id=$public_id&timestamp=$timestamp" . CLOUDINARY_API_SECRET;
        $signature = sha1($params_to_sign);

        $url = "https://api.cloudinary.com/v1_1/" . CLOUDINARY_CLOUD_NAME . "/image/destroy";
        $ch  = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => [
                'public_id' => $public_id,
                'api_key'   => CLOUDINARY_API_KEY,
                'timestamp' => $timestamp,
                'signature' => $signature,
            ],
        ]);
        $response = json_decode(curl_exec($ch), true);
        curl_close($ch);

        if (($response['result'] ?? '') === 'ok') {
            respond(true, "Image deleted successfully.");
        } else {
            respond(false, "Could not delete image.");
        }
        break;

    default:
        respond(false, "Unknown action: $action");
        break;
}
?>
