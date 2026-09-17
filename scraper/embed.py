"""
Turns a piece of text into a fixed-length list of numbers (a "vector") -
an embedding. This is a genuinely different idea from TF-IDF, worth being
clear about for the interview:

  TF-IDF (what this project used to use): a document's vector depends on
  the WHOLE corpus - the weight of "python" depends on how rare "python"
  is across every other document you're comparing against. Recompute the
  corpus, the vectors shift.

  An embedding: each document gets a vector on its own, independent of
  any other document. A real embedding model (Voyage AI here - the
  provider Anthropic itself recommends alongside Claude) was trained on
  huge amounts of text to place semantically similar text near each other
  in that vector space, even with zero words in common ("backend infra"
  and "distributed systems" can end up close together). That's WHY
  embeddings beat pure keyword/TF-IDF matching: they can catch a real
  match that shares meaning but not vocabulary.

WHY THERE'S ALSO AN OFFLINE FALLBACK: this project was built in a sandbox
that can't reach arbitrary internet APIs, so calling the real Voyage API
can't be tested from here. Instead of leaving the pipeline untestable,
get_embedding() falls back to a "hashing trick" (aka feature hashing) when
VOYAGE_API_KEY isn't set: every word gets hashed into one of 256 buckets,
each bucket counts how often its words appeared, and the resulting vector
is normalized to length 1. Be precise about what this fallback IS and
ISN'T: it's a legitimate, real technique (scikit-learn and Vowpal Wabbit
both ship it) for turning text into a fixed-size vector independently per
document - which is why it's useful for testing the pgvector plumbing end
to end - but it only captures "these two texts share hashed words," not
real semantic meaning the way a trained embedding model does. Set
VOYAGE_API_KEY to get the real thing; the rest of the pipeline (storage,
cosine similarity search) doesn't change either way.
"""
import os
import re
import hashlib
import math

VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY", "")
EMBEDDING_DIM = 256  # must match the `vector(256)` columns in schema.sql

STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
    "been", "to", "of", "in", "on", "for", "with", "as", "by", "at", "from",
    "this", "that", "it", "you", "your", "we", "our", "will", "would", "can",
}


def is_embedding_api_available():
    return bool(VOYAGE_API_KEY)


def _tokenize(text):
    return [
        w for w in re.split(r"[^a-z0-9+#]+", (text or "").lower())
        if len(w) > 1 and w not in STOPWORDS
    ]


def _offline_embedding(text):
    """The hashing-trick fallback described above. Deterministic - the
    same text always produces the same vector, which is what makes this
    usable for automated testing without an API key."""
    vector = [0.0] * EMBEDDING_DIM

    for token in _tokenize(text):
        # md5 just as a stable, well-distributed hash function - nothing
        # cryptographic about its use here, we only want the bucket index.
        digest = hashlib.md5(token.encode("utf-8")).hexdigest()
        bucket = int(digest[:8], 16) % EMBEDDING_DIM
        sign = 1 if int(digest[8], 16) % 2 == 0 else -1  # reduces hash-collision bias
        vector[bucket] += sign

    # L2-normalize so every vector has length 1 - this is what makes
    # cosine similarity meaningful/comparable across documents of very
    # different lengths (a long job posting vs a short resume line).
    magnitude = math.sqrt(sum(v * v for v in vector))
    if magnitude > 0:
        vector = [v / magnitude for v in vector]
    return vector


def _voyage_embedding(text):
    import requests
    response = requests.post(
        "https://api.voyageai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {VOYAGE_API_KEY}", "Content-Type": "application/json"},
        json={"input": [text], "model": "voyage-3-lite", "output_dimension": EMBEDDING_DIM},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()["data"][0]["embedding"]


def get_embedding(text):
    """Returns a list of EMBEDDING_DIM floats. Never raises - falls back
    to the offline embedding on any API error, same "must not crash on
    bad output" robustness principle as extract.py."""
    if not is_embedding_api_available():
        return _offline_embedding(text)
    try:
        return _voyage_embedding(text)
    except Exception as e:
        print(f"  [embed] Voyage API call failed ({e}), using offline fallback for this item")
        return _offline_embedding(text)
