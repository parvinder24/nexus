// The spec's actual requirement: the model must reach the database
// through TOOLS, not from a giant dump of rows pasted into the prompt.
// That's a real design reason, not just a rule to satisfy: pasting the
// whole shortlist into every prompt gets more expensive as it grows, and
// the model has to re-read all of it to answer even a narrow question.
// A tool call means the model asks a narrow question and the DATABASE -
// not the model - does the filtering.
const { TOOL_SCHEMAS, TOOL_REGISTRY, searchJobs, getMatches, getShortlist } = require("./agentTools");

const SYSTEM_PROMPT =
  "You are Nexus, an assistant for a job/internship search app. You can search " +
  "the shared listing pool, look up the user's own best matches, and see their " +
  "own shortlist. Always use the provided tools to look up real data - never " +
  "guess or invent listings, scores, or companies. Keep answers short and concrete.";

async function offlineReply(userId, message) {
  // No API key: route to a tool with simple keyword matching instead of
  // letting a model decide which tool to call. This exists so the chat UI
  // is testable without holding/paying for an API key - real free-form
  // Q&A, and the model actually CHOOSING a tool, needs ANTHROPIC_API_KEY set.
  const lower = message.toLowerCase();

  if (lower.includes("shortlist")) {
    const data = await getShortlist(userId);
    if (data.length === 0) return { reply: "Your shortlist is empty - save a listing from Find Matches first.", toolsUsed: ["get_shortlist"] };
    const lines = data.map((d) => `${d.title} at ${d.company} (score ${Number(d.score).toFixed(2)})`).join("; ");
    return { reply: `Your shortlist: ${lines}.`, toolsUsed: ["get_shortlist"] };
  }

  if (lower.includes("match")) {
    const data = await getMatches(userId, 5);
    if (data.error) return { reply: data.error, toolsUsed: ["get_matches"] };
    const lines = data.map((d) => `${d.title} at ${d.company} (${(d.score * 100).toFixed(0)}%)`).join("; ");
    return { reply: `Your top matches: ${lines}.`, toolsUsed: ["get_matches"] };
  }

  // default: treat the message itself as a search_jobs keyword query
  const data = await searchJobs(message, 5);
  if (data.error || data.length === 0) {
    return { reply: "No listings found for that. Try a different keyword, or ask about your matches or shortlist.", toolsUsed: ["search_jobs"] };
  }
  const lines = data.map((d) => `${d.title} at ${d.company}`).join("; ");
  return {
    reply: `Found: ${lines}. (Offline demo mode - set ANTHROPIC_API_KEY so the agent can pick the right tool itself instead of this keyword routing.)`,
    toolsUsed: ["search_jobs"],
  };
}

async function chat(userId, message) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return offlineReply(userId, message);
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let messages = [{ role: "user", content: message }];
  const toolsUsed = [];

  // Agent loop: keep going while the model asks for tools, stop once it
  // replies with plain text. Capped at 5 rounds so a confused model can't
  // loop forever.
  for (let round = 0; round < 5; round++) {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      tools: TOOL_SCHEMAS,
      messages,
    });

    if (response.stop_reason !== "tool_use") {
      const finalText = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { reply: finalText.trim(), toolsUsed };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      toolsUsed.push(block.name);
      let result;
      try {
        // block.input is whatever arguments the MODEL chose - note it
        // never contains a user id (see agentTools.js's schemas), so
        // TOOL_REGISTRY[block.name](userId, block.input) always uses
        // OUR trusted userId, not anything the model supplied.
        result = await TOOL_REGISTRY[block.name](userId, block.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { reply: "I wasn't able to settle on an answer - try rephrasing your question.", toolsUsed };
}

module.exports = { chat };
