"""
Turns one listing's messy raw_text into a fixed set of fields:
{title, company, location, remote_ok, stipend, required_skills,
experience_level, deadline}.

WHY THIS NEEDS AN LLM AT ALL: source A writes "Title: X", source B writes
"Role: X" - a real third source would use yet another convention. Two
sources are just barely regex-able if you hardcode a parser per source,
but that doesn't scale, and it's exactly the kind of messy-real-world-text
problem an LLM is good at: give it the raw text and the target shape, and
it maps arbitrary phrasing into the same fields ("$25-35/hr" and "50k
INR/mo" both become a stipend string; "Remote-first" and "Onsite - Pune"
both resolve remote_ok correctly).

ROBUSTNESS, one requirement at a time:
  - "force into a fixed schema"    -> the prompt below states the exact shape
  - "validate the output"          -> validate() checks it by hand (no
                                       Pydantic - just "is this key present
                                       and the right type")
  - "retry/repair malformed JSON"  -> extract() retries with an error
                                       message appended, up to 2 times
  - "must not crash on bad output" -> extract() returns None on repeated
                                       failure instead of raising
  - "cache extractions"            -> handled by the caller (run.py), which
                                       only calls this for listings where
                                       needs_extraction is True
"""
import os
import json
import re

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")

EXTRACTION_SYSTEM_PROMPT = """You extract structured data from a scraped job/internship posting.
Respond with ONLY a single JSON object, no markdown fences, no commentary, matching exactly:
{
  "title": string,
  "company": string,
  "location": string,
  "remote_ok": boolean,
  "stipend": string or null,
  "required_skills": array of strings (short skill/tech names, lowercase),
  "experience_level": one of "intern", "entry_level", "mid", "senior",
  "deadline": string or null (keep whatever date format the posting used)
}
If a field truly isn't present in the text, use null (or false for remote_ok, [] for required_skills)."""


def is_llm_available():
    return bool(ANTHROPIC_API_KEY)


def validate(data):
    """
    Manual schema validation - no Pydantic. Raises ValueError with a
    message describing what's wrong, which extract() then feeds back to
    the model for a repair attempt.
    """
    required_string_fields = ["title", "company", "location"]
    for field in required_string_fields:
        if not isinstance(data.get(field), str) or not data[field]:
            raise ValueError(f"'{field}' must be a non-empty string")

    if not isinstance(data.get("remote_ok"), bool):
        raise ValueError("'remote_ok' must be a boolean")

    if not isinstance(data.get("required_skills"), list):
        raise ValueError("'required_skills' must be a list of strings")

    valid_levels = {"intern", "entry_level", "mid", "senior"}
    if data.get("experience_level") not in valid_levels:
        raise ValueError(f"'experience_level' must be one of {valid_levels}")

    # stipend and deadline are allowed to be null/missing - nothing to check
    return {
        "title": data["title"],
        "company": data["company"],
        "location": data["location"],
        "remote_ok": data["remote_ok"],
        "stipend": data.get("stipend"),
        "required_skills": data["required_skills"],
        "experience_level": data["experience_level"],
        "deadline": data.get("deadline"),
    }


def _strip_code_fences(text):
    """Models sometimes wrap JSON in ```json ... ``` even when told not to."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text.strip()


def _call_llm(raw_text, repair_note=""):
    import anthropic  # only imported when actually needed
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    user_content = raw_text if not repair_note else f"{repair_note}\n\nOriginal posting text:\n{raw_text}"
    response = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=500,
        system=EXTRACTION_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
    )
    return response.content[0].text


def _offline_fallback(raw_text):
    """
    No API key set: a small regex parser instead of calling Claude, so the
    pipeline still runs end to end without needing a key. Deliberately
    simple compared to the real LLM path - see the module docstring for
    why the LLM step matters once you have more than two source formats.
    """
    def find(*labels):
        for label in labels:
            m = re.search(rf"{label}:\s*(.+)", raw_text)
            if m:
                return m.group(1).split("\n")[0].strip()
        return None

    title = find("Title", "Role") or "Untitled listing"
    company = find("Company") or "Unknown company"
    location = find("Location") or find("Meta") or "Unspecified"
    meta_or_location = (find("Meta") or "") + " " + location
    remote_ok = "remote" in meta_or_location.lower()

    stipend_match = re.search(
        r"(stipend[:\s]*[^\n.]+|\$\d+[-\u2013]\d+/hr|\d{2,3},?\d{3}\s*(?:INR)?\s*/?\s*mo)",
        raw_text, re.I,
    )
    stipend = stipend_match.group(0) if stipend_match else None

    deadline_match = re.search(r"(?:deadline|apply by)[:\s]*([A-Za-z0-9 ,]+)", raw_text, re.I)
    deadline = deadline_match.group(1).strip() if deadline_match else None

    skill_vocab = ["python", "react", "typescript", "sql", "kubernetes", "go",
                    "kafka", "rabbitmq", "pytorch", "pandas", "postgres", "java", "c++"]
    lower = raw_text.lower()
    required_skills = [s for s in skill_vocab if s in lower]

    experience_level = "intern" if "intern" in raw_text.lower() else "entry_level"

    return {
        "title": title, "company": company, "location": location,
        "remote_ok": remote_ok, "stipend": stipend, "required_skills": required_skills,
        "experience_level": experience_level, "deadline": deadline,
    }


def extract(raw_text, max_retries=2):
    """Returns a validated dict, or None if extraction couldn't be made to
    fit the schema after retries. Callers must treat None as "skip this
    listing" - never let a bad LLM response crash the whole scrape run."""
    if not is_llm_available():
        try:
            return validate(_offline_fallback(raw_text))
        except ValueError:
            return None

    repair_note = ""
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            raw_response = _call_llm(raw_text, repair_note)
            cleaned = _strip_code_fences(raw_response)
            data = json.loads(cleaned)
            return validate(data)
        except (json.JSONDecodeError, ValueError) as e:
            last_error = e
            repair_note = (
                f"Your previous response was invalid ({e}). "
                f"Reply again with ONLY the corrected JSON object, matching the schema exactly."
            )
            continue
        except Exception as e:
            last_error = e
            break  # network/API error - don't retry indefinitely, just skip this listing

    print(f"  [extraction] gave up after {max_retries + 1} attempts: {last_error}")
    return None
