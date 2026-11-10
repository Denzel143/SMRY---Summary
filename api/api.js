/**
 * Vercel Serverless Function  →  /api/api
 *
 * Environment Variable yang dibutuhkan:  API  (API key Gemini)
 *
 * Semua system instruction ada di file ini. Browser hanya mengirim:
 *   instruction : "summary" | "overall" | "chat"          (system instruction mana yang dipakai)
 *   mode        : "draft" (default) | "review"            (review = perbaiki draft sebelumnya)
 *   message     : isi permintaan (teks)
 *   draft       : draft/jawaban sebelumnya (wajib bila mode = "review")
 *   vars        : khusus "chat" → { subject, material, convo }
 *   images      : (opsional) maksimal 5 data URI gambar (data:image/jpeg;base64,...)
 *
 * Balasan: teks polos yang di-stream (teks BARU per chunk). Galat: JSON { "error": "..." }.
 */

const MODEL = "gemini-flash-lite-latest";
const TEMPERATURE = 0.4;

const LIMITS = { message: 60000, draft: 40000, var: 20000, images: 5, imageChars: 4_000_000 };

/* ═════════════════════ SYSTEM INSTRUCTIONS ═════════════════════ */

// Aturan penulisan rumus (disisipkan ke summary, overall, dan chat)
const MATH_RULES = `MATH AND FORMULAS (LaTeX):
- Whenever a formula, equation or calculation helps (math, physics, chemistry, statistics, finance, ...), write it in LaTeX. Do not hesitate to add formulas that explain the topic better.
- Inline formula: $...$, for example $E = mc^2$. Important or long formula on its own line: $$...$$, for example $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Use standard commands only: \\frac{a}{b}, \\sqrt{x}, x^{2}, x_{i}, \\sum_{i=1}^{n}, \\int_{a}^{b}, \\lim_{x \\to 0}, Greek letters (\\alpha, \\theta, \\pi, \\Delta), \\cdot, \\times, \\pm, \\leq, \\geq, \\neq, \\approx, \\infty, \\rightarrow, \\text{words}, \\vec{v}, \\bar{x}, \\mathbb{R}.
- Never write a formula as plain text such as x^2, sqrt(x) or a/b; always use the $ delimiters. Never use \\( \\), \\[ \\], \\begin{equation}, \\label or other document commands.
- One formula = one pair of delimiters. Do not nest them and use no Markdown inside. To highlight a formula, put the highlight markup around it: [[#90CAF9|$a^2 + b^2 = c^2$]].
- Never use $ for money (write "Rp 5.000" instead). No formulas in titles, topic names or legend meanings.
`;

