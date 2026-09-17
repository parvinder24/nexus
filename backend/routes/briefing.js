// ASYNC JOB + POLLING PATTERN (concept E from your list), demonstrated
// here with LLM script-writing standing in for what a real video/TTS API
// job would look like:
//
//   POST /start  -> INSERT a row with status='processing', return its id
//                    IMMEDIATELY (don't make the browser wait for the
//                    LLM call to finish)
//   (in the background, not awaited by the request) -> call the LLM,
//                    then UPDATE that row to 'completed' (with the
//                    script) or 'failed' (with an error)
//   GET /:id     -> the frontend calls this repeatedly ("polling") until
//                    status is no longer 'processing'
//
// This is the exact shape the spec asks for if video generation were
// added (job id -> poll status -> processing/completed/failed) - a real
// video/TTS API (HeyGen, ElevenLabs) would slot into the same
// generateBriefing() function below in place of the LLM call, writing a
// video URL into `script`'s place instead of text. We stopped short of
// that integration since it needs a paid API this project can't hold a
// key for and can't test - but the async-job architecture is the same
// either way, which is the part actually worth understanding.
const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../lib/asyncHandler");

const router = express.Router();

function offlineScript(matches) {
  // No API key: a templated script instead of an LLM-written one - same
  // "pipeline works without a key, gets better with one" pattern used
  // for extraction/agent/embeddings elsewhere in this project.
  const lines = matches.map(
    (m, i) => `Number ${i + 1}: ${m.title} at ${m.company}, a ${(m.score * 100).toFixed(0)} percent match.`
  );
  return (
    `Here's your briefing. You have ${matches.length} top ${matches.length === 1 ? "match" : "matches"} this week. ` +
    lines.join(" ") +
    " Good luck with your applications."
  );
}

async function llmScript(matches) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const matchList = matches.map((m) => `- ${m.title} at ${m.company} (${(m.score * 100).toFixed(0)}% match)`).join("\n");

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [{
      role: "user",
      content:
        `Write a spoken-style briefing script, 60-90 seconds when read aloud (about 150-220 words), ` +
        `summarizing these top job matches for the listener:\n${matchList}\n\n` +
        `Conversational tone, like a short personal update. No markdown, just the spoken text.`,
    }],
  });
  return response.content[0].text.trim();
}

// The "job": runs after the request has already responded (see /start
// below) - never awaited by a route handler, which is what makes this
// asynchronous rather than just a slow request.
async function generateBriefing(jobId, matches) {
  try {
    const script = process.env.ANTHROPIC_API_KEY ? await llmScript(matches) : offlineScript(matches);
    await pool.query(
      "UPDATE briefings SET status = 'completed', script = $1, completed_at = NOW() WHERE id = $2",
      [script, jobId]
    );
  } catch (err) {
    await pool.query(
      "UPDATE briefings SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2",
      [err.message, jobId]
    );
  }
}

router.post("/start", requireAuth, asyncHandler(async (req, res) => {
  const shortlistResult = await pool.query(
    `SELECT listings.title, listings.company, matches.score
     FROM matches JOIN listings ON listings.id = matches.listing_id
     WHERE matches.user_id = $1
     ORDER BY matches.score DESC
     LIMIT 3`,
    [req.userId]
  );
  if (shortlistResult.rows.length === 0) {
    return res.status(400).json({ error: "Shortlist at least one listing first." });
  }

  const jobResult = await pool.query(
    "INSERT INTO briefings (user_id, status) VALUES ($1, 'processing') RETURNING id",
    [req.userId]
  );
  const jobId = jobResult.rows[0].id;

  // Deliberately NOT awaited - the whole point of this route is to
  // return right away with a job id, while generateBriefing keeps
  // running after the response has already gone out.
  generateBriefing(jobId, shortlistResult.rows);

  res.json({ job_id: jobId, status: "processing" });
}));

router.get("/:id", requireAuth, asyncHandler(async (req, res) => {
  // "AND user_id = $2" - same ownership pattern as everywhere else in
  // this app: a briefing job that exists but belongs to someone else
  // returns 404, same as one that doesn't exist at all.
  const result = await pool.query(
    "SELECT id, status, script, error, created_at, completed_at FROM briefings WHERE id = $1 AND user_id = $2",
    [req.params.id, req.userId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Briefing job not found." });
  }
  res.json(result.rows[0]);
}));

module.exports = router;
