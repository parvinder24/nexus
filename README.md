## Demo Video

[▶ Watch NEXUS Demo Video](https://drive.google.com/file/d/1bztVFCq2CiQSVg3NCndm-RjkNXqJYjH0/view?t=2.811)
# NEXUS — Career Intelligence Agent

NEXUS is a job matching application that collects job listings, extracts structured information, generates embeddings, stores them in PostgreSQL with pgvector, and matches them against a user's resume.

It also includes:
- User authentication and authorization
- Resume upload and PDF parsing
- Semantic job matching
- Claude-based job extraction and match explanations
- A tool-calling agent for querying job data
- Saved job shortlists
- Asynchronous briefing generation

Video generation is not implemented. The current briefing feature generates a briefing script using an asynchronous job and polling flow.

## Tech Stack

| Component | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | PostgreSQL + pgvector |
| Database access | Parameterized SQL |
| Scraper | Python + Requests + BeautifulSoup |
| Authentication | JWT + bcrypt |
| Embeddings | Voyage AI / offline hashing fallback |
| Frontend | HTML + CSS + JavaScript |
| LLM | Claude API |
| File upload | Multer |
| PDF parsing | pdfjs-dist |

## Architecture

```text
                 ┌─────────────────┐
                 │   Web Frontend  │
                 │   HTML/CSS/JS   │
                 └────────┬────────┘
                          │ HTTP
                          ▼
                 ┌─────────────────┐
                 │ Node.js/Express │
                 │     Backend     │
                 └───────┬─────────┘
                         │
              ┌──────────┼───────────┐
              ▼          ▼           ▼
        PostgreSQL     Claude     Embeddings
        + pgvector      API       Voyage AI
              ▲
              │
        ┌─────┴─────┐
        │  Python   │
        │  Scraper  │
        └───────────┘
```

## Features

### 1. Job Scraping

The scraper collects job listings from two structurally different sources.

It supports:
- Pagination
- HTML parsing using BeautifulSoup
- `source_url`
- `scraped_at`
- Duplicate detection
- Request delay
- Retry handling
- Custom User-Agent
- Offline fixture mode

Run the scraper:

```bash
cd scraper
python run.py
```

By default, offline mode uses the HTML fixtures in `scraper/fixtures/`.

### 2. LLM Job Extraction

Raw job listings are converted into structured data using Claude.

The extracted fields are:

```text
title
company
location
remote_ok
stipend
required_skills
experience_level
deadline
```

The response is validated before being stored. Invalid responses can be repaired and retried.

Extracted results are cached so unchanged listings do not need to be processed again.

### 3. Resume Matching

Users can upload a PDF resume.

The flow is:

```text
Resume PDF
   ↓
Multer
   ↓
PDF text extraction
   ↓
Embedding generation
   ↓
PostgreSQL + pgvector
   ↓
Cosine similarity search
   ↓
Ranked job matches
```

Embeddings can be generated using Voyage AI.

When `VOYAGE_API_KEY` is not available, the application uses a deterministic hashing-based fallback so the complete matching pipeline can still run locally.

The database uses pgvector's cosine-distance operator:

```sql
SELECT *, 1 - (embedding <=> $1) AS score
FROM listings
ORDER BY embedding <=> $1
LIMIT 20;
```

### 4. Agent and Tool Calling

The application includes a Claude-based agent with three tools:

```text
search_jobs(query, limit)
get_matches(limit)
get_shortlist()
```

The flow is:

```text
User question
     ↓
Claude
     ↓
Tool selection
     ↓
Backend validation
     ↓
PostgreSQL query
     ↓
Tool result
     ↓
Claude response
```

Private tools receive the authenticated user's ID from the backend rather than accepting a user ID from the model.

### 5. Authentication and Multi-Tenancy

Authentication uses JWT and bcrypt.

The authentication flow is:

```text
Register/Login
     ↓
Password verification
     ↓
JWT issued
     ↓
JWT sent with requests
     ↓
Auth middleware
     ↓
req.userId
```

Private data is queried using the authenticated user's ID.

This applies to:
- Resumes
- Matches
- Shortlists
- Chat messages
- Briefing jobs

Users cannot access another user's private data.

### 6. Briefing

The briefing feature uses an asynchronous job and polling pattern.

```text
POST /agent/briefing/start
          ↓
Create job
status = processing
          ↓
Return job ID immediately
          ↓
Background generation
          ↓
completed / failed
          ↓
Frontend polls job status
```

The frontend polls:

```text
GET /agent/briefing/:id
```

until the job is completed or fails.

The current implementation generates a briefing script. Video/TTS generation is not implemented.

## Deduplication

`listings.source_url` is unique.

When a listing is scraped:
- Existing `source_url` → update the listing
- New `source_url` → insert a new listing

If the listing content changes, extraction and embedding caches are reset.

The same check-before-insert approach is used when saving jobs to a user's shortlist.

## Security

- Passwords are stored as bcrypt hashes.
- JWT is used for authenticated requests.
- Private database queries use the authenticated user's ID.
- SQL queries use parameters instead of string concatenation.
- Resume uploads are restricted to PDF files.
- Resume uploads have a 5 MB size limit.
- Invalid JSON requests return a controlled `400` response.
- User-owned resources are checked before access or deletion.

## Environment Variables

Create a `.env` file inside `backend/` and configure the required values.

| Variable | Used by | Purpose |
|---|---|---|
| `DB_HOST` | Backend/Scraper | PostgreSQL host |
| `DB_PORT` | Backend/Scraper | PostgreSQL port |
| `DB_NAME` | Backend/Scraper | Database name |
| `DB_USER` | Backend/Scraper | PostgreSQL user |
| `DB_PASSWORD` | Backend/Scraper | PostgreSQL password |
| `JWT_SECRET` | Backend | JWT signing secret |
| `ANTHROPIC_API_KEY` | Backend/Scraper | Claude API |
| `VOYAGE_API_KEY` | Backend/Scraper | Voyage AI embeddings |
| `SCRAPE_OFFLINE_MODE` | Scraper | Enables local fixture mode |

API keys and secrets should not be committed to GitHub.

## Setup

### Database

Install PostgreSQL and pgvector first.

Create the database:

```bash
createdb nexus
```

Run the schema:

```bash
psql -U postgres -d nexus -f schema.sql
```

### Scraper

```bash
cd scraper
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Configure the scraper environment variables in `scraper/.env`.

### Backend

```bash
cd backend
npm install
node server.js
```

Configure the backend environment variables in `backend/.env` before starting the server.

Open:

```text
http://127.0.0.1:3000
```

## Repository Structure

```text
nexus/
├── schema.sql
├── README.md
├── scraper/
│   ├── scrape.py
│   ├── db.py
│   ├── extract.py
│   ├── embed.py
│   ├── run.py
│   ├── requirements.txt
│   └── fixtures/
│
└── backend/
    ├── server.js
    ├── db.js
    ├── middleware/
    │   └── auth.js
    ├── routes/
    │   ├── auth.js
    │   ├── listings.js
    │   ├── resume.js
    │   ├── matches.js
    │   ├── agent.js
    │   └── briefing.js
    ├── lib/
    │   ├── agent.js
    │   ├── agentTools.js
    │   ├── embeddings.js
    │   ├── justification.js
    │   ├── parseListing.js
    │   ├── pdfExtract.js
    │   └── asyncHandler.js
    └── public/
        ├── index.html
        ├── style.css
        └── app.js
```

## Current Limitations

- Video generation is not implemented.
- Real semantic embeddings require `VOYAGE_API_KEY`.
- Claude-powered extraction, agent responses, match explanations and briefing generation require `ANTHROPIC_API_KEY`.
- Offline modes are available for local testing without API keys.
