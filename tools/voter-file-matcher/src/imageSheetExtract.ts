import * as XLSX from "xlsx";

type VisionSigner = {
  printed_first_name?: string;
  printed_last_name?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip?: string;
  birth_month?: string | number;
  birth_day?: string | number;
  birth_year?: string | number;
  date_signed?: string;
  notes?: string;
};

/**
 * Uses OpenAI vision (server-side only) to read a handwritten / photo petition sheet
 * and build an in-memory XLSX buffer compatible with petition-mail-list-share-v1 (Sheet1).
 */
export async function imageBufferToPetitionMailXlsx(imageBase64: string, mimeType: string): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set. Image conversion requires server-side OpenAI access.");
  }

  const model = process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4o-mini";

  const system =
    "You extract structured signer rows from photos of petition signature collection sheets. " +
    "Reply with compact JSON only.";

  const userText = `Extract every signer row you can read from this image.

Return JSON: { "signers": [ { "printed_first_name", "printed_last_name", "street_address", "city", "state" (2-letter US), "zip" (5 digits preferred), "birth_month" (1-12), "birth_day" (1-31), "birth_year" (4 digits), "date_signed" (YYYY-MM-DD if visible), "notes" } ] }

Rules:
- Use empty string for fields you cannot read. Do not guess names or addresses.
- If the page has no legible signers, return { "signers": [] }.
- One object per visible signer row / line on the sheet.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI vision request failed (${res.status}). ${t.slice(0, 240)}`);
  }

  const raw = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = raw.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI returned an empty response.");
  }

  let parsed: { signers?: VisionSigner[] };
  try {
    parsed = JSON.parse(content) as { signers?: VisionSigner[] };
  } catch {
    throw new Error("OpenAI returned non-JSON content.");
  }

  const signers = Array.isArray(parsed.signers) ? parsed.signers : [];

  /** Header row aligned with Petition Mail List Share expectations (address column uses alias). */
  const headers = [
    "PRINTED FIRST NAME",
    "PRINTED LAST NAME",
    "BIRTH MONTH",
    "BIRTH DAY",
    "BIRTH YEAR",
    "STREET ADDRESS",
    "CITY",
    "STATE",
    "ZIPCODE",
    "DATE SIGNED",
    "NOTES",
  ];

  const rows: string[][] = [headers];
  for (const s of signers) {
    const str = (v: string | number | undefined) => (v == null ? "" : String(v).trim());
    rows.push([
      str(s.printed_first_name),
      str(s.printed_last_name),
      str(s.birth_month),
      str(s.birth_day),
      str(s.birth_year),
      str(s.street_address),
      str(s.city),
      str(s.state).toUpperCase().slice(0, 2),
      str(s.zip).replace(/\D/g, "").slice(0, 10),
      str(s.date_signed),
      str(s.notes),
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const out = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as Uint8Array);
}