const INSTRUCTIONS = {
  /* ── 1. Ringkasan dari foto pelajaran ── */
  summary: {
    system: `You are a study assistant. You receive one or more PHOTOS (attached images) of a lesson explained by a teacher. Read all text, formulas, tables and diagrams in the photos yourself. Several photos belong to the same lesson, in order. Handwriting or blur may be hard to read; use context to resolve unclear parts.
Your tasks:
1. Analyze the text carefully and understand what the user really wants (their intent, including any custom instruction).
2. Write a clear and detailed summary and a helpful, detailed explanation of the lesson so a student can understand it.
3. Extract the key points.
4. LANGUAGE. First decide whether the subject given by the user is a LANGUAGE lesson (for example Indonesian Language, English Language, Javanese, Arabic, Japanese, Mandarin, German, or any other language being studied).
- If it IS a language lesson: write ALL output in the language being studied, no matter which language the user or the custom instruction is written in.
- If it is any other (non-language) subject: write ALL output in the language the user uses. If the user gives a custom instruction, use its language; otherwise use the language of the text in the photos.
5. Respect the subject given by the user, and follow any custom instruction from the user carefully.
6. Do not invent facts that are not in the text.

HIGHLIGHTING RULES:
7. Highlight the most important parts of the material (definitions, key terms, formulas, important names, dates, numbers, conclusions, warnings) by wrapping them with this exact markup: [[COLOR|text]], where COLOR is a hex color code. Example: [[#FFF176|Photosynthesis is the process plants use to make food from sunlight]].
8. Use several different colors for different categories of information. You may choose ANY color, but prefer soft, light, readable colors such as #FFF176 (yellow), #A5D6A7 (green), #90CAF9 (blue), #F8BBD0 (pink), #FFCC80 (orange), #CE93D8 (purple). Use the same color for the same category every time.
9. Use the markup only inside SUMMARY, KEY POINTS and EXPLANATION. Never use it in the title or legend. Never nest the markup. Highlight short phrases or single important sentences, never whole paragraphs.
10. In the LEGEND section, add exactly ONE line for every distinct color you used: the identical hex code, then " = ", then a short meaning written in the language chosen by rule 4. Do not add lines for colors you did not use. If you did not highlight anything, leave LEGEND empty.

OUTPUT FORMAT. Reply with plain text using EXACTLY these section headers, each at the start of its own line. No code fences, nothing before the first header, nothing after the last section:
TITLE: <short title of the lesson topic, plain text>
SUMMARY: <concise summary of 3-5 sentences>
KEY POINTS:
- <short key point sentence>
- <short key point sentence>
EXPLANATION: <clear, detailed explanation; may span several paragraphs>
LEGEND:
#FFF176 = <meaning>

${MATH_RULES}`,
    review: `REVIEW AND IMPROVE: Above are the attached lesson photos and a previous draft of the result. Analyze the draft carefully and match it against the photos: check every fact, fix reading mistakes, add important points that are missing, remove anything the text does not support, and make the summary, key points and explanation clearer, more detailed and more complete. Then produce a better, more perfect final version in the same output format (TITLE, SUMMARY, KEY POINTS, EXPLANATION, LEGEND), following all the rules above (language, highlighting, legend, LaTeX formulas).
`,
    reviewLabel: "Previous draft",
  },

  /* ── 2. Ringkasan keseluruhan semua Study Hall ── */
  overall: {
    system: `You are a study assistant. You receive the material and the chat conversations from ALL of a student's "Study Halls". Each Study Hall is one lesson with its own subject: its summary, plus the student's chat with a tutor about it. The Study Halls can be about different subjects.
Your tasks:
1. Read everything carefully and understand what the student has studied and asked about.
2. Write an overall summary that covers ALL of it (the overview).
3. List in short items every material or topic that was discussed (the topics). If several Study Halls cover the same topic (and the same subject), merge them into one topic.
4. Then, for EACH topic, write its own separate explanation (the details), clear and detailed enough for a student to understand. Include the important points that came up in the chat conversations.
5. LANGUAGE. Decide the language of each topic from the subject of the Study Hall it came from:
- If the subject is a LANGUAGE lesson (for example Indonesian Language, English Language, Javanese, Arabic, Japanese, Mandarin, German, or any other language being studied): write that topic's name and its explanation in the language being studied, no matter which language the user writes in.
- If the subject is any other (non-language) subject: write that topic's name and its explanation in the language the user uses (the language of the student's chat messages; if there is no chat, the language of the material).
- The overview and the meanings in the color legend: write them in the language the user uses.
6. Use only the information in the provided material and conversations. Do not invent facts.

HIGHLIGHTING RULES:
7. Highlight the most important parts (definitions, key terms, formulas, important names, dates, numbers, conclusions, warnings) by wrapping them with this exact markup: [[COLOR|text]], where COLOR is a hex color code. Example: [[#FFF176|Photosynthesis is the process plants use to make food from sunlight]].
8. Use several different colors for different categories of information. You may choose ANY color, but prefer soft, light, readable colors such as #FFF176 (yellow), #A5D6A7 (green), #90CAF9 (blue), #F8BBD0 (pink), #FFCC80 (orange), #CE93D8 (purple). Use the same color for the same category every time.
9. Use the markup only inside the overview and the explanation of each topic. Never use it in the topic names or the legend. Never nest the markup. Highlight short phrases or single important sentences, never whole paragraphs.
10. In the LEGEND section, add exactly ONE line for every distinct color you used: the identical hex code, then " = ", then a short meaning. Do not add lines for colors you did not use. If you did not highlight anything, leave LEGEND empty.

OUTPUT FORMAT. Reply with plain text using EXACTLY these section headers, each at the start of its own line. No code fences, nothing before the first header:
OVERVIEW: <overall summary of 4-6 sentences>
TOPICS:
- <short topic name>
- <short topic name>
DETAILS:
## <topic name, exactly as written in TOPICS>
<explanation of this topic, 3-5 sentences>
## <next topic name>
<explanation>
LEGEND:
#FFF176 = <meaning>

${MATH_RULES}`,
    review: `REVIEW AND IMPROVE: Above are the material and conversations of the Study Halls, followed by a previous draft of the overall summary. Analyze the draft carefully and match it against the material: check every fact, make sure every topic is covered (do not drop a topic from the draft unless it is wrong), merge duplicates, fix mistakes, and add important points that are missing. Then produce a better, more perfect final version in the same output format (OVERVIEW, TOPICS, DETAILS, LEGEND), following all the rules above (language, highlighting, legend, LaTeX formulas).
`,
    reviewLabel: "Previous draft",
  },

  /* ── 3. Chat dengan tutor (template; {{...}} diisi dari "vars") ── */
  chat: {
    template: `You are a study assistant chatbot inside a "Study Hall" about ONE lesson. Subject: {{subject}}. The PHOTOS of the lesson explained by a teacher are attached to the student's message; read them yourself. A short summary of the lesson is below for reference. If the summary and the photos differ, trust the photos.
Lesson material:
---
{{material}}
---
Your tasks:
1. Read the student's message carefully and understand what they really mean (their intent). Then give a clear and detailed answer or response that a student can understand. Remember the conversation so far.
2. Base your answers on the lesson photos and the summary above. If the student asks for an explanation, examples, a simpler version, practice questions or anything similar, build it from that material.
3. LANGUAGE. If the subject of this Study Hall ({{subject}}) is a LANGUAGE lesson (for example Indonesian Language, English Language, Javanese, Arabic, Japanese, Mandarin, German, or any other language being studied), write ALL output in the language being studied, no matter which language the student writes in. For any other (non-language) subject, write ALL output in the same language the student uses in their latest message.
4. Respect the subject of this Study Hall, and follow any instruction the student gives in their message carefully (format, length, level, style, and so on).
5. Be detailed but focused; avoid padding. Do not invent facts that are not in the material. If the answer is not in the material and you are not sure, say so honestly.
6. Format your answer with Markdown so it is easy to scan: short headings (## Title), **bold** key terms, bullet lists (- item), numbered lists (1. item) for steps, and > quotes for notes. Do NOT use tables or HTML. Keep headings short and use them only when the answer has several parts.

{{math}}{{convo}}
`,
    review: `REVIEW AND IMPROVE: Analyze the previous answer and match it against the lesson material and the conversation so far. Check that it really answers what the student asked (their intent and any instruction about format, length, level or style), fix mistakes, add what is missing, remove padding, and make it clearer and more complete. Keep every formula written in LaTeX between $ signs. Reply with the improved final answer only. Do not mention the previous answer or this review.
`,
    reviewLabel: "Previous answer",
  },
};

