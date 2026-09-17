# Nexus — Autonomous Career Intelligence Agent

Scrape job listings → structure them with an LLM → embed them → store in
Postgres with pgvector → match against a resume by cosine similarity →
let a tool-calling agent answer questions about your own data → generate
a spoken-style briefing script via an async job/polling pattern → all
behind real per-user auth. Built specifically on the stack and concepts
you already know or are actively learning - nothing here needed a new
framework you'd have to learn from scratch just to explain it.

**Video generation itself is not implemented** - see "Briefing" below for
exactly what is, and why the async-job architecture is the part that
actually mattered to build correctly.

## Why this stack

| Piece | Uses |
|---|---|
| Backend | Node.js + Express |
| Database | PostgreSQL + raw parameterized SQL + pgvector (the one new DB concept) |
| Scraper | Python + `requests` + BeautifulSoup |
| Auth | JWT + bcrypt, by hand |
| Semantic matching | Real embeddings (Voyage AI) or an offline hashing-trick fallback, compared with pgvector's `<=>` cosine-distance operator |
| Frontend | Plain HTML/CSS/JS + `fetch()` |
| Agent | Claude's tool-use API, 3 named tools (`search_jobs`, `get_matches`, `get_shortlist`) |
| Briefing | Async job + polling pattern, LLM-written script (or an offline templated one) |

Not introduced: React, an ORM, Docker, message queues, or any other
framework outside what you listed as known/willing-to-learn.

## Quickstart

**1. Database** (once):
```bash
createdb nexus
psql -U postgres -d nexus -f schema.sql   # also runs CREATE EXTENSION vector
```
(Needs the `pgvector` Postgres extension installed - `apt install postgresql-16-pgvector` on Debian/Ubuntu, or `brew install pgvector` on Mac, matching your Postgres major version.)

**2. Scraper:**
```bash
cd scraper
pip install -r requirements.txt
cp .env.example .env    # or export the vars directly
python run.py
```

**3. Backend:**
```bash
cd backend
npm install
cp .env.example .env    # fill in DB password, JWT_SECRET, etc.
node server.js
```

Open `http://127.0.0.1:3000`.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` | both | Postgres connection - same database for both halves |
| `JWT_SECRET` | backend | **Override before running anywhere but your own laptop**: `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | both | Set: real Claude calls for extraction, match justification, agent chat, and briefing scripts. Unset: all four fall back to offline logic - **the whole app runs and is demoable with zero keys.** |
| `VOYAGE_API_KEY` | both | Set: real semantic embeddings via Voyage AI (Anthropic's recommended embeddings partner). Unset: a deterministic offline "hashing trick" fallback (see `lib/embeddings.js`/`scraper/embed.py`) - fully testable, weaker at true semantic matching. |
| `SCRAPE_OFFLINE_MODE` | scraper | `true` (default) reads local fixtures instead of the real internet - this project was built in a sandbox that can't reach arbitrary sites. |

## Semantic matching - what changed from TF-IDF, and why

This project used to rank listings with hand-written TF-IDF + cosine
similarity. That's been replaced with real embeddings, per the
assignment. The conceptual difference, worth being able to say plainly:

- **TF-IDF**: a document's vector depends on the *whole corpus you're
  comparing it against* - recompute the corpus, the vectors shift. That's
  why the old version recomputed everything on every search.
- **An embedding**: each document gets a vector *on its own*, independent
  of anything else. A real embedding model (Voyage AI) was trained on
  huge amounts of text so that semantically similar text ends up with
  similar vectors even sharing zero words - "backend infra" and
  "distributed systems" can land close together. That's the actual reason
  embeddings beat keyword/TF-IDF matching.

Because each vector is independent, embeddings only need to be computed
**once per document, ever** (cached - `embedding_cached` on `listings`),
not recomputed per search. Matching itself becomes a single SQL query:

```sql
SELECT *, 1 - (embedding <=> $1) AS score
FROM listings
ORDER BY embedding <=> $1
LIMIT 20
```

pgvector's `<=>` operator computes cosine *distance* (0 = same direction,
2 = opposite); `1 - distance` is cosine *similarity* - same concept you
already knew from TF-IDF, just computed by Postgres directly on stored
vectors instead of by a JS loop over the whole listing pool.

**The offline fallback, and its honest limits**: without `VOYAGE_API_KEY`,
`get_embedding()` hashes each word into one of 256 buckets ("the hashing
trick" / "feature hashing" - a real, if simple, technique, not something
invented for this project). This is enough to exercise the entire
pgvector pipeline (storage, `<=>` queries, ranking) without needing an
API key, and it was verified byte-for-byte identical between the Python
and Node implementations so a Node-embedded resume and a Python-embedded
listing are genuinely comparable. But be precise in interview about what
it ISN'T: it only catches shared *words* (via hash buckets), not real
semantic meaning the way a trained model does. Set `VOYAGE_API_KEY` to
get the real thing - nothing else in the pipeline changes.

## The agent - 3 tools, matching the spec's names exactly

