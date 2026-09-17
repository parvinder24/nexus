-- Nexus database schema.
-- Run this once against a fresh "nexus" database:
--   psql -U postgres -d nexus -f schema.sql
--
-- Six tables. `listings` is shared (everyone matches against the same
-- scraped pool). `resumes`, `matches`, `chat_messages`, and `briefings`
-- are private per user - every query against them in the backend filters
-- by user_id taken from the verified JWT, never from anything the client
-- sends. That's the actual mechanism behind "user A can't see user B's
-- data" - see backend/routes/*.js for where that filtering happens.

-- pgvector adds a new column type ("vector") and comparison operators
-- (<=>, <->, <#>) to Postgres, for storing and comparing embedding
-- vectors directly in SQL. This is the ONLY new database concept this
-- project introduces beyond what you already know - everything else
-- below is plain tables, parameterized SQL, and constraints.
CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE IF EXISTS briefings;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS resumes;
DROP TABLE IF EXISTS listings;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE listings (
    id SERIAL PRIMARY KEY,

    -- provenance, required by the assignment on every scraped record
    source_url TEXT UNIQUE NOT NULL,   -- UNIQUE is what makes dedup a hard
                                        -- guarantee, not just app-level care -
                                        -- a second insert with the same URL
                                        -- fails loudly instead of duplicating.
    source_name TEXT NOT NULL,
    scraped_at TIMESTAMP DEFAULT NOW(),
    raw_text TEXT,                     -- original scraped text, kept for debugging/re-extraction

    -- filled in by the Python LLM-extraction step, NULL until then
    title TEXT,
    company TEXT,
    location TEXT,
    remote_ok BOOLEAN DEFAULT FALSE,
    stipend TEXT,
    required_skills TEXT,               -- JSON-encoded array string (e.g. '["python","sql"]'),
                                         -- not a Postgres array type - parsed with JSON.parse/json.loads,
                                         -- same JSON you already know from fetch()/JS objects
    experience_level TEXT,
    deadline TEXT,                     -- kept as free text; postings write dates too inconsistently to trust as a real DATE column

    extraction_cached BOOLEAN DEFAULT FALSE, -- true once LLM extraction has run once - the "never pay twice" cache

    -- 256 is the fixed length every embedding vector must have (chosen by
    -- us - see lib/embeddings.js / scraper/embed.py for why). Postgres
    -- enforces that length: inserting a vector of the wrong size errors.
    embedding vector(256),
    embedding_cached BOOLEAN DEFAULT FALSE   -- same caching idea as extraction_cached, one embedding call per listing ever
);

CREATE TABLE resumes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT,
    extracted_text TEXT,
    embedding vector(256),
    uploaded_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    score REAL,
    justification TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, listing_id)  -- a user can shortlist a given listing at most once
);

CREATE TABLE chat_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,     -- 'user' or 'assistant'
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- The async-job/polling pattern (concept E): starting a briefing INSERTs
-- a row with status='processing' and returns its id immediately - the
-- LLM script-writing call keeps running in the background. The frontend
-- polls GET /agent/briefing/:id until status flips to 'completed' (with
-- `script` filled in) or 'failed' (with `error` filled in). See
-- backend/routes/briefing.js.
CREATE TABLE briefings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'processing',  -- 'processing' | 'completed' | 'failed'
    script TEXT,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

CREATE INDEX idx_resumes_user_id ON resumes(user_id);
CREATE INDEX idx_matches_user_id ON matches(user_id);
CREATE INDEX idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX idx_briefings_user_id ON briefings(user_id);

-- No index on the embedding columns themselves (e.g. pgvector's ivfflat
-- index type) - deliberately, to keep the vector side of this project to
-- "the minimum SQL/code needed." A plain `ORDER BY embedding <=> $1
-- LIMIT 20` does a full scan, which is completely fine at this project's
-- scale (a few dozen listings) and doesn't need an index to be fast. An
-- ivfflat/hnsw index is the natural next step once the listing pool is
-- large enough that a full scan on every search actually gets slow.
