// Entrypoint. Run with: node server.js (from backend/).
require("dotenv").config(); // reads .env into process.env, if one exists

const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const listingsRoutes = require("./routes/listings");
const resumeRoutes = require("./routes/resume");
const matchesRoutes = require("./routes/matches");
const agentRoutes = require("./routes/agent");
const briefingRoutes = require("./routes/briefing");

const app = express();

app.use(cors()); // fine for a local student project; lock this down before any real deployment
app.use(express.json()); // parses JSON request bodies into req.body

app.use("/auth", authRoutes);
app.use("/listings", listingsRoutes);
app.use("/resume", resumeRoutes);
app.use("/matches", matchesRoutes);
app.use("/agent", agentRoutes);
app.use("/agent/briefing", briefingRoutes);

// Serves the whole frontend (public/index.html, app.js, style.css) as
// plain static files - no separate build step, no separate process.
app.use(express.static(path.join(__dirname, "../public")));
// A catch-all error handler: if any route above throws (e.g. a bad SQL
// query, a database connection drop), Express finds this by matching the
// 4-argument (err, req, res, next) signature and calls it instead of a
// normal route. This turns an unhandled error into a JSON response
// instead of the raw stack trace Express would otherwise send - so one
// bad request can't take the whole app down or leak internals.
//
// (Tested directly: sending deliberately malformed JSON to a POST route
// hits this handler and gets a clean 400 back; the server process stays
// up and keeps serving other requests fine afterward.)
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.parse.failed") {
    // express.json() (via body-parser) sets this when the request body
    // isn't valid JSON - that's the client's fault, so 400, not 500.
    return res.status(400).json({ error: "Malformed JSON in request body." });
  }
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nexus backend running on http://127.0.0.1:${PORT}`);
});
