// Everything here talks to the Express backend via fetch(). No framework,
// no build step - this file plus index.html/style.css is the whole
// frontend, served directly by Express's static file middleware
// (see server.js: app.use(express.static(...))).

const API = ""; // same-origin: Express serves both the API and this file
let TOKEN = localStorage.getItem("nexus_token") || null;
let isSignupMode = false;

async function api(path, options = {}) {
  const headers = options.headers || {};
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(API + path, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired - please log in again.");
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- auth screen ----------
const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");
const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const authToggleBtn = document.getElementById("auth-toggle-btn");
const authToggleText = document.getElementById("auth-toggle-text");

authToggleBtn.addEventListener("click", () => {
  isSignupMode = !isSignupMode;
  authSubmit.textContent = isSignupMode ? "Create account" : "Log in";
  authToggleText.textContent = isSignupMode ? "Already have an account?" : "New here?";
  authToggleBtn.textContent = isSignupMode ? "Log in instead" : "Create an account";
  authError.textContent = "";
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";
  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;
  try {
    const data = await api(isSignupMode ? "/auth/signup" : "/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    TOKEN = data.token;
    localStorage.setItem("nexus_token", TOKEN);
    enterApp();
  } catch (err) {
    authError.textContent = err.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", logout);

function logout() {
  TOKEN = null;
  localStorage.removeItem("nexus_token");
  appShell.classList.add("hidden");
  authScreen.classList.remove("hidden");
}

function enterApp() {
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  loadListings();
}

// ---------- tab switching ----------
document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");

    if (btn.dataset.tab === "listings") loadListings();
    if (btn.dataset.tab === "shortlist") loadShortlist();
    if (btn.dataset.tab === "agent") loadChatHistory();
  });
});

// ---------- listings ----------
function listingCardHTML(listing, extra = "") {
  const skills = (listing.required_skills || []).join(", ");
  return `
    <div class="listing-card">
      <h3>${listing.title || "Untitled"}</h3>
      <div class="company-line">${listing.company || ""} — ${listing.location || ""}${listing.remote_ok ? " (Remote OK)" : ""}</div>
      ${listing.stipend ? `<div class="subtext">${listing.stipend}</div>` : ""}
      ${listing.deadline ? `<div class="subtext">Deadline: ${listing.deadline}</div>` : ""}
      ${skills ? `<div class="skills">${skills}</div>` : ""}
      ${extra}
    </div>`;
}

async function loadListings() {
  const el = document.getElementById("listings-list");
  el.innerHTML = "<p class='subtext'>Loading…</p>";
  try {
    const listings = await api("/listings");
    el.innerHTML = listings.length
      ? listings.map((l) => listingCardHTML(l)).join("")
      : "<p class='subtext'>No listings yet - run <code>python run.py</code> in the scraper/ folder.</p>";
  } catch (err) {
    el.innerHTML = `<p class="auth-error">${err.message}</p>`;
  }
}

// ---------- resume upload ----------
document.getElementById("resume-upload-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("resume-file");
  const status = document.getElementById("resume-status");
  if (!fileInput.files.length) {
    status.textContent = "Choose a PDF first.";
    return;
  }
  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  status.textContent = "Uploading…";
  try {
    const data = await api("/resume/upload", { method: "POST", body: formData });
    status.textContent = `Uploaded ${data.filename} (${data.chars_extracted} characters extracted). Go to "Find Matches" next.`;
  } catch (err) {
    status.textContent = err.message;
  }
});

// ---------- matches ----------
document.getElementById("run-match-btn").addEventListener("click", async () => {
  const el = document.getElementById("matches-list");
  el.innerHTML = "<p class='subtext'>Ranking against your resume…</p>";
  try {
    const results = await api("/matches/search");
    el.innerHTML = results.length
      ? results
          .map((r) => {
            const extra = `
              <span class="score-badge">${(r.score * 100).toFixed(1)}%</span>
              <div class="justification">${r.justification}</div>
              <button class="save-btn" data-listing-id="${r.listing.id}">Save to shortlist</button>
            `;
            return listingCardHTML(r.listing, extra);
          })
          .join("")
      : "<p class='subtext'>No matches found.</p>";

    el.querySelectorAll(".save-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.textContent = "Saving…";
        try {
          await api("/matches/save", {
            method: "POST",
            body: JSON.stringify({ listing_id: parseInt(btn.dataset.listingId) }),
          });
          btn.textContent = "Saved ✓";
          btn.disabled = true;
        } catch (err) {
          btn.textContent = "Save to shortlist";
          alert(err.message);
        }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="auth-error">${err.message}</p>`;
  }
});

// ---------- shortlist ----------
// Note: /matches/shortlist returns FLAT rows (match_id, score, justification,
// plus every listings.* column merged in) rather than a nested {listing: ...}
// object - see the SQL JOIN in routes/matches.js. listingCardHTML doesn't
// care since it just reads whatever title/company/etc fields are present.
async function loadShortlist() {
  const el = document.getElementById("shortlist-list");
  el.innerHTML = "<p class='subtext'>Loading…</p>";
  try {
    const matches = await api("/matches/shortlist");
    el.innerHTML = matches.length
      ? matches
          .map((m) => {
            const extra = `
              <span class="score-badge">${(m.score * 100).toFixed(1)}%</span>
              ${m.justification ? `<div class="justification">${m.justification}</div>` : ""}
              <button class="remove-btn" data-match-id="${m.match_id}">Remove</button>
            `;
            return listingCardHTML(m, extra);
          })
          .join("")
      : "<p class='subtext'>Nothing shortlisted yet.</p>";

    el.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/matches/shortlist/${btn.dataset.matchId}`, { method: "DELETE" });
        loadShortlist();
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="auth-error">${err.message}</p>`;
  }
}

// ---------- agent chat ----------
function appendChatMessage(role, content) {
  const log = document.getElementById("chat-log");
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.textContent = content;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function loadChatHistory() {
  const log = document.getElementById("chat-log");
  log.innerHTML = "";
  try {
    const history = await api("/agent/history");
    history.forEach((m) => appendChatMessage(m.role, m.content));
  } catch (err) {
    appendChatMessage("assistant", err.message);
  }
}

document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("chat-input");
  const message = input.value.trim();
  if (!message) return;
  appendChatMessage("user", message);
  input.value = "";
  try {
    const data = await api("/agent/chat", { method: "POST", body: JSON.stringify({ message }) });
    appendChatMessage("assistant", data.reply);
  } catch (err) {
    appendChatMessage("assistant", err.message);
  }
});

// ---------- briefing (async job + polling) ----------
document.getElementById("run-briefing-btn").addEventListener("click", async () => {
  const status = document.getElementById("briefing-status");
  const scriptBox = document.getElementById("briefing-script");
  scriptBox.classList.add("hidden");
  status.textContent = "Starting…";

  try {
    // Step 1: kick off the job - this returns immediately with a job id,
    // it does NOT wait for the script to actually be written.
    const { job_id } = await api("/agent/briefing/start", { method: "POST" });
    status.textContent = "Generating your briefing…";

    // Step 2: poll. Every 1.5s, ask "is it done yet?" until status is no
    // longer "processing". This is the same pattern a real video-generation
    // job (HeyGen, ElevenLabs) would use - poll a job id until it flips to
    // completed/failed - just with an LLM script-writing call standing in
    // for the slow external job here.
    const poll = async () => {
      const job = await api(`/agent/briefing/${job_id}`);
      if (job.status === "processing") {
        setTimeout(poll, 1500);
        return;
      }
      if (job.status === "completed") {
        status.textContent = "Done.";
        scriptBox.textContent = job.script;
        scriptBox.classList.remove("hidden");
      } else {
        status.textContent = `Failed: ${job.error}`;
      }
    };
    poll();
  } catch (err) {
    status.textContent = err.message;
  }
});

// ---------- boot ----------
if (TOKEN) enterApp();
