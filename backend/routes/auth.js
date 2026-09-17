// Signup: hash the password with bcrypt (never store plain text), insert
// a user row, hand back a signed JWT so the frontend is logged in
// immediately without a separate login step.
//
// Login: look up by email, compare the submitted password against the
// stored hash with bcrypt.compare (bcrypt re-hashes the input with the
// same salt and checks if it matches - you never "decrypt" a hash),
// hand back a JWT on success.
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();
const SALT_ROUNDS = 10; // how much work bcrypt does per hash - higher = slower to brute-force, also slower to compute

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

router.post("/signup", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "Email and an 8+ character password are required." });
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: "An account with this email already exists." });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
    [email, passwordHash]
  );
  const userId = result.rows[0].id;

  res.json({ token: makeToken(userId) });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT id, password_hash FROM users WHERE email = $1", [email]);

  if (result.rows.length === 0) {
    // Same error for "no such user" and "wrong password" - distinguishing
    // them would let an attacker enumerate which emails have accounts.
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const user = result.rows[0];
  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  res.json({ token: makeToken(user.id) });
}));

module.exports = router;
