"""
Run this to (re)populate the listing pool:

    python run.py

Order of operations:
  1. scrape_all() - fetch both sources (scrape.py)
  2. upsert_listing() for each item - dedupe by source_url (db.py)
  3. For any listing that needs it (new, or content changed since last
     time): extract() to fill in the structured fields (extract.py)
  4. Then: get_embedding() on the listing's text and save it (embed.py) -
     a separate step from extraction, with its own cache flag
     (embedding_cached), because it's conceptually a separate question
     ("what does this text mean as a vector?" vs "what are its structured
     fields?") even though both run right after scraping here.

Safe to run repeatedly / on a schedule - re-running never creates
duplicate listings, and never re-pays for extraction or embedding on a
listing whose content hasn't changed.
"""
from dotenv import load_dotenv
load_dotenv()  # reads .env into environment variables, if one exists

from scrape import scrape_all
from db import get_connection, upsert_listing, save_extraction, save_embedding
from extract import extract, is_llm_available
from embed import get_embedding, is_embedding_api_available


def main():
    print(f"LLM extraction: {'LIVE (Claude API)' if is_llm_available() else 'OFFLINE fallback (no ANTHROPIC_API_KEY set)'}")
    print(f"Embeddings: {'LIVE (Voyage API)' if is_embedding_api_available() else 'OFFLINE fallback (no VOYAGE_API_KEY set)'}")

    conn = get_connection()
    scraped_items = scrape_all()
    print(f"Scraped {len(scraped_items)} raw listings.")

    new_count = updated_count = extracted_count = failed_count = embedded_count = 0

    for item in scraped_items:
        listing_id, was_new, needs_extraction, needs_embedding = upsert_listing(conn, item)
        if was_new:
            new_count += 1
        else:
            updated_count += 1

        if needs_extraction:
            result = extract(item["raw_text"])
            if result is None:
                failed_count += 1
                print(f"  [skip] extraction failed for {item['source_url']}")
            else:
                save_extraction(conn, listing_id, result)
                extracted_count += 1

        if needs_embedding:
            # Embed title + skills + description together - the same text
            # shape used for the resume side too (see backend/routes/resume.js),
            # since only vectors built from comparable text are meaningful
            # to compare with cosine similarity.
            text_for_embedding = item["raw_text"]
            vector = get_embedding(text_for_embedding)
            save_embedding(conn, listing_id, vector)
            embedded_count += 1

    conn.close()
    print(
        f"Done. {new_count} new, {updated_count} already existed (updated), "
        f"{extracted_count} newly extracted, {failed_count} extraction failures, "
        f"{embedded_count} newly embedded."
    )


if __name__ == "__main__":
    main()
