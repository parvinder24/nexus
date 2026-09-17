// listings.required_skills is stored in Postgres as a JSON-encoded TEXT
// column (see schema.sql), not a Postgres array type - so every row that
// comes straight out of the database needs JSON.parse() before anything
// downstream (matching, the agent's skill-counting tool, the frontend)
// can treat it as a normal array. One small helper here means that
// JSON.parse call happens in exactly one place instead of being repeated
// (and possibly forgotten) in every route.
function parseListingRow(row) {
  return {
    ...row,
    required_skills: row.required_skills ? JSON.parse(row.required_skills) : [],
  };
}

module.exports = { parseListingRow };
