<?php
// ============================================================
// EMEMART — test.php
// Upload to public_html/api/test.php
// Visit: https://www.ememart.com/api/test.php
// DELETE this file after testing
// ============================================================

header('Content-Type: application/json');

$results = [];

// Test 1: PHP version
$results['php_version'] = PHP_VERSION;
$results['php_ok'] = version_compare(PHP_VERSION, '7.4', '>=');

// Test 2: Database connection
try {
    $pdo = new PDO(
        'mysql:host=localhost;dbname=u287672430_ememartt;charset=utf8mb4',
        'u287672430_ememartt',
        'Amarach50',
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    $results['db_connection'] = 'SUCCESS';

    // Test 3: Count tables
    $stmt = $pdo->query("SHOW TABLES");
    $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);
    $results['tables_found'] = count($tables);
    $results['tables'] = $tables;

} catch (PDOException $e) {
    $results['db_connection'] = 'FAILED';
    $results['db_error'] = $e->getMessage();
}

// Test 4: PHPMailer installed?
$results['phpmailer_installed'] = file_exists(__DIR__ . '/vendor/autoload.php');

// Test 5: Composer vendor folder exists?
$results['vendor_folder'] = is_dir(__DIR__ . '/vendor');

echo json_encode($results, JSON_PRETTY_PRINT);