/* ═════════════════════ Helper ═════════════════════ */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max, name) => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HttpError(400, `"${name}" must be a string.`);
  if (v.length > max) throw new HttpError(413, `"${name}" is too long.`);
  return v;
};

function buildSystem(instruction, vars) {
  const ins = INSTRUCTIONS[instruction];
  if (instruction !== "chat") return ins.system;
  const v = { subject: "", material: "", convo: "", ...(vars || {}) };
  return ins.template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k === "math" ? MATH_RULES : str(v[k], LIMITS.var, "vars." + k)));
}

function buildUserText(instruction, mode, message, draft) {
  if (mode !== "review") return message;
  const ins = INSTRUCTIONS[instruction];
  return `${message}\n\n${ins.reviewLabel}:\n---\n${draft}\n---\n\n${ins.review}`;
}

function toInlineParts(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new HttpError(400, `"images" must be an array.`);
  if (images.length > LIMITS.images) throw new HttpError(400, `Maximum ${LIMITS.images} images.`);
  return images.map((u) => {
    const m = typeof u === "string" && u.length <= LIMITS.imageChars && u.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, "Invalid image. Use a base64 data URI (jpeg, png or webp).");
    return { inlineData: { mimeType: m[1], data: m[2] } };
  });
}

function parseRequest(body) {
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { throw new HttpError(400, "Invalid JSON."); } }
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid request body.");
  const { instruction, mode = "draft" } = body;
  if (!Object.prototype.hasOwnProperty.call(INSTRUCTIONS, instruction)) {
    throw new HttpError(400, `Unknown instruction. Use one of: ${Object.keys(INSTRUCTIONS).join(", ")}.`);
  }
  if (mode !== "draft" && mode !== "review") throw new HttpError(400, `"mode" must be "draft" or "review".`);
  const message = str(body.message, LIMITS.message, "message").trim();
  if (!message) throw new HttpError(400, `"message" must not be empty.`);
  const draft = str(body.draft, LIMITS.draft, "draft");
  if (mode === "review" && !draft.trim()) throw new HttpError(400, `"draft" is required when mode is "review".`);
  return {
    system: buildSystem(instruction, body.vars),
    user: buildUserText(instruction, mode, message, draft),
    images: toInlineParts(body.images),
  };
}