- `search_jobs(query, limit)` - keyword search (`ILIKE`) over the shared
  listing pool. Not user-scoped - listings are public.
- `get_matches(limit)` - the caller's top embedding-similarity matches.
- `get_shortlist()` - the caller's saved listings.

**Authentication vs. authorization, concretely**: authentication already
happened in `middleware/auth.js` before any of this runs - it's what
produces a trusted `req.userId`. Authorization is enforced *inside*
`get_matches`/`get_shortlist` themselves: neither tool's schema (what the
model can even ask for) has a `user_id` field - `routes/agent.js` always
passes the real `req.userId` in from outside, so there's no argument the
model could set, however it's prompted, to read someone else's data. This
was tested directly: a second account's `get_matches` call correctly
reports "no resume uploaded" rather than ever seeing the first account's
matches.

Without `ANTHROPIC_API_KEY`, `lib/agent.js` routes to a tool with simple
keyword matching instead of letting a model choose - testable without a
key; real tool *selection* by the model needs the key.

## Briefing - the async job + polling pattern

`POST /agent/briefing/start` inserts a `briefings` row with
`status='processing'` and returns its id **immediately** - it does not
wait for the script to be written. A background function
(`generateBriefing`, not awaited by the route) then calls the LLM (or the
offline template) and updates that row to `completed` (with the script)
or `failed` (with an error). The frontend polls `GET
/agent/briefing/:id` every 1.5s until the status is no longer
`processing`.

This is the exact shape a real video/TTS job (HeyGen, ElevenLabs) would
need - job id → poll status → `processing`/`completed`/`failed`. Video
generation itself isn't implemented: it needs a paid API this project has
no way to hold a key for or test from this environment. The architecture
is real and tested (job creation, ownership-scoped polling, and the
completed/failed transitions all verified directly) - swapping in an
actual video API is a change to what happens *inside*
`generateBriefing()`, not to the job/polling shape around it.

## Deduplication strategy

`listings.source_url` is `UNIQUE`. `scraper/db.py`'s `upsert_listing()`
looks it up before every insert: found → update `scraped_at` (and
`raw_text` plus reset both `extraction_cached` and `embedding_cached` if
content actually changed); not found → insert. Verified by running
`python run.py` twice: second run reports "0 new, 6 already existed."
The shortlist uses the same check-before-insert pattern in
`routes/matches.js`'s `/save` handler, rather than `ON CONFLICT` - one
dedup pattern to explain, used in two places.

## Multi-tenancy - how it's enforced, and how it was tested

Every route touching private data (`resumes`, `matches`, `chat_messages`,
`briefings`) filters its SQL by `req.userId` from the verified JWT -
never an id from the URL or body. `DELETE /matches/shortlist/:id` and
`GET /agent/briefing/:id` both check ownership *and* existence together
(`WHERE id = $1 AND user_id = $2`), so something that exists but belongs
to someone else returns the same 404 as something that doesn't exist at
all. Tested directly for every private table: a second account gets an
empty shortlist, a 404 on the first user's resume, a 404 (not a deletion)
attempting to delete the first user's match, a 404 on the first user's
briefing job, and a correctly-scoped "no resume uploaded" from its own
`get_matches` tool call rather than ever seeing the first user's data.

## Security

- Passwords: bcrypt hash, never stored plain (`routes/auth.js`)
- File upload validation: PDF mimetype check + 5MB size limit
  (`routes/resume.js`), both tested (oversized/wrong-type files rejected
  with a clean 400, not a crash)
- Malformed JSON bodies: return 400, not a raw 500 or a crash - tested
  directly (`server.js`'s error middleware)
- All SQL is parameterized (`$1`, `$2`, ...) - never string-concatenated

## Repo layout

```
schema.sql                     the whole database schema, incl. pgvector setup
scraper/
  scrape.py                    two BeautifulSoup scrapers + pagination
  db.py                        psycopg2 + pgvector, upsert-by-source_url dedup
  extract.py                   LLM extraction, manual validation, retry/repair, offline fallback
  embed.py                     embedding generation (Voyage API or offline hashing-trick fallback)
  run.py                       orchestrates: scrape -> dedupe -> extract -> embed
  fixtures/                    offline-mode HTML for the two sources
backend/
  server.js                    Express app, mounts everything
  db.js                        pg connection pool + pgvector type registration
  middleware/auth.js           JWT verification -> req.userId
  routes/
    auth.js, listings.js, resume.js, matches.js, agent.js, briefing.js
  lib/
    embeddings.js               embedding generation, mirrors scraper/embed.py exactly
    justification.js            match explanation (LLM or offline fallback)
    agent.js                    tool-calling chat loop + offline fallback
    agentTools.js                search_jobs / get_matches / get_shortlist
    pdfExtract.js                 resume PDF -> text (pdfjs-dist)
    parseListing.js                required_skills JSON string <-> array
    asyncHandler.js                 catches async route errors so bad input can't crash the server
  public/                       the whole frontend (index.html, style.css, app.js) - no build step
```
