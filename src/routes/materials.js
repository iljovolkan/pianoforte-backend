const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Дозволени премини на статус (спречува "скокање" од queued директно во done итн.)
const ALLOWED_TRANSITIONS = {
  queued: ['delivered'],
  delivered: ['opened'],
  opened: ['done']
};

const ALLOWED_MIME = [
  'application/pdf',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'image/jpeg', 'image/png'
];

// Фајловите се чуваат директно во базата (LONGBLOB) — доволно за PDF ноти и
// кратки аудио снимки, без потреба од надворешен storage сервис (S3 и сл.)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB лимит по фајл
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Дозволени се само PDF, аудио (mp3/wav/m4a) и слики (jpg/png).'));
  }
});

// Проверува дали даденото дете (student_id) припаѓа на овоj родител (parent/student login)
async function isMyChild(parentId, childId) {
  const [[row]] = await pool.query('SELECT id FROM children WHERE id = ? AND parent_id = ?', [childId, parentId]);
  return !!row;
}

// POST /materials  multipart/form-data: student_id (= id на детето), title, type, note, file (опционално)
router.post('/', requireAuth, requireRole('professor', 'admin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { student_id, title, type, note } = req.body;
    if (!student_id || !title || !['note', 'audio', 'task'].includes(type)) {
      return res.status(400).json({ error: 'Невалидни податоци за материјал.' });
    }

    const file = req.file;
    try {
      const [result] = await pool.query(
        `INSERT INTO materials (student_id, sent_by, title, type, note, status, file_data, file_name, file_mimetype, file_size)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        [
          student_id, req.user.id, title, type, note || null,
          file ? file.buffer : null,
          file ? file.originalname : null,
          file ? file.mimetype : null,
          file ? file.size : null
        ]
      );
      res.status(201).json({ id: result.insertId, status: 'queued', has_file: !!file });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Грешка при зачувување на материјалот.' });
    }
  });
});

// GET /materials/:studentId — целиот дигитален индекс на детето
// Родител смее да гледа само материјали на СВОИ деца; professor/admin гледаат секаде.
// НЕ ja враќа file_data (тешко поле) — само дали постои фајл, за брзина.
router.get('/:studentId', requireAuth, async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (req.user.role === 'student' && !(await isMyChild(req.user.id, studentId))) {
    return res.status(403).json({ error: 'Немаш пристап до туѓ индекс.' });
  }

  const [rows] = await pool.query(
    `SELECT id, student_id, sent_by, title, type, note, status, sent_at, updated_at,
            file_name, file_mimetype, file_size,
            (file_data IS NOT NULL) AS has_file
     FROM materials WHERE student_id = ? ORDER BY sent_at DESC`,
    [studentId]
  );
  res.json(rows);
});

// GET /materials/:id/file — превземање/прикажување на прикачениот фајл
router.get('/:id/file', requireAuth, async (req, res) => {
  const [[material]] = await pool.query(
    'SELECT student_id, file_data, file_name, file_mimetype FROM materials WHERE id = ?',
    [req.params.id]
  );
  if (!material || !material.file_data) return res.status(404).json({ error: 'Нема прикачен фајл.' });

  if (req.user.role === 'student' && !(await isMyChild(req.user.id, material.student_id))) {
    return res.status(403).json({ error: 'Немаш пристап до овoj фајл.' });
  }

  res.setHeader('Content-Type', material.file_mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(material.file_name || 'file')}"`);
  res.send(material.file_data);
});

// PUT /materials/:id/status  { status }
router.put('/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const [[material]] = await pool.query('SELECT * FROM materials WHERE id = ?', [req.params.id]);
  if (!material) return res.status(404).json({ error: 'Материјалот не постои.' });

  if (req.user.role === 'student' && !(await isMyChild(req.user.id, material.student_id))) {
    return res.status(403).json({ error: 'Немаш пристап до овoj материјал.' });
  }

  const allowedNext = ALLOWED_TRANSITIONS[material.status] || [];
  if (!allowedNext.includes(status)) {
    return res.status(400).json({ error: `Не може да се премине од "${material.status}" во "${status}".` });
  }

  await pool.query('UPDATE materials SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ ok: true, status });
});

module.exports = router;
