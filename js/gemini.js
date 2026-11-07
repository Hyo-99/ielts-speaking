// Gemini API calls (directly from the browser with the user's own key).
import { getSettings } from "./storage.js";
import { base64ToBytes, pcm16ToWav, blobToBase64 } from "./audio.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const modelName = (m) => String(m || "").replace(/^models\//, "").trim();

export const hasKey = () => !!getSettings().apiKey;

async function call(model, body, onStatus) {
  const key = getSettings().apiKey;
  if (!key) throw new Error("설정에서 Gemini API 키를 먼저 입력해 주세요.");
  const waits = [15000, 30000, 45000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(BASE + encodeURIComponent(modelName(model)) + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt < waits.length) { onStatus && onStatus("네트워크 오류, 다시 시도 중…"); await sleep(5000); continue; }
      throw new Error("네트워크 오류: " + e.message);
    }
    if (res.ok) return res.json();
    const txt = await res.text();
    let msg = txt;
    try { msg = JSON.parse(txt).error.message; } catch {}
    if ([429, 500, 503].includes(res.status) && attempt < waits.length) {
      onStatus && onStatus(`요청 한도/서버 혼잡(${res.status}) → ${waits[attempt] / 1000}초 후 다시 시도`);
      await sleep(waits[attempt]);
      continue;
    }
    if (res.status === 400 && /API key/i.test(msg)) throw new Error("API 키가 올바르지 않아요. 설정에서 확인해 주세요.");
    if (res.status === 404) throw new Error(`모델 "${modelName(model)}"을 찾을 수 없어요. 설정에서 모델 이름을 확인해 주세요. (${msg})`);
    throw new Error(`Gemini 오류 ${res.status}: ${msg}`);
  }
}

const textOf = (json) => (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");

function parseJSON(t) {
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  throw new Error("AI 응답을 해석하지 못했어요. 다시 시도해 주세요.");
}

// ---------- Analysis (transcribe + correct + extract expressions + feedback) ----------
const S = { type: "STRING" }, N = { type: "NUMBER" };
const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcript: S,
    corrected: S,
    changes: { type: "ARRAY", items: { type: "OBJECT", properties: { original: S, improved: S, reason_ko: S }, required: ["original", "improved", "reason_ko"] } },
    expressions: { type: "ARRAY", items: { type: "OBJECT", properties: {
      expression: S, type: S, meaning_ko: S, nuance_ko: S, stress: S, ipa: S, replaces: S, example: S, register: S },
      required: ["expression", "type", "meaning_ko", "stress", "ipa", "example"] } },
    feedback: { type: "OBJECT", properties: { fluency_ko: S, lexical_ko: S, grammar_ko: S, pronunciation_ko: S } },
    bands: { type: "OBJECT", properties: { fluency: N, lexical: N, grammar: N, pronunciation: N, overall: N } },
    progress_ko: S,
    tips_ko: S,
  },
  required: ["transcript", "corrected", "changes", "expressions", "feedback", "bands", "tips_ko"],
};

const LENGTH_GUIDE = {
  1: "Part 1 answers should be about 3–5 natural sentences (20–40 seconds when spoken).",
  2: "Part 2 is a long turn: about 230–300 words (roughly 2 minutes when spoken), with a clear flow through the cue card points.",
  3: "Part 3 answers should be about 5–8 sentences (45–70 seconds): an opinion, a reason, an example or contrast, and a short wrap-up.",
};

function systemPrompt(band) {
  return `You are a senior IELTS Speaking examiner and an Australian English speaking coach.
The learner is a Korean native speaker preparing for IELTS Speaking. Their goal is to be able to say exactly what THEY want to say, the way a highly articulate native speaker would in natural conversation.

Your job:
1. TRANSCRIPT: If audio is provided, transcribe it VERBATIM: keep fillers (um, uh, er), false starts, repetitions, self-corrections and grammar mistakes. Do NOT clean it up. Mark unclear words as [inaudible]. If no audio is provided, copy the given transcript.
2. CORRECTED: Rewrite the answer as a Band ${band}+ native speaker would SAY it out loud in the exam.
   - Keep the learner's own ideas, opinions, examples and personal details. Do not replace their content with a different answer; you may add a short linking phrase or a natural elaboration that follows from what they said.
   - Spoken register: contractions, natural discourse markers ("To be honest", "The thing is", "Mind you"), idiomatic language and phrasal verbs. Colloquial is fine; it must sound spoken, not like an essay.
   - Lexical upgrade: use precise, less common vocabulary, strong collocations and idioms where they genuinely fit. Natural > fancy. No forced or outdated idioms.
   - Grammar must be fully accurate and show natural range (conditionals, relative clauses, modals of speculation, passives, cleft sentences) where it fits.
   - Australian English spelling (e.g. "colour", "organise").
   - Plain text only, no markdown, no bullet points.
3. CHANGES: 4–10 of the most instructive edits. "original" = learner's words (short span), "improved" = your version, "reason_ko" = why, in Korean.
4. EXPRESSIONS: Extract 6–12 of the most valuable, reusable expressions you used in CORRECTED (chunks, collocations, idioms, phrasal verbs, discourse markers, advanced words). Prefer multi-word chunks the learner can reuse in other topics. For each:
   - expression: exactly as it can be reused (generalise pronouns, e.g. "it dawned on me that…" or "be torn between A and B")
   - type: one of chunk | collocation | idiom | phrasal verb | discourse marker | vocabulary
   - meaning_ko: concise Korean meaning
   - nuance_ko: when/how to use it, register, common mistakes (Korean, 1 sentence)
   - stress: the expression with the STRESSED syllables in CAPITALS, e.g. "it DAWNED on me", "in reTROspect", "a BLESSing in disGUISE"
   - ipa: IPA of the whole expression (Australian/British-style, non-rhotic)
   - replaces: what the learner originally said instead (empty string if nothing)
   - example: one NEW natural example sentence on a different topic
   - register: casual | neutral | formal
5. FEEDBACK (Korean, easy enough for a high-school student, specific and encouraging but honest): fluency_ko, lexical_ko, grammar_ko, pronunciation_ko (only judge pronunciation if audio was provided; otherwise say it could not be judged).
6. BANDS: estimate IELTS bands (0–9 in 0.5 steps) for fluency (Fluency & Coherence), lexical (Lexical Resource), grammar (Grammatical Range & Accuracy), pronunciation (0 if no audio), overall.
7. TIPS_KO: the 1–2 most important things to practise next, in Korean.
All *_ko fields must be in Korean. Everything else in English.`;
}

