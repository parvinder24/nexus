// Same idea as scraper/embed.py (read that file's docstring first - it
// explains what an embedding is and why it beats TF-IDF). This file
// exists separately, in JS, because the resume is uploaded and embedded
// here in the Express backend, while listings are embedded in the Python
// scraper - but a resume vector and a listing vector only mean anything
// compared to each other if they were built the SAME way. So the offline
// fallback below is a deliberate line-for-line port of the Python
// version's hashing trick: same MD5 hashing, same bucket count, same
// sign rule, same L2 normalization - swap either side to the real Voyage
// API and they're still comparable, because Voyage's model is the same
// regardless of which language called it.
const crypto = require("crypto");

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "";
const EMBEDDING_DIM = 256; // must match the `vector(256)` columns in schema.sql

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be",
  "been", "to", "of", "in", "on", "for", "with", "as", "by", "at", "from",
  "this", "that", "it", "you", "your", "we", "our", "will", "would", "can",
]);

function isEmbeddingApiAvailable() {
  return Boolean(VOYAGE_API_KEY);
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function offlineEmbedding(text) {
  const vector = new Array(EMBEDDING_DIM).fill(0);

  for (const token of tokenize(text)) {
    const digest = crypto.createHash("md5").update(token).digest("hex");
    const bucket = parseInt(digest.slice(0, 8), 16) % EMBEDDING_DIM;
    const sign = parseInt(digest[8], 16) % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= magnitude;
  }
  return vector;
}

async function voyageEmbedding(text) {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: [text], model: "voyage-3-lite", output_dimension: EMBEDDING_DIM }),
  });
  if (!response.ok) throw new Error(`Voyage API returned ${response.status}`);
  const data = await response.json();
  return data.data[0].embedding;
}

async function getEmbedding(text) {
  if (!isEmbeddingApiAvailable()) return offlineEmbedding(text);
  try {
    return await voyageEmbedding(text);
  } catch (err) {
    console.error(`[embed] Voyage API call failed (${err.message}), using offline fallback`);
    return offlineEmbedding(text);
  }
}

module.exports = { getEmbedding, isEmbeddingApiAvailable, EMBEDDING_DIM };
