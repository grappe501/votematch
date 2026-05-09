import OpenAI from "openai";
import type { OcrPetitionExtractionResult, PetitionOcrContext } from "./ocrTypes.js";
import { parseOcrExtractionJson } from "./ocrTypes.js";

export async function extractPetitionRowsFromImage(opts: {
  imageBuffer: Buffer;
  mimeType: "image/jpeg" | "image/png";
  model: string;
  petitionContext: PetitionOcrContext;
}): Promise<OcrPetitionExtractionResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY is not configured (required for OCR image intake).");
  }
  const model = opts.model?.trim();
  if (!model) {
    throw new Error("OPENAI_OCR_MODEL is not configured (required for OCR image intake).");
  }

  const client = new OpenAI({ apiKey: key });
  const mediaType = opts.mimeType === "image/png" ? "image/png" : "image/jpeg";

  const system = `You extract visible petition signer rows from a single sheet image. Respond with JSON only (no markdown).
Schema:
- document_type: must be exactly "petition_signature_page"
- overall_confidence_pct: integer 0-100 for whole-page legibility
- warnings: string[] (legibility issues only; never echo secrets)
- rows: array of row objects

Row fields (use null when unknown; never invent data):
- row_number (integer, 1-based order on page)
- extraction_confidence_pct (integer 0-100; OCR certainty only, not legal or voter-match confidence)
- first_name, last_name, full_name, birth_month, birth_day, birth_year, address, city, state, zip, signed_at, notes (strings or null)
- uncertain_fields: string[] of field keys you are unsure about
- raw_line_text: optional string of raw visible line if helpful

Rules:
- Do not guess missing names or addresses.
- Preserve spelling as printed.
- If unclear, add the field key to uncertain_fields.
- Human review is mandatory before any voter file matching.
- Do not decide legal sufficiency.`;

  const userText = `Petition code: ${opts.petitionContext.petition_code}
${opts.petitionContext.petition_name ? `Petition name: ${opts.petitionContext.petition_name}\n` : ""}
Return one JSON object with keys document_type, overall_confidence_pct, warnings, rows.`;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          {
            type: "image_url",
            image_url: { url: `data:${mediaType};base64,${opts.imageBuffer.toString("base64")}` },
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 8192,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content?.trim()) {
    throw new Error("OpenAI returned empty OCR content.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("OpenAI OCR response was not valid JSON.");
  }

  const out = parseOcrExtractionJson(parsed);
  if (!out) {
    throw new Error("OpenAI OCR JSON failed local schema validation.");
  }
  return out;
}
