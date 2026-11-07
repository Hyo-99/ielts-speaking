// Settings in localStorage; sessions, expression bank, audio and TTS cache in IndexedDB.

const SETTINGS_KEY = "ielts-speaking-settings";

export const DEFAULT_SETTINGS = {
  apiKey: "",
  textModel: "gemini-2.5-flash",
  ttsModel: "gemini-2.5-flash-preview-tts",
  ttsEngine: "browser",          // "browser" | "gemini"
  geminiVoice: "Charon",
  browserVoice: "",
  rate: 1.0,
  recogLang: "en-AU",
  aiTranscribe: true,
  targetBand: "8",
  hideQuestionText: true,
};

export function getSettings() {
  try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("ielts-speaking", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("audio");
        d.createObjectStore("tts");
        d.createObjectStore("sessions", { keyPath: "id" });
        d.createObjectStore("bank", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && "onsuccess" in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const idb = {
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  put: (store, val, key) => tx(store, "readwrite", (s) => (key === undefined ? s.put(val) : s.put(val, key))),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  all: (store) => tx(store, "readonly", (s) => s.getAll()),
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- Sessions ----
export async function getSessions() {
  const all = (await idb.all("sessions")) || [];
  return all.sort((a, b) => b.date.localeCompare(a.date));
}
export const getSession = (id) => idb.get("sessions", id);
export const saveSession = (s) => idb.put("sessions", s);
export async function deleteSession(id) {
  const s = await getSession(id);
  if (s) for (const a of s.answers) {
    if (a.audioKey) await idb.del("audio", a.audioKey);
    for (const r of a.rounds || []) if (r.audioKey) await idb.del("audio", r.audioKey);
  }
  await idb.del("sessions", id);
}

// ---- Expression bank (Leitner boxes) ----
export const INTERVAL_DAYS = [0, 1, 2, 4, 8, 16, 32];

export async function getBank() {
  return ((await idb.all("bank")) || []).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}
export async function addToBank(items, source) {
  const bank = await getBank();
  const seen = new Set(bank.map((b) => norm(b.expression)));
  let added = 0;
  for (const it of items || []) {
    if (!it.expression || seen.has(norm(it.expression))) continue;
    seen.add(norm(it.expression));
    await idb.put("bank", {
      id: uid(), ...it, source: source || "",
      addedAt: new Date().toISOString(), box: 0, due: new Date().toISOString(),
    });
    added++;
  }
  return added;
}
export const norm = (s) => (s || "").toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim();
export const saveBankItem = (it) => idb.put("bank", it);
export const deleteBankItem = (id) => idb.del("bank", id);

// ---- Backup ----
export async function exportAll() {
  return { version: 1, exportedAt: new Date().toISOString(), sessions: await getSessions(), bank: await getBank() };
}
export async function importAll(data) {
  let n = 0;
  for (const s of data.sessions || []) { await saveSession(s); n++; }
  for (const b of data.bank || []) { await saveBankItem(b); n++; }
  return n;
}
