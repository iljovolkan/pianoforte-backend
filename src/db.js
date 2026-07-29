const mysql = require('mysql2/promise');
require('dotenv').config();

// Railway (и повеќето cloud host-ови) даваат еден готов connection string
// (пр. MYSQL_URL или DATABASE_URL) наместо посебни DB_HOST/DB_USER полиња.
// Овде прифаќаме и двата формати — што и да е достапно, се користи.
const connectionString = process.env.MYSQL_URL || process.env.DATABASE_URL;

const pool = connectionString
  ? mysql.createPool(connectionString)
  : mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

module.exports = pool;
