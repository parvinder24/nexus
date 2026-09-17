"""
Talks to Postgres for the scraper. Three things happen here:
  1. get_connection() - open a connection using the same env vars the
     Node backend uses (see backend/.env.example), so both halves of the
     app point at the same database without duplicating config.
  2. upsert_listing() - the deduplication logic.
  3. save_extraction() / save_embedding() - write back the two things the
     pipeline computes about a listing after it's scraped.

DEDUPLICATION STRATEGY (also explained in the README):
`source_url` is a UNIQUE column (see schema.sql). Before inserting a
scraped item, we SELECT for that source_url first:
  - found     -> UPDATE scraped_at (and raw_text, if content changed -
                 which also resets extraction_cached AND embedding_cached
                 to False, since both need redoing on genuinely new text)
  - not found -> INSERT a new row
This means running the scraper twice in a row never creates duplicate
rows - re-running it just refreshes scraped_at on listings that are still
up. The UNIQUE constraint on source_url is a second, hard backstop: even
if this upsert logic had a bug, Postgres itself would reject a duplicate
insert rather than silently allowing one.
"""
import os
import psycopg2
from pgvector.psycopg2 import register_vector

DB_HOST = os.environ.get("DB_HOST", "127.0.0.1")
DB_PORT = os.environ.get("DB_PORT", "5432")
DB_NAME = os.environ.get("DB_NAME", "nexus")
DB_USER = os.environ.get("DB_USER", "postgres")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "postgres")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    # register_vector teaches psycopg2 how to send/receive Postgres's
    # `vector` type as a plain Python list - without this, passing a list
    # of floats to a `vector` column would fail, since psycopg2 has no
    # built-in idea what a pgvector column is.
    register_vector(conn)
    return conn


def upsert_listing(conn, item):
    """
    item is a dict with source_url, source_name, raw_text (see scrape.py).
    Returns (listing_id, was_newly_created, needs_extraction, needs_embedding).
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT id, raw_text, extraction_cached, embedding_cached FROM listings WHERE source_url = %s",
        (item["source_url"],),
    )
    existing = cur.fetchone()

    if existing:
        listing_id, old_raw_text, extraction_cached, embedding_cached = existing
        content_changed = old_raw_text != item["raw_text"]
        if content_changed:
            cur.execute(
                """UPDATE listings SET scraped_at = NOW(), raw_text = %s,
                   extraction_cached = FALSE, embedding_cached = FALSE WHERE id = %s""",
                (item["raw_text"], listing_id),
            )
        else:
            cur.execute("UPDATE listings SET scraped_at = NOW() WHERE id = %s", (listing_id,))
        conn.commit()
        needs_extraction = content_changed or not extraction_cached
        needs_embedding = content_changed or not embedding_cached
        return listing_id, False, needs_extraction, needs_embedding

    cur.execute(
        "INSERT INTO listings (source_url, source_name, raw_text) VALUES (%s, %s, %s) RETURNING id",
        (item["source_url"], item["source_name"], item["raw_text"]),
    )
    listing_id = cur.fetchone()[0]
    conn.commit()
    return listing_id, True, True, True


def save_extraction(conn, listing_id, extracted):
    """extracted is a dict matching the schema in extract.py's EXTRACTION_SCHEMA.
    required_skills is stored as a JSON string (json.dumps), not a Postgres
    array type - kept deliberately plain, using the same JSON you already
    use everywhere else (API responses, JS objects), rather than a
    Postgres-specific feature."""
    import json
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE listings SET
            title = %s, company = %s, location = %s, remote_ok = %s,
            stipend = %s, required_skills = %s, experience_level = %s,
            deadline = %s, extraction_cached = TRUE
        WHERE id = %s
        """,
        (
            extracted["title"], extracted["company"], extracted["location"],
            extracted["remote_ok"], extracted["stipend"], json.dumps(extracted["required_skills"]),
            extracted["experience_level"], extracted["deadline"], listing_id,
        ),
    )
    conn.commit()


def save_embedding(conn, listing_id, vector):
    """vector is a plain Python list of EMBEDDING_DIM floats (see embed.py).
    register_vector() (called in get_connection above) is what lets us pass
    that list straight into a `vector` column, same as any other parameter."""
    cur = conn.cursor()
    cur.execute("UPDATE listings SET embedding = %s, embedding_cached = TRUE WHERE id = %s", (vector, listing_id))
    conn.commit()
