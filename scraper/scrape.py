"""
Scrapes two structurally different listing pages and returns a list of
plain dicts (source_url, source_name, raw_text). Nothing here touches the
database - that's db.py's job. This file only knows how to turn HTML into
text.

OFFLINE MODE: this dev sandbox can't reach arbitrary websites (its network
is locked to package registries only), so by default this reads local
files from fixtures/ instead of the real internet. The BeautifulSoup
selectors below are written the way you'd write them for a real page -
only where the HTML comes from changes. To go live: set OFFLINE_MODE to
False, and point SOURCE_A_URL / SOURCE_B_URL at real listing pages (you'll
need to inspect their actual HTML in a browser and adjust the .select()
calls below to match - I can't do that part without being able to see the
real page).
"""
import os
import time
import requests
from bs4 import BeautifulSoup

OFFLINE_MODE = os.environ.get("SCRAPE_OFFLINE_MODE", "true").lower() == "true"
FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")

SOURCE_A_URL = "https://example-placement-portal.invalid"
SOURCE_B_URL = "https://example-startup-jobs.invalid"

USER_AGENT = "NexusBot/1.0 (+student project)"
REQUEST_DELAY_SECONDS = 1.5  # be polite - don't hammer a real server with back-to-back requests


def fetch_html(url, fixture_filename):
    """Returns the HTML for one page, from a fixture file or the real
    internet depending on OFFLINE_MODE."""
    if OFFLINE_MODE:
        path = os.path.join(FIXTURES_DIR, fixture_filename)
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    headers = {"User-Agent": USER_AGENT}
    response = requests.get(url, headers=headers, timeout=10)
    response.raise_for_status()  # throws if the server returned an error status (4xx/5xx)
    time.sleep(REQUEST_DELAY_SECONDS)
    return response.text


def scrape_source_a(max_pages=5):
    """
    Source A: a <table> of job rows (mimics a campus placement portal).
    Pagination via a "Next" link with class="next-page".
    """
    fixture_pages = ["source_a_page1.html", "source_a_page2.html"]
    results = []
    page_num = 1

    while page_num <= max_pages:
        fixture = fixture_pages[page_num - 1] if page_num <= len(fixture_pages) else None
        if OFFLINE_MODE and fixture is None:
            break  # ran out of fixture pages to simulate

        url = f"{SOURCE_A_URL}/listings?page={page_num}"
        html = fetch_html(url, fixture)
        soup = BeautifulSoup(html, "html.parser")

        for row in soup.select("tr.job-row"):
            title = row.select_one(".job-title")
            company = row.select_one(".job-company")
            location = row.select_one(".job-location")
            detail = row.select_one(".job-detail")
            job_id = row.get("data-id", "")

            # We build one text blob per listing (not separate structured
            # fields yet) because the LLM extraction step (extract.py) is
            # what turns messy text into a fixed schema - that's the whole
            # point of that step, so we deliberately keep this part dumb.
            pieces = []
            if title:
                pieces.append(f"Title: {title.get_text(strip=True)}")
            if company:
                pieces.append(f"Company: {company.get_text(strip=True)}")
            if location:
                pieces.append(f"Location: {location.get_text(strip=True)}")
            if detail:
                pieces.append(detail.get_text(" ", strip=True))
            raw_text = "\n".join(pieces)

            results.append({
                "source_url": f"{SOURCE_A_URL}/listings/{job_id}",
                "source_name": "campus_placement_portal",
                "raw_text": raw_text,
            })

        next_link = soup.select_one("a.next-page")
        if not next_link:
            break  # no more pages
        page_num += 1

    return results


def scrape_source_b(max_pages=5):
    """
    Source B: <div> job cards (mimics a startup jobs board). Deliberately
    a different HTML shape from source A - divs/headings instead of table
    rows, rel="next" instead of a class - so the scraper genuinely has to
    handle two different structures, not the same one twice.
    """
    fixture_pages = ["source_b_page1.html", "source_b_page2.html"]
    results = []
    page_num = 1

    while page_num <= max_pages:
        fixture = fixture_pages[page_num - 1] if page_num <= len(fixture_pages) else None
        if OFFLINE_MODE and fixture is None:
            break

        url = f"{SOURCE_B_URL}/jobs?p={page_num}"
        html = fetch_html(url, fixture)
        soup = BeautifulSoup(html, "html.parser")

        for card in soup.select("div.listing-card"):
            role = card.select_one(".role-name")
            org = card.select_one(".org-name")
            meta = card.select_one(".meta-line")
            body = card.select_one(".card-body")
            card_id = card.get("id", "")

            pieces = []
            if role:
                pieces.append(f"Role: {role.get_text(strip=True)}")
            if org:
                pieces.append(f"Company: {org.get_text(strip=True)}")
            if meta:
                pieces.append(f"Meta: {meta.get_text(strip=True)}")
            if body:
                pieces.append(body.get_text(" ", strip=True))
            raw_text = "\n".join(pieces)

            results.append({
                "source_url": f"{SOURCE_B_URL}/jobs/{card_id}",
                "source_name": "starthire_jobs_board",
                "raw_text": raw_text,
            })

        next_link = soup.select_one('a[rel="next"]')
        if not next_link:
            break
        page_num += 1

    return results


def scrape_all():
    return scrape_source_a() + scrape_source_b()
