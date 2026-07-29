const jwt = require('jsonwebtoken');

/**
 * Verifies the JWT from the Authorization header ("Bearer <token>").
 * On success attaches { id, role, email } to req.user.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Недостасува токен за автентикација.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Невалиден или истечен токен.' });
  }
}

/**
 * Factory: restricts a route to one or more roles.
 * Usage: requireRole('professor', 'admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Немаш пристап до овој ресурс.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
