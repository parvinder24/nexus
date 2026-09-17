// multer handles multipart/form-data file uploads (the format a browser
// uses to send a file). memoryStorage() means the uploaded file bytes
// land in req.file.buffer instead of being written to disk - fine here
// since we only need the bytes momentarily, to extract their text.
const express = require("express");
const multer = require("multer");
const pgvector = require("pgvector/pg");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { extractTextFromPDF } = require("../lib/pdfExtract");
const { getEmbedding } = require("../lib/embeddings");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB - file size validation (security requirement)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

router.post("/upload", requireAuth, (req, res, next) => {
  // multer's own errors (e.g. file too big) happen INSIDE upload.single()
  // before our route body ever runs, so they need their own try/catch
  // here rather than relying on asyncHandler/the global error middleware -
  // otherwise a too-large file would produce a raw 500 instead of a clean
  // "file too large" message.
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `File too large - max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.` });
    }
    if (err) return next(err);
    next();
  });
}, asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }
  // File TYPE validation - reject anything that isn't actually a PDF
  // before we try to parse it as one.
  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "Please upload a PDF." });
  }

  let text;
  try {
    text = await extractTextFromPDF(req.file.buffer);
  } catch (err) {
    return res.status(400).json({ error: "Could not read this PDF." });
  }
  if (!text) {
    return res.status(400).json({ error: "No text found in this PDF (it may be a scanned image)." });
  }

  // The resume's embedding vector - same idea, same code (lib/embeddings.js)
  // as the scraper uses for listings, so the two vectors are comparable.
  // This is the ONE call per upload, not recomputed on every search - it's
  // stored below and reused every time this user runs a match search.
  const embedding = await getEmbedding(text);

  // One resume per user: replace the existing row instead of piling up
  // rows, since matching always uses "the" current resume for req.userId.
  const existing = await pool.query("SELECT id FROM resumes WHERE user_id = $1", [req.userId]);
  if (existing.rows.length > 0) {
    await pool.query(
      "UPDATE resumes SET filename = $1, extracted_text = $2, embedding = $3, uploaded_at = NOW() WHERE user_id = $4",
      [req.file.originalname, text, pgvector.toSql(embedding), req.userId]
    );
  } else {
    await pool.query(
      "INSERT INTO resumes (user_id, filename, extracted_text, embedding) VALUES ($1, $2, $3, $4)",
      [req.userId, req.file.originalname, text, pgvector.toSql(embedding)]
    );
  }

  res.json({ filename: req.file.originalname, chars_extracted: text.length });
}));

router.get("/me", requireAuth, asyncHandler(async (req, res) => {
  // Filtered by req.userId (from the verified JWT) - not by any id the
  // client could supply - so there's no way to ask for someone else's
  // resume by guessing/editing an id.
  const result = await pool.query(
    "SELECT id, filename, uploaded_at FROM resumes WHERE user_id = $1",
    [req.userId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "No resume uploaded yet." });
  }
  res.json(result.rows[0]);
}));

module.exports = router;
