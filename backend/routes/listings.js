// Listings are the shared pool everyone matches against (unlike resumes/
// matches, which are private per user) - so this route requires login
// (via requireAuth) but doesn't filter by user_id at all.
const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { parseListingRow } = require("../lib/parseListing");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM listings ORDER BY scraped_at DESC");
  res.json(result.rows.map(parseListingRow));
}));

module.exports = router;