export async function analyzeAnswer({ part, question, cueCard, transcript, wavBlob, rounds }, onStatus) {
  const s = getSettings();
  const parts = [];
  let task = `IELTS Speaking Part ${part}.\n`;
  task += cueCard ? `Cue card:\n${cueCard}\n` : `Question: ${question}\n`;
  task += LENGTH_GUIDE[part] + "\n";
  if (rounds && rounds.length) {
    task += `\nThe learner did the 4-3-2 fluency technique: the same talk three times in 4, 3 and 2 minutes.\n`;
    rounds.forEach((r, i) => { task += `\nRound ${i + 1} (${Math.round(r.durationSec)} s, ${r.wpm} wpm):\n${r.transcript || "(empty)"}\n`; });
    task += `\nFor TRANSCRIPT, copy the Round 3 transcript. Base CORRECTED on the best ideas from all three rounds, written as an ideal 2-minute answer. Also fill progress_ko: in Korean, compare the three rounds (speed, hesitation, whether content stayed complete, which phrases became more automatic).`;
  } else if (wavBlob) {
    parts.push({ inlineData: { mimeType: "audio/wav", data: await blobToBase64(wavBlob) } });
    task += `\nThe learner's spoken answer is in the attached audio.`;
    if (transcript) task += ` (A rough browser transcript, which may contain errors, for reference: "${transcript}")`;
  } else {
    task += `\nThe learner's answer (browser speech recognition, may contain recognition errors; fillers may be missing):\n"${transcript || ""}"`;
  }
  parts.push({ text: task });

  const json = await call(s.textModel, {
    systemInstruction: { parts: [{ text: systemPrompt(s.targetBand) }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: ANALYSIS_SCHEMA, temperature: 0.6 },
  }, onStatus);
  return parseJSON(textOf(json));
}

export async function transcribe(wavBlob, onStatus) {
  const s = getSettings();
  const json = await call(s.textModel, {
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "audio/wav", data: await blobToBase64(wavBlob) } },
      { text: "Transcribe this English speech verbatim. Keep fillers (um, uh), repetitions, false starts and grammar mistakes exactly as spoken. Output only the transcript as plain text." },
    ] }],
    generationConfig: { temperature: 0 },
  }, onStatus);
  return textOf(json).trim();
}

export async function generateCueCard(hint) {
  const s = getSettings();
  const json = await call(s.textModel, {
    contents: [{ role: "user", parts: [{ text:
      `Write one NEW, original IELTS Speaking Part 2 cue card in the usual style${hint ? ` about: ${hint}` : ""}, plus 5 related Part 3 discussion questions. ` +
      `Return JSON: {"theme": short noun phrase for "We've been talking about ___", "cue": "Describe ...", "bullets": [3 items, lowercase, no "You should say"], "explain": "and explain ...", "part3": [5 questions]}` }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 1.0 },
  });
  const c = parseJSON(textOf(json));
  return { id: "ai-" + Date.now().toString(36), ...c };
}

export async function testKey() {
  const s = getSettings();
  const json = await call(s.textModel, { contents: [{ role: "user", parts: [{ text: "Reply with the single word: ready" }] }] });
  return textOf(json).trim();
}

// ---------- TTS ----------
export async function geminiTTS(text) {
  const s = getSettings();
  const json = await call(s.ttsModel, {
    contents: [{ role: "user", parts: [{ text:
      `Read the following aloud in a natural, warm Australian English accent, like a friendly IELTS examiner from Sydney, at a natural conversational pace:\n\n${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.geminiVoice || "Charon" } } },
    },
  });
  const part = (json?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error("음성 데이터를 받지 못했어요.");
  const rate = Number((part.inlineData.mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
  return pcm16ToWav(base64ToBytes(part.inlineData.data), rate);
}
