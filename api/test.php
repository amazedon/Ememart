<?php
// db_test.php — TEMPORARY DIAGNOSTIC FILE
// Upload this to /api/db_test.php, visit it in your browser ONCE,
// read the result, then DELETE this file immediately afterward.

header("Content-Type: application/json");

define('DB_HOST', 'localhost');
define('DB_USER', 'ememartt');
define('DB_PASS', 'Ememart2024!!');
define('DB_NAME', 'ememartt');

try {
    $pdo = new PDO(
        "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
        DB_USER,
        DB_PASS
    );
    
    // Check tables exist
    $stmt = $pdo->query("SHOW TABLES");
    $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);
    
    echo json_encode([
        "success" => true,
        "message" => "Database connected successfully!",
        "table_count" => count($tables),
        "tables" => $tables
    ], JSON_PRETTY_PRINT);

} catch (PDOException $e) {
    echo json_encode([
        "success" => false,
        "real_error" => $e->getMessage(),
        "error_code" => $e->getCode()
    ], JSON_PRETTY_PRINT);
}
?>
