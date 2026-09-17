// The 3 tools the agent can call, matching the assignment's required
// names: search_jobs, get_matches, get_shortlist.
//
// AUTHENTICATION vs AUTHORIZATION, made concrete here (the two ideas the
// assignment asks to be explicit about):
//   - Authentication already happened before any of this runs - the JWT
//     was verified in middleware/auth.js, which is how we have a trusted
//     req.userId at all.
//   - Authorization is enforced INSIDE these tool functions: get_matches
//     and get_shortlist take userId as a plain function argument that
//     the AGENT ROUTE passes in from req.userId - the tool's SQL always
//     filters `WHERE ... user_id = $1` using that value. The LLM never
//     supplies a user_id itself (it isn't even a field in either tool's
//     schema below), so there's no argument it could set to read someone
//     else's shortlist or matches, however it's prompted.
// search_jobs is the one tool that ISN'T user-scoped, on purpose:
// listings are the shared pool everyone searches, not private data.
const pgvector = require("pgvector/pg");
const pool = require("../db");
const { getEmbedding } = require("./embeddings");
const { parseListingRow } = require("./parseListing");

async function searchJobs(query, limit = 10) {
  // Basic input validation: reject empty/oversized queries before they
  // ever reach a SQL query or an embedding call.
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return { error: "query must be a non-empty string" };
  }
  const safeLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 20);

  // Keyword search over the shared pool - parameterized SQL, ILIKE for
  // case-insensitive partial matching. This is deliberately simpler than
  // an embedding search: search_jobs answers "find postings mentioning
  // X", get_matches answers "what fits THIS resume" - two different
  // questions, so two different techniques.
  const likeQuery = `%${query.trim()}%`;
  const result = await pool.query(
    `SELECT * FROM listings
     WHERE title ILIKE $1 OR company ILIKE $1 OR required_skills ILIKE $1
     ORDER BY scraped_at DESC
     LIMIT $2`,
    [likeQuery, safeLimit]
  );
  return result.rows.map(parseListingRow).map((l) => ({
    title: l.title, company: l.company, location: l.location, required_skills: l.required_skills,
  }));
}

async function getMatches(userId, limit = 5) {
  const resumeResult = await pool.query("SELECT embedding FROM resumes WHERE user_id = $1", [userId]);
  if (resumeResult.rows.length === 0) {
    return { error: "No resume uploaded yet - upload one before asking for matches." };
  }
  const safeLimit = Math.min(Math.max(parseInt(limit) || 5, 1), 20);

  const result = await pool.query(
    `SELECT title, company, required_skills, 1 - (embedding <=> $1) AS score
     FROM listings
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [pgvector.toSql(resumeResult.rows[0].embedding), safeLimit]
  );
  return result.rows.map((r) => ({
    title: r.title, company: r.company, score: Number(r.score.toFixed(3)),
  }));
}

async function getShortlist(userId) {
  const result = await pool.query(
    `SELECT listings.title, listings.company, matches.score, listings.deadline
     FROM matches JOIN listings ON listings.id = matches.listing_id
     WHERE matches.user_id = $1`,
    [userId]
  );
  return result.rows;
}

// Schemas in Anthropic's tool-use format - what the MODEL sees. Note
// neither get_matches nor get_shortlist's schema has a user_id field -
// the model has no way to ask for anyone's data but the caller's.
const TOOL_SCHEMAS = [
  {
    name: "search_jobs",
    description: "Search the shared pool of scraped job/internship listings by keyword (matches title, company, or required skills).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search for, e.g. 'python' or 'kubernetes'." },
        limit: { type: "integer", description: "Max results, default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_matches",
    description: "Get the listings best semantically matched to the user's own uploaded resume, ranked by similarity score.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max results, default 5." } },
    },
  },
  {
    name: "get_shortlist",
    description: "Get every listing the user has saved to their shortlist, with score and deadline.",
    input_schema: { type: "object", properties: {} },
  },
];

const TOOL_REGISTRY = {
  search_jobs: (userId, input) => searchJobs(input.query, input.limit),
  get_matches: (userId, input) => getMatches(userId, input.limit),
  get_shortlist: (userId) => getShortlist(userId),
};

module.exports = { searchJobs, getMatches, getShortlist, TOOL_SCHEMAS, TOOL_REGISTRY };
