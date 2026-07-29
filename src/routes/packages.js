const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /packages — јавна листа на пакети
router.get('/', requireAuth, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM packages');
  res.json(rows);
});

module.exports = router;
