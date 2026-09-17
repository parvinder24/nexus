// "Middleware" = a function Express runs before your route handler, with
// the power to either call next() (continue to the route) or send a
// response itself and stop there (e.g. reject with 401). This one reads
// the "Authorization: Bearer <token>" header, checks the JWT's signature,
// and - if valid - attaches req.userId so every route downstream can
// trust it without re-checking auth itself.
//
// This is also *why* multi-tenancy holds: every route that reads/writes
// private data uses req.userId (from the verified token) to filter its
// SQL query - never an id read from the URL or request body. There's no
// "resume id" a client could tamper with to read someone else's resume,
// because the query is always "WHERE user_id = req.userId", full stop.
const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization; // e.g. "Bearer eyJhbGciOi..."
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or malformed Authorization header." });
  }

  const token = header.slice("Bearer ".length);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

module.exports = { requireAuth };
