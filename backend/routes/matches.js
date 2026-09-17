const express = require("express");
const pgvector = require("pgvector/pg");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { generateJustification } = require("../lib/justification");
const { parseListingRow } = require("../lib/parseListing");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

// Computed live against the caller's resume every time - nothing here is
// saved to the database until they explicitly shortlist a result with
// POST /save. Keeping this read-only/stateless means the listing pool can
// change (new scrape run) without needing to clean up any stale matches.
//
// Unlike the old TF-IDF version, there's no JS-side ranking loop here at
// all: pgvector's `<=>` operator computes cosine DISTANCE directly in
// SQL (0 = identical direction, 2 = opposite), so `1 - distance` is
// cosine SIMILARITY, and `ORDER BY embedding <=> $1` sorts the database
// by similarity to the resume's vector for us. The whole ranking step is
// one query.
router.get("/search", requireAuth, asyncHandler(async (req, res) => {
  const resumeResult = await pool.query(
    "SELECT extracted_text, embedding FROM resumes WHERE user_id = $1",
    [req.userId]
  );
  if (resumeResult.rows.length === 0) {
    return res.status(400).json({ error: "Upload a resume first." });
  }
  const resumeText = resumeResult.rows[0].extracted_text;
  const resumeEmbedding = resumeResult.rows[0].embedding; // already a plain JS array - see db.js's registerTypes

  const listingsResult = await pool.query(
    `SELECT *, 1 - (embedding <=> $1) AS score
     FROM listings
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1
     LIMIT 20`,
    [pgvector.toSql(resumeEmbedding)]
  );

  const results = [];
  for (const row of listingsResult.rows) {
    const listing = parseListingRow(row);
    const score = row.score;
    const justification = await generateJustification(resumeText, listing);
    results.push({ listing, score, justification });
  }
  res.json(results);
}));

router.post("/save", requireAuth, asyncHandler(async (req, res) => {
  const { listing_id } = req.body;
  const listingResult = await pool.query("SELECT * FROM listings WHERE id = $1", [listing_id]);
  if (listingResult.rows.length === 0) {
    return res.status(404).json({ error: "Listing not found." });
  }
  const listing = parseListingRow(listingResult.rows[0]);

  let score = 0;
  let justification = null;
  const resumeResult = await pool.query(
    "SELECT extracted_text, embedding FROM resumes WHERE user_id = $1",
    [req.userId]
  );
  if (resumeResult.rows.length > 0 && listingResult.rows[0].embedding) {
    const resumeText = resumeResult.rows[0].extracted_text;
    const resumeEmbedding = resumeResult.rows[0].embedding;
    const scoreResult = await pool.query(
      "SELECT 1 - (embedding <=> $1) AS score FROM listings WHERE id = $2",
      [pgvector.toSql(resumeEmbedding), listing_id]
    );
    score = scoreResult.rows[0].score;
    justification = await generateJustification(resumeText, listing);
  }

  // Same "check before insert" dedup pattern as the scraper's
  // upsert_listing (scraper/db.py) - look the pair up first, only insert
  // if it isn't already there. Re-saving an already-shortlisted listing
  // is then a harmless no-op instead of a duplicate row. The UNIQUE
  // constraint on (user_id, listing_id) in schema.sql is the backstop, in
  // case two requests race each other.
  const existingMatch = await pool.query(
    "SELECT id FROM matches WHERE user_id = $1 AND listing_id = $2",
    [req.userId, listing_id]
  );
  if (existingMatch.rows.length === 0) {
    await pool.query(
      "INSERT INTO matches (user_id, listing_id, score, justification) VALUES ($1, $2, $3, $4)",
      [req.userId, listing_id, score, justification]
    );
  }

  res.json({ listing_id, score, justification });
}));

router.get("/shortlist", requireAuth, asyncHandler(async (req, res) => {
  // The WHERE user_id = $1 here, using req.userId from the verified JWT,
  // is the entire reason user A can never see user B's shortlist.
  //
  // "matches.id AS match_id" matters: both `matches` and `listings` have
  // an `id` column, and `listings.*` would otherwise silently overwrite
  // matches.id in the result row - which would break DELETE
  // /shortlist/:id (it needs the MATCH's id, not the listing's).
  const result = await pool.query(
    `SELECT matches.id AS match_id, matches.score, matches.justification, listings.*
     FROM matches
     JOIN listings ON listings.id = matches.listing_id
     WHERE matches.user_id = $1
     ORDER BY matches.created_at DESC`,
    [req.userId]
  );
  res.json(result.rows.map(parseListingRow));
}));

router.delete("/shortlist/:id", requireAuth, asyncHandler(async (req, res) => {
  // "AND user_id = $2" is an ownership check, not just an existence
  // check - a match that exists but belongs to someone else returns the
  // same 404 as a match that doesn't exist at all, so a caller can't even
  // tell the difference.
  const result = await pool.query(
    "DELETE FROM matches WHERE id = $1 AND user_id = $2 RETURNING id",
    [req.params.id, req.userId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Match not found." });
  }
  res.json({ deleted: req.params.id });
}));

module.exports = router;
