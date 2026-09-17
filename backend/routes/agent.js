const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { chat } = require("../lib/agent");

const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

router.post("/chat", requireAuth, asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message is required." });

  const { reply, toolsUsed } = await chat(req.userId, message);

  await pool.query("INSERT INTO chat_messages (user_id, role, content) VALUES ($1, 'user', $2)", [req.userId, message]);
  await pool.query("INSERT INTO chat_messages (user_id, role, content) VALUES ($1, 'assistant', $2)", [req.userId, reply]);

  res.json({ reply, tools_used: toolsUsed });
}));

router.get("/history", requireAuth, asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT role, content FROM chat_messages WHERE user_id = $1 ORDER BY created_at ASC",
    [req.userId]
  );
  res.json(result.rows);
}));

module.exports = router;
