// A "pool" is a small set of open database connections that get reused
// across requests, instead of opening/closing a new connection every
// time (which is slow). Every route in this app calls pool.query(...)
// through this same shared pool - see routes/*.js.
const { Pool } = require("pg");
const pgvector = require("pgvector/pg");

const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || "nexus",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
});

// registerTypes teaches node-postgres how to read Postgres's `vector`
// column type back out as a plain JS array of numbers - without this, a
// SELECT on an embedding column would come back as an unparsed string.
// It has to run on every new connection the pool opens (not just once),
// which is why this hooks the pool's "connect" event rather than calling
// it a single time up front. (You may see a one-time "deprecation
// warning" from node-postgres about concurrent queries on startup - it's
// this registration racing the very first real query on a fresh
// connection; harmless, and pg still queues/executes both correctly.)
pool.on("connect", async (client) => {
  try {
    await pgvector.registerTypes(client);
  } catch (err) {
    console.error("pgvector registerTypes failed:", err.message);
  }
});

module.exports = pool;