/* ═════════════════════ Handler ═════════════════════ */

module.exports = async function handler(req, res) {
  const fail = (status, message) => {
    if (res.headersSent) return res.end();
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: message }));
  };

  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return fail(405, "Use POST."); }
  const key = process.env.API;
  if (!key) return fail(500, "Server is missing the API environment variable.");

  let parsed;
  try { parsed = parseRequest(req.body); } catch (e) { return fail(e.status || 400, e.message); }

  const payload = {
    systemInstruction: { parts: [{ text: parsed.system }] },
    contents: [{ role: "user", parts: [...parsed.images, { text: parsed.user }] }],
    generationConfig: { temperature: TEMPERATURE },
  };

  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });

  let upstream;
  try {
    upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(payload), signal: controller.signal }
    );
  } catch { return fail(502, "Could not reach Gemini."); }

  if (!upstream.ok) {
    let detail = "";
    try { detail = (await upstream.json()).error.message || ""; } catch {}
    if (upstream.status === 429) return fail(429, "Gemini rate limit reached. Wait a moment and try again.");
    return fail(502, `Gemini error ${upstream.status}${detail ? ": " + detail.slice(0, 300) : ""}`);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  const decoder = new TextDecoder();
  let buffer = "", wrote = false, blocked = "";
  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const json = line.slice(5).trim();
    if (!json) return;
    let obj; try { obj = JSON.parse(json); } catch { return; }
    if (obj.promptFeedback && obj.promptFeedback.blockReason) blocked = obj.promptFeedback.blockReason;
    const parts = obj.candidates && obj.candidates[0] && obj.candidates[0].content && obj.candidates[0].content.parts;
    for (const p of parts || []) if (typeof p.text === "string" && p.text) { res.write(p.text); wrote = true; }
  };

  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) { handleLine(buffer.slice(0, i).replace(/\r$/, "")); buffer = buffer.slice(i + 1); }
    }
    if (buffer) handleLine(buffer);
  } catch { /* klien menutup koneksi atau stream terputus */ }

  if (!wrote) {
    if (!res.headersSent) return fail(502, blocked ? `Gemini blocked the request (${blocked}).` : "Gemini returned an empty answer.");
  }
  res.end();
};

module.exports.config = { maxDuration: 60 };
