// One short sentence explaining why a listing is (or isn't) a good match.
// Offline fallback (no ANTHROPIC_API_KEY): just name the overlapping
// skill terms instead of generating prose - honest about being a simpler
// stand-in, not a fake "AI-generated" sentence.
async function generateJustification(resumeText, listing) {
  const skillOverlap = (listing.required_skills || []).filter((skill) =>
    resumeText.toLowerCase().includes(skill.toLowerCase())
  );

  if (!process.env.ANTHROPIC_API_KEY) {
    return skillOverlap.length > 0
      ? `Shares ${skillOverlap.join(", ")} with your resume.`
      : "Matched on overall vocabulary overlap with your resume (no exact skill keywords in common).";
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      max_tokens: 60,
      messages: [
        {
          role: "user",
          content:
            `Resume (excerpt): ${resumeText.slice(0, 800)}\n\n` +
            `Job listing: ${listing.title} at ${listing.company}. ` +
            `Required skills: ${(listing.required_skills || []).join(", ")}. ` +
            `Description: ${(listing.raw_text || "").slice(0, 500)}\n\n` +
            `In ONE short sentence (under 20 words), explain why this listing is or isn't a good match for this resume. Be specific, not generic.`,
        },
      ],
    });
    return response.content[0].text.trim();
  } catch (err) {
    return skillOverlap.length > 0
      ? `Shares ${skillOverlap.join(", ")} with your resume.`
      : "Matched on overall vocabulary overlap with your resume.";
  }
}

module.exports = { generateJustification };
