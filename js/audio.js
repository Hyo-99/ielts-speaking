// Recording (MediaRecorder + live Web Speech transcript) and audio conversion helpers.
import { getSettings } from "./storage.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const hasSpeechRecognition = !!SR;

export class AnswerRecorder {
  constructor() { this.stream = null; }

  async ensureStream() {
    if (!this.stream || this.stream.getTracks().every((t) => t.readyState === "ended")) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    }
    return this.stream;
  }

  async start(onLiveText) {
    const stream = await this.ensureStream();
    this.chunks = [];
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"];
    const mime = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    this.mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.start(1000);
    this.startedAt = performance.now();
    this.finalText = "";
    this.startRecognition(onLiveText);
  }

  startRecognition(onLiveText) {
    this.recActive = false;
    if (!SR) return;
    const r = new SR();
    r.lang = getSettings().recogLang || "en-AU";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) this.finalText += t.trim() + " ";
        else interim += t;
      }
      onLiveText && onLiveText(this.finalText + interim);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") this.recActive = false;
    };
    r.onend = () => { if (this.recActive) { try { r.start(); } catch {} } };
    this.rec = r;
    this.recActive = true;
    try { r.start(); } catch {}
  }

  get elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }

  stop() {
    return new Promise((resolve) => {
      const durationSec = this.elapsed;
      this.recActive = false;
      try { this.rec && this.rec.stop(); } catch {}
      if (!this.mr || this.mr.state === "inactive") {
        resolve({ blob: null, durationSec, liveTranscript: this.finalText.trim() });
        return;
      }
      this.mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mr.mimeType || "audio/webm" });
        // give recognition a moment to flush final results
        setTimeout(() => resolve({ blob, durationSec, liveTranscript: this.finalText.trim() }), 400);
      };
      this.mr.stop();
      this.startedAt = 0;
    });
  }

  release() {
    this.recActive = false;
    try { this.rec && this.rec.abort(); } catch {}
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

// Convert any recorded blob to 16 kHz mono WAV (format accepted by Gemini).
export async function blobToWav(blob, rate = 16000) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const decoded = await ac.decodeAudioData(buf);
  ac.close && ac.close();
  const len = Math.max(1, Math.ceil(decoded.duration * rate));
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), rate);
}

function wavHeader(view, dataBytes, rate) {
  const w = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); w(8, "WAVE");
  w(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, "data"); view.setUint32(40, dataBytes, true);
}

export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  wavHeader(v, samples.length * 2, rate);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Raw 16-bit little-endian PCM (Gemini TTS output) -> WAV blob
export function pcm16ToWav(bytes, rate = 24000) {
  const buf = new ArrayBuffer(44 + bytes.length);
  const v = new DataView(buf);
  wavHeader(v, bytes.length, rate);
  new Uint8Array(buf, 44).set(bytes);
  return new Blob([buf], { type: "audio/wav" });
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let beepCtx;
export function beep(freq = 880, ms = 180) {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = beepCtx.createOscillator(), g = beepCtx.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g); g.connect(beepCtx.destination);
    o.start(); o.stop(beepCtx.currentTime + ms / 1000);
  } catch {}
}

// ---- simple fluency metrics from a transcript ----
const FILLERS = ["um", "uh", "er", "erm", "ah", "hmm", "uhm", "you know", "i mean", "like", "kind of", "sort of"];
export function metrics(text, durationSec) {
  const t = (text || "").toLowerCase();
  const words = t.match(/[a-z']+/g) || [];
  const wpm = durationSec > 3 ? Math.round(words.length / (durationSec / 60)) : 0;
  let fillers = 0;
  for (const f of ["um", "uh", "er", "erm", "ah", "hmm", "uhm"]) fillers += (t.match(new RegExp(`\\b${f}\\b`, "g")) || []).length;
  const soft = {};
  for (const f of FILLERS.slice(7)) { const n = (t.match(new RegExp(`\\b${f}\\b`, "g")) || []).length; if (n) soft[f] = n; }
  const uniq = new Set(words).size;
  return { words: words.length, wpm, fillers, soft, variety: words.length ? Math.round((uniq / words.length) * 100) : 0 };
}
