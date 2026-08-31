const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /packages — сите пакети, опционално филтрирани по инструмент/тип
// ?instrument=piano&type=annual
// ЈАВНА рута (без најава) — цените се јавна информација, потребни за
// маркетинг преглед на пакети пред најава/регистрација.
router.get('/', async (req, res) => {
  const { instrument, type } = req.query;
  let query = 'SELECT * FROM packages WHERE 1=1';
  const params = [];
  if (instrument) { query += ' AND instrument = ?'; params.push(instrument); }
  if (type) { query += ' AND package_type = ?'; params.push(type); }
  query += ' ORDER BY FIELD(package_type, "trial","annual","individual"), price_mkd ASC';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

module.exports = router;

