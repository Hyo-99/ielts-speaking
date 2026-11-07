// Text-to-speech: browser voices (free, offline) or Gemini TTS (more natural), with caching.
import { getSettings, idb } from "./storage.js";
import { geminiTTS } from "./gemini.js";
import { encodeWav } from "./audio.js";

// One reusable <audio> element, unlocked by a user gesture (needed for Safari autoplay rules).
const player = new Audio();
let audioEl = null;
let silentUrl = null;

export function unlockAudio() {
  try {
    if (!silentUrl) silentUrl = URL.createObjectURL(encodeWav(new Float32Array(800), 16000));
    player.src = silentUrl;
    player.play().catch(() => {});
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {}
}
let token = 0;
let pendingResolve = null;

export function voices() {
  if (!("speechSynthesis" in window)) return [];
  return speechSynthesis.getVoices()
    .filter((v) => /^en[-_]/i.test(v.lang))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
const score = (v) => (/AU/i.test(v.lang) ? 10 : 0) + (/premium|enhanced|natural/i.test(v.name) ? 2 : 0);

export function onVoicesReady(cb) {
  if (!("speechSynthesis" in window)) return;
  if (speechSynthesis.getVoices().length) cb();
  speechSynthesis.addEventListener?.("voiceschanged", cb);
}

function pickVoice() {
  const s = getSettings();
  const vs = voices();
  return vs.find((v) => v.voiceURI === s.browserVoice) || vs.find((v) => /AU/i.test(v.lang)) || vs[0];
}

export function stopSpeaking() {
  token++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (audioEl) { audioEl.pause(); audioEl = null; }
  if (pendingResolve) { pendingResolve(); pendingResolve = null; }
}

function speakBrowser(text, rate, my) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    pendingResolve = resolve;
    // Chunk by sentence: avoids Chrome cutting off long utterances.
    const chunks = (text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text]).map((c) => c.trim()).filter(Boolean);
    const v = pickVoice();
    let i = 0;
    const next = () => {
      if (my !== token) return;
      if (i >= chunks.length) { pendingResolve = null; return resolve(); }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-AU";
      u.rate = rate;
      // Safety net: some browsers occasionally never fire onend.
      let fired = false;
      const go = () => { if (fired) return; fired = true; clearTimeout(guard); next(); };
      const guard = setTimeout(go, (3000 + u.text.split(/\s+/).length * 600) / rate);
      u.onend = go;
      u.onerror = go;
      speechSynthesis.speak(u);
    };
    next();
  });
}

async function hashKey(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getGeminiAudio(text) {
  const s = getSettings();
  const key = await hashKey(`${s.ttsModel}|${s.geminiVoice}|${text}`);
  let blob = await idb.get("tts", key).catch(() => null);
  if (!blob) { blob = await geminiTTS(text); await idb.put("tts", blob, key).catch(() => {}); }
  return blob;
}

// Speak and resolve when finished (or when stopped).
export async function speak(text, { rate } = {}) {
  stopSpeaking();
  const my = token;
  const s = getSettings();
  const r = rate || Number(s.rate) || 1;
  if (s.ttsEngine === "gemini" && s.apiKey) {
    try {
      const blob = await getGeminiAudio(text);
      if (my !== token) return;
      await new Promise((resolve) => {
        pendingResolve = resolve;
        if (player.src && player.src.startsWith("blob:") && player.src !== silentUrl) URL.revokeObjectURL(player.src);
        audioEl = player;
        audioEl.src = URL.createObjectURL(blob);
        audioEl.playbackRate = r;
        audioEl.onended = () => { pendingResolve = null; resolve(); };
        audioEl.onerror = () => { pendingResolve = null; resolve(); };
        audioEl.play().catch(() => { pendingResolve = null; resolve(); });
      });
      return;
    } catch (e) {
      console.warn("Gemini TTS failed, falling back to browser voice:", e);
      window.dispatchEvent(new CustomEvent("toast", { detail: "Gemini 음성 실패 → 브라우저 음성으로 읽어요: " + e.message }));
      if (my !== token) return;
    }
  }
  await speakBrowser(text, r, my);
}
