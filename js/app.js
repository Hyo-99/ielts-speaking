import { PART1, PART2, SCRIPT, cueCardText, shuffle } from "./questions.js";
import {
  getSettings, saveSettings, idb, uid, getSessions, getSession, saveSession, deleteSession,
  getBank, addToBank, saveBankItem, deleteBankItem, INTERVAL_DAYS, exportAll, importAll,
} from "./storage.js";
import { AnswerRecorder, hasSpeechRecognition, blobToWav, beep, metrics } from "./audio.js";
import { analyzeAnswer, transcribe, generateCueCard, testKey, hasKey } from "./gemini.js";
import { speak, stopSpeaking, voices, onVoicesReady, unlockAudio } from "./tts.js";

// ---------------- helpers ----------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (sec) => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; };
const main = $("#main");
const recorder = new AnswerRecorder();
const ABORT = new Error("aborted");
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const MODE_LABEL = { mock: "실전 모의고사", practice: "파트별 연습", "432": "4-3-2 연습" };

function toast(msg, ms = 4500) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), ms);
}
window.addEventListener("toast", (e) => toast(e.detail));

// Render "it DAWNED on me" with stressed syllables highlighted
const stressHtml = (s) => esc(s).replace(/[A-Z]{2,}/g, (m) => `<strong class="st">${m}</strong>`);

// ---------------- runner (abortable exam flow) ----------------
let runner = null;
class Runner {
  constructor() { this.aborted = false; this.cleanups = []; }
  check() { if (this.aborted) throw ABORT; }
  abort() {
    this.aborted = true;
    this.cleanups.splice(0).forEach((f) => { try { f(); } catch {} });
    stopSpeaking();
  }
  wait(ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      this.cleanups.push(() => { clearTimeout(t); rej(ABORT); });
    });
  }
  // Resolve when button clicked or maxSec elapses. onTick(elapsedSec)
  waitDone(btn, maxSec, onTick) {
    return new Promise((res, rej) => {
      const start = performance.now();
      let iv;
      const finish = (why) => { clearInterval(iv); btn.removeEventListener("click", onClick); res(why); };
      const onClick = () => finish("click");
      iv = setInterval(() => {
        const el = (performance.now() - start) / 1000;
        onTick && onTick(el);
        if (maxSec && el >= maxSec) finish("time");
      }, 200);
      btn.addEventListener("click", onClick);
      this.cleanups.push(() => { clearInterval(iv); btn.removeEventListener("click", onClick); rej(ABORT); });
    });
  }
}
function startRunner() { stopRunner(); runner = new Runner(); return runner; }
function stopRunner() {
  if (runner) { runner.abort(); runner = null; }
  stopSpeaking();
  if (recorder.mr && recorder.mr.state !== "inactive") recorder.stop();
  recorder.release();
}

// ---------------- exam UI ----------------
function examUI(container) {
  const s = getSettings();
  container.innerHTML = `
    <div class="exam">
      <div class="exam-head">
        <span class="pill" id="ex-part">Part 1</span>
        <span id="ex-progress" class="muted"></span>
        <button class="btn ghost small" id="ex-quit">그만하기</button>
      </div>
      <div class="examiner">
        <div class="avatar" aria-hidden="true">🇦🇺</div>
        <div class="bubble">
          <div class="who">Examiner</div>
          <div id="ex-say" class="say"></div>
          <div class="bubble-actions">
            <button class="btn ghost small" id="ex-replay">🔁 다시 듣기</button>
            <button class="btn ghost small" id="ex-skip">⏭ 음성 건너뛰기</button>
            ${s.hideQuestionText ? `<span class="muted small">질문 글자는 가려져 있어요 (클릭하면 보임)</span>` : ""}
          </div>
        </div>
      </div>
      <pre id="ex-card" class="cuecard hidden"></pre>
      <textarea id="ex-notes" class="notes hidden" placeholder="메모 (실제 시험처럼 키워드만 짧게)"></textarea>
      <div class="rec-panel">
        <div class="rec-row">
          <span class="rec-dot" id="ex-dot"></span>
          <span id="ex-timer" class="timer">0:00</span>
          <span id="ex-status" class="muted"></span>
        </div>
        <div id="ex-live" class="live"></div>
        <button class="btn primary big" id="ex-done" disabled>답변 끝 → 다음</button>
      </div>
    </div>`;
  const q = (x) => $(x, container);
  let last = "";
  const ui = {
    done: q("#ex-done"),
    part: (t) => (q("#ex-part").textContent = t),
    progress: (t) => (q("#ex-progress").textContent = t),
    say(text, isQuestion) {
      last = text;
      const el = q("#ex-say");
      el.textContent = text;
      el.classList.toggle("blur", !!(isQuestion && getSettings().hideQuestionText));
    },
    card(c) { const el = q("#ex-card"); el.classList.toggle("hidden", !c); el.textContent = c || ""; },
    notes(show) { q("#ex-notes").classList.toggle("hidden", !show); },
    timer(t) { q("#ex-timer").textContent = t; },
    status(t) { q("#ex-status").textContent = t; },
    live(t) { q("#ex-live").textContent = t; },
    recording(on, label) {
      q("#ex-dot").classList.toggle("on", on);
      ui.done.disabled = !on;
      if (label) ui.done.textContent = label;
      if (!on) ui.live("");
    },
    lastSpoken: () => last,
  };
  q("#ex-say").addEventListener("click", (e) => e.currentTarget.classList.remove("blur"));
  q("#ex-skip").addEventListener("click", () => stopSpeaking());
  q("#ex-replay").addEventListener("click", async () => {
    const rec = recorder.mr && recorder.mr.state === "recording";
    if (rec) recorder.mr.pause();
    await speak(last);
    if (rec && recorder.mr.state === "paused") recorder.mr.resume();
  });
  return ui;
}

async function say(R, ui, text, isQuestion = false) {
  ui.say(text, isQuestion);
  ui.status("🔊 듣는 중…");
  await speak(text);
  R.check();
  ui.status("");
}

// Record one answer. Returns an answer object (audio saved in IndexedDB).
async function recordAnswer(R, ui, { part, question, cueCard, maxSec, hint, label = "답변 끝 → 다음", countdown = false }) {
  beep(880, 150);
  await recorder.start((t) => ui.live(t));
  R.cleanups.push(() => { if (recorder.mr && recorder.mr.state !== "inactive") recorder.stop(); });
  ui.recording(true, label);
  ui.status(hint || "🎙 녹음 중");
  await R.waitDone(ui.done, maxSec, (el) => {
    ui.timer(countdown ? fmt(maxSec - el) : `${fmt(el)}${maxSec ? " / " + fmt(maxSec) : ""}`);
    if (part === 2 && !countdown && el > 60 && el < 61) ui.status("1분 지났어요. 2분까지 계속 이어가 보세요.");
  });
  const res = await recorder.stop();
  ui.recording(false);
  ui.timer("0:00");
  let audioKey = null;
  if (res.blob && res.blob.size) { audioKey = uid(); await idb.put("audio", res.blob, audioKey); }
  return {
    id: uid(), part, question, cueCard: cueCard || "", durationSec: res.durationSec,
    liveTranscript: res.liveTranscript, audioKey, status: "pending",
  };
}

async function prepTime(R, ui, card, sec = 60) {
  if (card) ui.card(cueCardText(card));
  ui.notes(true);
  ui.done.disabled = false;
  ui.done.textContent = "준비 끝 → 말하기 시작";
  ui.status("📝 준비 시간 (1분)");
  await R.waitDone(ui.done, sec, (el) => ui.timer(fmt(sec - el)));
  ui.done.disabled = true;
}

async function ensureMic(container) {
  try { await recorder.ensureStream(); return true; }
  catch (e) {
    container.innerHTML = `<div class="card warn"><h3>마이크를 쓸 수 없어요</h3>
      <p>브라우저 주소창 왼쪽의 자물쇠/설정 아이콘에서 마이크 권한을 허용한 뒤 다시 시도해 주세요.</p>
      <p class="muted small">${esc(e.message)}</p></div>`;
    return false;
  }
}

// ---------------- AI processing queue ----------------
let queue = Promise.resolve();
const queued = new Set();

// Serialise read-modify-write of sessions so concurrent updates don't overwrite each other.
let lock = Promise.resolve();
function withLock(fn) { const p = lock.then(fn); lock = p.catch(() => {}); return p; }

function updateAnswer(sid, aid, patch) { return withLock(() => updateAnswerNow(sid, aid, patch)); }
async function updateAnswerNow(sid, aid, patch) {
  const s = await getSession(sid);
  if (!s) return;
  const a = s.answers.find((x) => x.id === aid);
  if (!a) return;
  Object.assign(a, patch);
  await saveSession(s);
  window.dispatchEvent(new CustomEvent("answer-updated", { detail: { sid, aid, answer: a } }));
}

function enqueue(sid, aid) {
  const k = sid + "/" + aid;
  if (queued.has(k)) return;
  queued.add(k);
  const marked = updateAnswer(sid, aid, { status: "queued", statusMsg: "교정 대기 중…" });
  queue = queue.then(() => marked).then(() => processOne(sid, aid)).catch((e) => console.error(e)).finally(() => queued.delete(k));
}

async function processOne(sid, aid) {
  const s = await getSession(sid);
  const a = s?.answers.find((x) => x.id === aid);
  if (!a) return;
  if (!hasKey()) { await updateAnswer(sid, aid, { status: "nokey", statusMsg: "" }); return; }
  const set = getSettings();
  const status = (m) => updateAnswer(sid, aid, { statusMsg: m });
  try {
    await updateAnswer(sid, aid, { status: "working", statusMsg: "AI가 답변을 듣고 교정하는 중… (보통 10~40초)" });
    let analysis;
    if (a.rounds) {
      const rounds = a.rounds.map((r) => ({ ...r }));
      for (let i = 0; i < rounds.length; i++) {
        const r = rounds[i];
        if (set.aiTranscribe && r.audioKey && !r.aiTranscript) {
          await status(`Round ${i + 1} 받아쓰는 중…`);
          const blob = await idb.get("audio", r.audioKey);
          if (blob) r.aiTranscript = await transcribe(await blobToWav(blob), status);
        }
        r.transcript = r.aiTranscript || r.liveTranscript || "";
        r.wpm = metrics(r.transcript, r.durationSec).wpm;
      }
      await updateAnswer(sid, aid, { rounds });
      await status("세 번의 답변을 비교하고 교정하는 중…");
      analysis = await analyzeAnswer({ part: 2, cueCard: a.cueCard, rounds }, status);
    } else {
      let wav = null;
      if (set.aiTranscribe && a.audioKey) {
        const blob = await idb.get("audio", a.audioKey);
        if (blob) wav = await blobToWav(blob);
      }
      analysis = await analyzeAnswer({ part: a.part, question: a.question, cueCard: a.cueCard, transcript: a.liveTranscript, wavBlob: wav }, status);
    }
    const source = a.cueCard ? a.cueCard.split("\n")[0] : a.question;
    const added = await addToBank((analysis.expressions || []).map((e) => ({ ...e, sourceQuestion: source, sessionId: sid })), sid);
    await updateAnswer(sid, aid, { status: "done", analysis, statusMsg: "", bankAdded: added, error: "" });
  } catch (e) {
    await updateAnswer(sid, aid, { status: "error", error: e.message, statusMsg: "" });
  }
}

function processSession(s) {
  for (const a of s.answers) if (a.status !== "done") enqueue(s.id, a.id);
}

// ---------------- answer card ----------------
function diffWords(a, b) {
  const A = (a || "").split(/\s+/).filter(Boolean), B = (b || "").split(/\s+/).filter(Boolean);
  const n = A.length, m = B.length;
  if (!n || n * m > 600000) return esc(b);
  const k = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * (m + 1) + j] = k(A[i]) === k(B[j]) ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  const out = []; let i = 0, j = 0;
  const push = (t, w) => { const l = out[out.length - 1]; if (l && l.t === t) l.w.push(w); else out.push({ t, w: [w] }); };
  while (i < n && j < m) {
    if (k(A[i]) === k(B[j])) { push("s", B[j]); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) push("d", A[i++]);
    else push("i", B[j++]);
  }
  while (i < n) push("d", A[i++]);
  while (j < m) push("i", B[j++]);
  return out.map((o) => { const t = esc(o.w.join(" ")); return o.t === "s" ? t : o.t === "d" ? `<del>${t}</del>` : `<ins>${t}</ins>`; }).join(" ");
}

const sentences = (t) => (t.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [t]).map((x) => x.trim()).filter(Boolean);

function metricChips(text, dur) {
  const m = metrics(text, dur);
  const soft = Object.entries(m.soft).map(([k, v]) => `${k}×${v}`).join(", ");
  return `<span class="chip">⏱ ${fmt(dur)}</span>
    <span class="chip" title="분당 단어 수. 자연스러운 원어민 대화는 대략 130~170">🏃 ${m.wpm} WPM</span>
    <span class="chip" title="um, uh, er 등">🤔 군말 ${m.fillers}</span>
    ${soft ? `<span class="chip" title="말버릇처럼 자주 쓴 표현">🔁 ${esc(soft)}</span>` : ""}
    <span class="chip" title="서로 다른 단어 비율">📚 다양성 ${m.variety}%</span>`;
}

function exprCard(e) {
  return `<div class="expr">
    <div class="expr-top"><b>${esc(e.expression)}</b> <span class="type">${esc(e.type || "")}</span>
      <button class="icon" data-say="${esc(e.expression)}" title="듣기">🔊</button></div>
    <div class="stress">${stressHtml(e.stress || "")} <span class="ipa">/${esc((e.ipa || "").replace(/^\/|\/$/g, ""))}/</span></div>
    <div class="meaning">${esc(e.meaning_ko)}</div>
    ${e.nuance_ko ? `<div class="nuance">💡 ${esc(e.nuance_ko)}</div>` : ""}
    ${e.replaces ? `<div class="replaces">내가 한 말: <span>${esc(e.replaces)}</span></div>` : ""}
    <div class="example">예) ${esc(e.example)} <button class="icon" data-say="${esc(e.example)}" title="듣기">🔊</button></div>
  </div>`;
}

function bandsHtml(b, hasAudio) {
  if (!b) return "";
  const cell = (label, v) => `<div class="band"><div class="band-v">${v ? Number(v).toFixed(1) : "–"}</div><div class="band-l">${label}</div></div>`;
  return `<div class="bands">${cell("Overall", b.overall)}${cell("Fluency", b.fluency)}${cell("Lexical", b.lexical)}${cell("Grammar", b.grammar)}${cell("Pronunciation", hasAudio ? b.pronunciation : 0)}</div>
    <p class="muted small">AI가 추정한 점수예요. 실제 시험 채점과 다를 수 있으니 변화 추이를 보는 용도로 쓰세요.</p>`;
}

function answerCard(a, { practice = false } = {}) {
  const an = a.analysis;
  const head = `<header><span class="pill">Part ${a.part}</span>${a.rounds ? `<span class="pill alt">4-3-2</span>` : ""}
    <h3>${esc(a.cueCard ? a.cueCard.split("\n")[0] : a.question)}</h3>
    <button class="icon" data-say="${esc(a.cueCard ? a.cueCard.split("\n")[0] : a.question)}" title="질문 듣기">🔊</button></header>
    ${a.cueCard ? `<details><summary>큐카드 보기</summary><pre class="cuecard">${esc(a.cueCard)}</pre></details>` : ""}`;

  let rec = "";
  if (a.rounds) {
    rec = `<table class="rounds"><tr><th>Round</th><th>시간</th><th>WPM</th><th>군말</th><th>녹음</th></tr>
      ${a.rounds.map((r, i) => { const m = metrics(r.transcript || r.liveTranscript, r.durationSec); return `<tr><td>${i + 1} (${[4, 3, 2][i]}분)</td><td>${fmt(r.durationSec)}</td><td>${m.wpm}</td><td>${m.fillers}</td><td><audio controls preload="none" data-audio-key="${esc(r.audioKey || "")}"></audio></td></tr>`; }).join("")}</table>
      ${a.rounds.map((r, i) => `<details><summary>Round ${i + 1} 받아쓰기</summary><p class="transcript">${esc(r.transcript || r.liveTranscript || "(없음)")}</p></details>`).join("")}`;
  } else {
    const t = an?.transcript || a.liveTranscript;
    rec = `<div class="rec-line"><audio controls preload="none" data-audio-key="${esc(a.audioKey || "")}"></audio>
      <div class="chips">${metricChips(t, a.durationSec)}</div></div>`;
  }

  let body = "";
  if (a.status === "done" && an) {
    const myText = an.transcript || a.liveTranscript || "";
    body = `
      ${a.rounds ? "" : `<section><h4>내 답변 (받아쓰기)</h4><p class="transcript">${esc(myText)}</p></section>`}
      <section class="corrected-sec">
        <div class="sec-head"><h4>원어민 교정본</h4>
          <div class="btns"><button class="btn small" data-say="${esc(an.corrected)}">🔊 듣기</button>
          <button class="btn small" data-say="${esc(an.corrected)}" data-rate="0.8">🐢 천천히</button>
          <button class="btn small ghost" data-toggle-diff>🔍 내 답변과 비교</button></div></div>
        <div class="corrected">${sentences(an.corrected).map((x) => `<span class="sent" data-say="${esc(x)}" title="클릭하면 이 문장만 들려줘요">${esc(x)}</span>`).join(" ")}</div>
        <div class="diff hidden">${diffWords(myText, an.corrected)}<p class="muted small">빨간 줄 = 내가 한 말 중 바뀐 부분, 초록 = 새로 들어간 표현</p></div>
        <p class="muted small">문장을 클릭하면 그 문장만 들을 수 있어요. 한 문장씩 듣고 따라 말해 보세요(쉐도잉).</p>
      </section>
      ${(an.changes || []).length ? `<section><h4>주요 수정 포인트</h4><div class="changes">${an.changes.map((c) => `
        <div class="change"><div><del>${esc(c.original)}</del> → <ins>${esc(c.improved)}</ins></div><div class="muted">${esc(c.reason_ko)}</div></div>`).join("")}</div></section>` : ""}
      <section><div class="sec-head"><h4>암기할 표현 ${(an.expressions || []).length}개</h4>
        <span class="muted small">${a.bankAdded ? `표현 뱅크에 새로 ${a.bankAdded}개 저장됨` : "표현 뱅크에 저장됨"}</span></div>
        <div class="exprs">${(an.expressions || []).map(exprCard).join("")}</div></section>
      ${an.progress_ko ? `<section><h4>4-3-2 변화 분석</h4><p>${esc(an.progress_ko)}</p></section>` : ""}
      <section><h4>피드백</h4>${bandsHtml(an.bands, !!a.audioKey && getSettings().aiTranscribe)}
        <ul class="feedback">
          <li><b>유창성·일관성</b> ${esc(an.feedback?.fluency_ko)}</li>
          <li><b>어휘</b> ${esc(an.feedback?.lexical_ko)}</li>
          <li><b>문법</b> ${esc(an.feedback?.grammar_ko)}</li>
          <li><b>발음</b> ${esc(an.feedback?.pronunciation_ko)}</li>
        </ul>
        ${an.tips_ko ? `<div class="tip">🎯 다음 연습 포인트: ${esc(an.tips_ko)}</div>` : ""}
      </section>`;
  } else if (a.status === "nokey") {
    body = `<div class="notice">AI 교정을 받으려면 <a href="#settings">설정</a>에서 Gemini API 키를 넣어 주세요. 그 다음 아래 버튼을 누르면 돼요.
      <p class="transcript">${esc(a.liveTranscript || "(브라우저 받아쓰기 결과 없음)")}</p>
      <button class="btn small" data-retry="${a.id}">교정 시작</button></div>`;
  } else if (a.status === "error") {
    body = `<div class="notice error">교정 실패: ${esc(a.error)}<br><button class="btn small" data-retry="${a.id}">다시 시도</button></div>`;
  } else {
    body = `<div class="notice"><span class="spinner"></span> ${esc(a.statusMsg || (a.status === "pending" ? "교정 전" : "대기 중…"))}
      ${a.status === "pending" ? `<button class="btn small" data-retry="${a.id}">교정 시작</button>` : ""}</div>`;
  }
  const again = practice && a.status !== "working" ? `<div class="again"><button class="btn" data-again="${a.id}">🔁 교정본 보고 같은 질문 다시 답하기</button></div>` : "";
  return `<article class="answer" id="ans-${a.id}">${head}${rec}${body}${again}</article>`;
}

const audioUrls = new Map();
async function hydrate(root) {
  for (const el of $$("audio[data-audio-key]", root)) {
    const k = el.dataset.audioKey;
    if (!k || el.src) continue;
    let url = audioUrls.get(k);
    if (!url) {
      const blob = await idb.get("audio", k).catch(() => null);
      if (!blob) continue;
      url = URL.createObjectURL(blob);
      audioUrls.set(k, url);
    }
    el.src = url;
  }
}

// Live-update cards when processing finishes
window.addEventListener("answer-updated", (e) => {
  const { answer } = e.detail;
  const el = document.getElementById("ans-" + answer.id);
  if (!el) return;
  const practice = !!el.closest("[data-practice]");
  el.outerHTML = answerCard(answer, { practice });
  hydrate(document.getElementById("ans-" + answer.id));
});

// Global delegated clicks
document.addEventListener("click", async (e) => {
  const sayBtn = e.target.closest("[data-say]");
  if (sayBtn) { e.preventDefault(); unlockAudio(); speak(sayBtn.dataset.say, { rate: Number(sayBtn.dataset.rate) || undefined }); return; }
  const diffBtn = e.target.closest("[data-toggle-diff]");
  if (diffBtn) {
    const sec = diffBtn.closest(".corrected-sec");
    $(".diff", sec).classList.toggle("hidden");
    $(".corrected", sec).classList.toggle("hidden");
    return;
  }
  const retry = e.target.closest("[data-retry]");
  if (retry) {
    const sid = retry.closest("[data-sid]")?.dataset.sid;
    if (!hasKey()) { toast("설정에서 API 키를 먼저 넣어 주세요."); return; }
    if (sid) enqueue(sid, retry.dataset.retry);
  }
});

// ---------------- pages ----------------
const pages = {};

pages.home = async () => {
  const sessions = await getSessions();
  const bank = await getBank();
  const now = new Date().toISOString();
  const due = bank.filter((b) => b.due <= now).length;
  const answers = sessions.flatMap((s) => s.answers.map((a) => ({ ...a, date: s.date })));
  const days = new Set(sessions.map((s) => localDate(new Date(s.date))));
  let streak = 0; const d = new Date();
  if (!days.has(localDate(d))) d.setDate(d.getDate() - 1);
  while (days.has(localDate(d))) { streak++; d.setDate(d.getDate() - 1); }
  const recent = answers.filter((a) => !a.rounds).slice(0, 20).reverse()
    .map((a) => metrics(a.analysis?.transcript || a.liveTranscript, a.durationSec).wpm).filter((x) => x > 0);
  const avg = recent.length ? Math.round(recent.reduce((x, y) => x + y, 0) / recent.length) : 0;

  main.innerHTML = `
    <section class="hero">
      <h1>오늘도 한 번 말해 볼까요?</h1>
      <p>실전처럼 듣고, 말하고, 원어민 표현으로 교정받고, 그 표현을 내 것으로 만드는 IELTS 스피킹 연습장이에요.</p>
      ${!hasKey() ? `<div class="notice">아직 AI 키가 없어요. 녹음과 받아쓰기는 지금도 되지만, <b>교정·표현 정리·채점</b>은 <a href="#settings">설정</a>에서 무료 Gemini API 키를 넣어야 동작해요.</div>` : ""}
      ${!hasSpeechRecognition ? `<div class="notice">이 브라우저는 실시간 받아쓰기를 지원하지 않아요. Chrome이나 Safari를 추천해요. (녹음과 AI 받아쓰기는 그대로 됩니다)</div>` : ""}
    </section>
    <section class="grid4">
      <a class="tile" href="#mock"><div class="tile-ic">🎯</div><b>실전 모의고사</b><span>Part 1→2→3 전체, 약 12~14분</span></a>
      <a class="tile" href="#practice"><div class="tile-ic">🧩</div><b>파트별 연습</b><span>한 문제씩 바로 교정</span></a>
      <a class="tile" href="#432"><div class="tile-ic">⏱</div><b>4-3-2 연습</b><span>같은 주제를 4분·3분·2분</span></a>
      <a class="tile" href="#review"><div class="tile-ic">🧠</div><b>표현 복습</b><span>${due ? `오늘 복습할 표현 ${due}개` : "복습할 표현 없음"}</span></a>
    </section>
    <section class="stats">
      <div class="stat"><div class="stat-v">${streak}</div><div class="stat-l">연속 연습일</div></div>
      <div class="stat"><div class="stat-v">${answers.length}</div><div class="stat-l">총 답변 수</div></div>
      <div class="stat"><div class="stat-v">${avg || "–"}</div><div class="stat-l">최근 평균 WPM</div></div>
      <div class="stat"><div class="stat-v">${bank.length}</div><div class="stat-l">모은 표현</div></div>
    </section>
    ${recent.length > 1 ? `<section class="card"><h3>최근 답변 말하기 속도(WPM)</h3>${sparkline(recent)}
      <p class="muted small">시험에서 자연스럽게 들리는 속도는 대략 분당 120~160단어예요. 무조건 빠른 것보다 끊김 없이 이어가는 게 중요해요.</p></section>` : ""}
    <section class="card"><h3>최근 기록</h3>${sessions.slice(0, 5).map(sessionRow).join("") || `<p class="muted">아직 기록이 없어요.</p>`}</section>`;
};

function sparkline(vals) {
  const w = 600, h = 120, p = 20;
  const max = Math.max(180, ...vals), min = Math.min(60, ...vals);
  const x = (i) => p + (i * (w - 2 * p)) / Math.max(1, vals.length - 1);
  const y = (v) => h - p - ((v - min) * (h - 2 * p)) / (max - min);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" role="img" aria-label="WPM 추이">
    <rect x="${p}" y="${y(160)}" width="${w - 2 * p}" height="${y(120) - y(160)}" class="spark-band"/>
    <polyline points="${pts}" class="spark-line"/>
    ${vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" class="spark-dot"><title>${v} WPM</title></circle>`).join("")}
  </svg>`;
}

function sessionRow(s) {
  const done = s.answers.filter((a) => a.status === "done").length;
  return `<a class="row-link" href="#session/${s.id}">
    <span>${new Date(s.date).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
    <b>${esc(s.title || MODE_LABEL[s.mode])}</b>
    <span class="muted">${s.answers.length}개 답변 · 교정 ${done}/${s.answers.length}</span></a>`;
}

// ----- Mock test -----
pages.mock = async () => {
  main.innerHTML = `
    <section class="card">
      <h2>🎯 실전 모의고사</h2>
      <p>실제 시험 순서대로 진행돼요. 시험관이 호주 억양으로 질문을 읽어 주면, 끝나자마자 녹음이 자동으로 시작돼요. 답이 끝나면 <b>답변 끝</b> 버튼을 누르세요.</p>
      <ul>
        <li><b>Part 1</b> (약 4~5분): 일상 주제 3개 × 3문제. 한 답변은 20~30초가 적당해요.</li>
        <li><b>Part 2</b> (3~4분): 큐카드를 보고 1분 준비 → 최대 2분 말하기. 2분이 되면 자동으로 끊겨요.</li>
        <li><b>Part 3</b> (4~5분): Part 2 주제와 관련된 심화 질문 4개. 이유와 예시를 들어 길게 말해 보세요.</li>
      </ul>
      <p class="muted">실제 시험처럼 중간에는 피드백이 나오지 않아요. 시험이 끝나면 모든 답변이 차례로 교정돼요. 질문을 다시 듣고 싶으면 실제 시험에서처럼 <b>다시 듣기</b>를 누르면 돼요.</p>
      <div class="form-row">
        <label>Part 2 큐카드 <select id="mock-card"><option value="random">무작위</option>${PART2.map((c) => `<option value="${c.id}">${esc(c.cue)}</option>`).join("")}
          ${hasKey() ? `<option value="ai">✨ AI가 새로 만든 큐카드</option>` : ""}</select></label>
      </div>
      <button class="btn primary big" id="mock-start">시험 시작</button>
    </section>
    <div id="exam-area"></div>`;
  $("#mock-start").onclick = async () => {
    unlockAudio();
    const area = $("#exam-area");
    main.querySelector(".card").classList.add("hidden");
    if (!(await ensureMic(area))) return;
    let card;
    const v = $("#mock-card").value;
    if (v === "ai") {
      area.innerHTML = `<div class="notice"><span class="spinner"></span> 새 큐카드를 만드는 중…</div>`;
      try { card = await generateCueCard(); } catch (e) { toast("AI 큐카드 실패 → 무작위 카드로 진행: " + e.message); }
    } else if (v !== "random") card = PART2.find((c) => c.id === v);
    card = card || shuffle(PART2)[0];
    runMock(area, card);
  };
};

async function runMock(area, card) {
  const R = startRunner();
  const ui = examUI(area);
  const session = { id: uid(), date: new Date().toISOString(), mode: "mock", title: "실전 모의고사", answers: [] };
  const topics = [shuffle(PART1.slice(0, 3))[0], ...shuffle(PART1.slice(3)).slice(0, 2)];
  const p1 = topics.map((t) => ({ topic: t.topic, qs: t.qs.slice(0, 3) }));
  const p3 = card.part3.slice(0, 4);
  const total = p1.reduce((n, t) => n + t.qs.length, 0) + 1 + p3.length;
  let count = 0;
  const save = async (a) => { session.answers.push(a); await saveSession(session); };
  $("#ex-quit", area).onclick = async () => {
    R.abort();
    stopRunner();
    if (session.answers.length) { await saveSession(session); location.hash = "#session/" + session.id; }
    else location.hash = "#mock-reset";
  };
  try {
    ui.part("Part 1");
    await say(R, ui, SCRIPT.opening);
    for (const t of p1) {
      await say(R, ui, SCRIPT.topic(t.topic));
      for (const q of t.qs) {
        ui.progress(`${++count} / ${total}`);
        await say(R, ui, q, true);
        await save(await recordAnswer(R, ui, { part: 1, question: q, maxSec: 75, hint: "🎙 녹음 중 · 권장 20~30초" }));
      }
    }
    ui.part("Part 2");
    ui.progress(`${++count} / ${total}`);
    await say(R, ui, SCRIPT.part2Intro);
    ui.card(cueCardText(card));
    await say(R, ui, card.cue, false);
    await prepTime(R, ui, card);
    await say(R, ui, SCRIPT.part2Start);
    await save(await recordAnswer(R, ui, { part: 2, question: card.cue, cueCard: cueCardText(card), maxSec: 120, hint: "🎙 녹음 중 · 1~2분" }));
    await say(R, ui, SCRIPT.part2End);
    ui.card(null); ui.notes(false);
    ui.part("Part 3");
    await say(R, ui, SCRIPT.part3Intro(card.theme));
    for (const q of p3) {
      ui.progress(`${++count} / ${total}`);
      await say(R, ui, q, true);
      await save(await recordAnswer(R, ui, { part: 3, question: q, maxSec: 150, hint: "🎙 녹음 중 · 권장 40~70초" }));
    }
    await say(R, ui, SCRIPT.closing);
    session.complete = true;
    await saveSession(session);
    stopRunner();
    location.hash = "#session/" + session.id;
    processSession(session);
  } catch (e) {
    if (e !== ABORT) { console.error(e); toast("오류: " + e.message); if (session.answers.length) await saveSession(session); }
  }
}

// ----- Practice -----
let practiceState = null;
pages.practice = async () => {
  const sid = "practice-" + localDate();
  main.innerHTML = `
    <section class="card" id="pr-setup">
      <h2>🧩 파트별 연습</h2>
      <p>한 문제씩 답하고 바로 교정을 받아요. 교정본을 듣고 <b>같은 질문에 다시 답하기</b>를 하면, 방금 배운 표현을 직접 꺼내 쓰는 연습이 돼요.</p>
      <div class="seg" id="pr-part">
        <button data-p="1" class="on">Part 1</button><button data-p="2">Part 2</button><button data-p="3">Part 3</button>
      </div>
      <div class="form-row"><label>주제 <select id="pr-topic"></select></label></div>
      <div class="form-row"><label>또는 직접 질문 입력 <input id="pr-custom" placeholder="예: Do you like rainy days?"></label></div>
      <div class="btns">
        <button class="btn primary big" id="pr-start">시작</button>
        ${hasKey() ? `<button class="btn" id="pr-ai">✨ AI 새 큐카드 (Part 2·3)</button>` : ""}
      </div>
    </section>
    <div id="exam-area"></div>
    <div id="pr-results" data-practice data-sid="${sid}"></div>`;
  let part = 1, aiCard = null;
  const fill = () => {
    const sel = $("#pr-topic");
    if (part === 1) sel.innerHTML = `<option value="random">무작위</option>` + PART1.map((t, i) => `<option value="${i}">${esc(t.topic)}</option>`).join("");
    else sel.innerHTML = `<option value="random">무작위</option>` + (aiCard ? `<option value="ai">✨ ${esc(aiCard.cue)}</option>` : "") + PART2.map((c) => `<option value="${c.id}">${esc(part === 2 ? c.cue : c.theme)}</option>`).join("");
    if (aiCard && part !== 1) sel.value = "ai";
  };
  $$("#pr-part button").forEach((b) => b.onclick = () => { $$("#pr-part button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); part = Number(b.dataset.p); fill(); });
  fill();
  if ($("#pr-ai")) $("#pr-ai").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "만드는 중…";
    try { aiCard = await generateCueCard(); if (part === 1) $$("#pr-part button")[1].click(); else fill(); toast("새 큐카드를 만들었어요."); }
    catch (err) { toast(err.message); }
    e.target.disabled = false; e.target.textContent = "✨ AI 새 큐카드 (Part 2·3)";
  };
  $("#pr-start").onclick = () => {
    unlockAudio();
    const custom = $("#pr-custom").value.trim();
    const v = $("#pr-topic").value;
    let q;
    if (custom) q = { part, question: custom, cueCard: part === 2 ? custom : "" };
    else if (part === 1) {
      const t = v === "random" ? shuffle(PART1)[0] : PART1[Number(v)];
      q = { part, question: shuffle(t.qs)[0], topic: t.topic };
    } else {
      const c = v === "ai" ? aiCard : v === "random" ? shuffle(PART2)[0] : PART2.find((x) => x.id === v);
      q = part === 2 ? { part, question: c.cue, cueCard: cueCardText(c), card: c } : { part, question: shuffle(c.part3)[0], topic: c.theme };
    }
    runPractice(q, sid);
  };
  // show today's practice answers
  const s = await getSession(sid);
  if (s && s.answers.length) {
    $("#pr-results").innerHTML = `<h3>오늘의 연습</h3>` + s.answers.slice().reverse().map((a) => answerCard(a, { practice: true })).join("");
    hydrate($("#pr-results"));
  }
  $("#pr-results").onclick = async (e) => {
    const again = e.target.closest("[data-again]");
    if (!again) return;
    const s2 = await getSession(sid);
    const a = s2.answers.find((x) => x.id === again.dataset.again);
    if (a) { unlockAudio(); window.scrollTo({ top: 0, behavior: "smooth" }); runPractice({ part: a.part, question: a.question, cueCard: a.cueCard }, sid); }
  };
};

async function runPractice(q, sid) {
  const area = $("#exam-area");
  $("#pr-setup").classList.add("hidden");
  if (!(await ensureMic(area))) return;
  const R = startRunner();
  const ui = examUI(area);
  ui.part(`Part ${q.part}`);
  $("#ex-quit", area).onclick = () => { stopRunner(); area.innerHTML = ""; $("#pr-setup").classList.remove("hidden"); };
  try {
    let ans;
    if (q.part === 2) {
      ui.card(q.cueCard);
      await say(R, ui, q.question);
      await prepTime(R, ui, null, 60);
      await say(R, ui, SCRIPT.part2Start);
      ans = await recordAnswer(R, ui, { part: 2, question: q.question, cueCard: q.cueCard, maxSec: 120, hint: "🎙 녹음 중 · 1~2분" });
      await say(R, ui, SCRIPT.part2End);
    } else {
      if (q.topic) await say(R, ui, SCRIPT.topic(q.topic));
      await say(R, ui, q.question, true);
      ans = await recordAnswer(R, ui, { part: q.part, question: q.question, maxSec: q.part === 1 ? 75 : 150, hint: q.part === 1 ? "🎙 녹음 중 · 권장 20~30초" : "🎙 녹음 중 · 권장 40~70초", label: "답변 끝 → 교정받기" });
    }
    stopRunner();
    await withLock(async () => {
      let s = await getSession(sid);
      if (!s) s = { id: sid, date: new Date().toISOString(), mode: "practice", title: `파트별 연습 (${localDate()})`, answers: [] };
      s.answers.push(ans);
      await saveSession(s);
    });
    area.innerHTML = "";
    $("#pr-setup").classList.remove("hidden");
    const res = $("#pr-results");
    if (!$("h3", res)) res.insertAdjacentHTML("afterbegin", "<h3>오늘의 연습</h3>");
    $("h3", res).insertAdjacentHTML("afterend", answerCard(ans, { practice: true }));
    hydrate(res);
    $("#ans-" + ans.id).scrollIntoView({ behavior: "smooth" });
    enqueue(sid, ans.id);
  } catch (e) {
    if (e !== ABORT) { console.error(e); toast("오류: " + e.message); }
  }
}


// ----- 4-3-2 -----
pages["432"] = async () => {
  main.innerHTML = `
    <section class="card" id="f-setup">
      <h2>⏱ 4-3-2 연습</h2>
      <p>같은 Part 2 주제를 <b>4분 → 3분 → 2분</b> 동안 세 번 말해요. 시간은 줄어드는데 내용은 그대로 전달해야 하니까, 반복할수록 같은 표현이 더 빨리, 덜 망설이면서 나오게 돼요. 머릿속에 있는 표현을 "바로 꺼내 쓰는" 속도를 키우는 훈련이에요.</p>
      <p class="muted">끝나면 세 라운드의 속도(WPM)와 군말 변화를 비교하고, 세 번 말한 내용 중 좋은 부분을 모아 2분짜리 원어민 답변으로 교정해 줘요.</p>
      <div class="form-row"><label>큐카드 <select id="f-card"><option value="random">무작위</option>${PART2.map((c) => `<option value="${c.id}">${esc(c.cue)}</option>`).join("")}
        ${hasKey() ? `<option value="ai">✨ AI가 새로 만든 큐카드</option>` : ""}</select></label></div>
      <label class="check"><input type="checkbox" id="f-prep" checked> 시작 전에 1분 준비 시간</label>
      <button class="btn primary big" id="f-start">시작</button>
    </section>
    <div id="exam-area"></div>`;
  $("#f-start").onclick = async () => {
    unlockAudio();
    const area = $("#exam-area");
    $("#f-setup").classList.add("hidden");
    if (!(await ensureMic(area))) return;
    const v = $("#f-card").value;
    let card;
    if (v === "ai") { try { card = await generateCueCard(); } catch (e) { toast(e.message); } }
    else if (v !== "random") card = PART2.find((c) => c.id === v);
    card = card || shuffle(PART2)[0];
    run432(area, card, $("#f-prep").checked);
  };
};

async function run432(area, card, withPrep) {
  const R = startRunner();
  const ui = examUI(area);
  ui.part("4-3-2");
  $("#ex-quit", area).onclick = () => { stopRunner(); location.hash = "#home"; };
  const cc = cueCardText(card);
  const rounds = [];
  try {
    ui.card(cc);
    await say(R, ui, card.cue);
    if (withPrep) await prepTime(R, ui, card);
    const lens = [240, 180, 120], words = ["four", "three", "two"];
    for (let i = 0; i < 3; i++) {
      ui.progress(`Round ${i + 1} / 3`);
      if (i > 0) {
        ui.done.disabled = false; ui.done.textContent = `Round ${i + 1} 시작 (${lens[i] / 60}분)`;
        ui.status("잠깐 숨 고르기. 준비되면 버튼을 누르세요.");
        await R.waitDone(ui.done, 0);
      }
      await say(R, ui, `Round ${i + 1}. You have ${words[i]} minutes. Please start now.`);
      const a = await recordAnswer(R, ui, { part: 2, question: card.cue, maxSec: lens[i], countdown: true, hint: `🎙 Round ${i + 1} · 남은 시간`, label: "이번 라운드 끝" });
      rounds.push({ durationSec: a.durationSec, liveTranscript: a.liveTranscript, audioKey: a.audioKey });
      beep(660, 250);
    }
    await say(R, ui, "Well done. That's all three rounds.");
    stopRunner();
    const s = { id: uid(), date: new Date().toISOString(), mode: "432", title: "4-3-2: " + card.cue, answers: [
      { id: uid(), part: 2, question: card.cue, cueCard: cc, rounds, durationSec: rounds[2]?.durationSec || 0, status: "pending" }] };
    await saveSession(s);
    location.hash = "#session/" + s.id;
    processSession(s);
  } catch (e) {
    if (e !== ABORT) { console.error(e); toast("오류: " + e.message); }
  }
}

// ----- Session view -----
pages.session = async (id) => {
  const s = await getSession(id);
  if (!s) { main.innerHTML = `<p>기록을 찾을 수 없어요.</p>`; return; }
  const pending = s.answers.filter((a) => a.status !== "done").length;
  main.innerHTML = `
    <section class="card" data-sid="${s.id}">
      <div class="sec-head"><h2>${esc(s.title || MODE_LABEL[s.mode])}</h2>
        <div class="btns">${pending && hasKey() ? `<button class="btn small" id="s-run">남은 ${pending}개 교정</button>` : ""}
        <button class="btn small ghost" id="s-del">삭제</button></div></div>
      <p class="muted">${new Date(s.date).toLocaleString("ko-KR")} · ${s.answers.length}개 답변</p>
      ${s.mode === "mock" && pending ? `<p class="muted small">답변이 차례로 교정돼요. 무료 사용량 한도 때문에 중간에 잠깐씩 기다릴 수 있어요. 이 페이지를 닫아도 다음에 와서 <b>남은 교정</b>을 누르면 이어서 진행돼요.</p>` : ""}
    </section>
    <div data-sid="${s.id}" ${s.mode === "practice" ? "data-practice" : ""}>${s.answers.map((a) => answerCard(a)).join("")}</div>`;
  hydrate(main);
  if ($("#s-run")) $("#s-run").onclick = () => { processSession(s); $("#s-run").remove(); };
  $("#s-del").onclick = async () => { if (confirm("이 기록과 녹음을 삭제할까요? (표현 뱅크는 그대로 남아요)")) { await deleteSession(id); location.hash = "#history"; } };
};

pages.history = async () => {
  const sessions = await getSessions();
  main.innerHTML = `<section class="card"><h2>📒 기록</h2>${sessions.map(sessionRow).join("") || `<p class="muted">아직 기록이 없어요.</p>`}</section>`;
};

// ----- Expression bank -----
pages.bank = async () => {
  const bank = await getBank();
  const now = new Date().toISOString();
  const due = bank.filter((b) => b.due <= now).length;
  const types = [...new Set(bank.map((b) => b.type).filter(Boolean))];
  main.innerHTML = `
    <section class="card">
      <div class="sec-head"><h2>📚 표현 뱅크 <span class="muted">${bank.length}개</span></h2>
        <div class="btns"><a class="btn primary small" href="#review">🧠 복습 (${due})</a>
        <button class="btn small" id="b-anki">Anki용 내보내기</button></div></div>
      <p class="muted">교정본에서 뽑은 표현이 자동으로 쌓여요. 복습은 <b>한국어 뜻 → 영어로 말하기</b> 방향이라, 알아보는 연습이 아니라 직접 꺼내 쓰는 연습이 돼요.</p>
      <div class="form-row inline"><input id="b-q" placeholder="검색 (영어/한국어)">
        <select id="b-type"><option value="">모든 종류</option>${types.map((t) => `<option>${esc(t)}</option>`).join("")}</select></div>
    </section>
    <div id="b-list" class="exprs"></div>`;
  const render = () => {
    const q = $("#b-q").value.toLowerCase(), t = $("#b-type").value;
    const list = bank.filter((b) => (!t || b.type === t) && (!q || [b.expression, b.meaning_ko, b.example].join(" ").toLowerCase().includes(q)));
    $("#b-list").innerHTML = list.map((b) => `<div class="bank-item">${exprCard(b)}
      <div class="bank-meta"><span class="muted small">상자 ${b.box}/6 · ${esc((b.sourceQuestion || "").slice(0, 60))}</span>
      <button class="btn ghost small" data-del="${b.id}">삭제</button></div></div>`).join("") || `<p class="muted">표현이 없어요.</p>`;
  };
  $("#b-q").oninput = render; $("#b-type").onchange = render;
  $("#b-list").onclick = async (e) => {
    const d = e.target.closest("[data-del]");
    if (d && confirm("이 표현을 삭제할까요?")) { await deleteBankItem(d.dataset.del); const i = bank.findIndex((b) => b.id === d.dataset.del); bank.splice(i, 1); render(); }
  };
  $("#b-anki").onclick = () => {
    const clean = (s) => String(s || "").replace(/[\t\n\r]+/g, " ");
    const rows = bank.map((b) => [
      clean(`${b.meaning_ko}${b.replaces ? `<br><small>(내가 한 말: ${b.replaces})</small>` : ""}`),
      clean(`<b>${b.expression}</b><br>${b.stress} /${(b.ipa || "").replace(/^\/|\/$/g, "")}/<br><i>${b.example}</i>${b.nuance_ko ? `<br><small>${b.nuance_ko}</small>` : ""}`),
      clean(b.type),
    ].join("\t"));
    download(`ielts-expressions-${localDate()}.txt`, rows.join("\n"), "text/tab-separated-values");
    toast("Anki: 파일 → 가져오기에서 이 파일을 선택하고, 'HTML 허용'을 켜 주세요.", 7000);
  };
  render();
};

pages.review = async () => {
  const now = new Date().toISOString();
  const cards = shuffle((await getBank()).filter((b) => b.due <= now));
  if (!cards.length) {
    main.innerHTML = `<section class="card"><h2>🧠 표현 복습</h2><p>지금 복습할 표현이 없어요. 연습을 하면 새 표현이 쌓이고, 외운 표현은 1·2·4·8·16·32일 간격으로 다시 나와요.</p><a class="btn" href="#bank">표현 뱅크 보기</a></section>`;
    return;
  }
  let idx = 0, done = 0;
  const show = () => {
    if (idx >= cards.length) {
      main.innerHTML = `<section class="card"><h2>🎉 복습 끝!</h2><p>${done}개 표현을 복습했어요.</p><a class="btn" href="#home">홈으로</a></section>`;
      return;
    }
    const c = cards[idx];
    const hint = c.expression.split(/\s+/).map((w) => w[0] + w.slice(1).replace(/[a-z]/gi, "_")).join(" ");
    main.innerHTML = `
      <section class="card review">
        <div class="muted small">${idx + 1} / ${cards.length} · 상자 ${c.box}/6</div>
        <div class="front">
          <div class="r-meaning">${esc(c.meaning_ko)}</div>
          ${c.replaces ? `<div class="replaces">내가 원래 했던 말: <span>${esc(c.replaces)}</span></div>` : ""}
          ${c.sourceQuestion ? `<div class="muted small">질문: ${esc(c.sourceQuestion)}</div>` : ""}
          <p class="muted">이 뜻을 영어로 <b>소리 내어</b> 말해 본 다음, 정답을 확인하세요.</p>
          <div class="btns"><button class="btn ghost small" id="r-hint">힌트</button><button class="btn primary" id="r-show">정답 보기</button></div>
          <div id="r-hint-box" class="hint hidden">${esc(hint)}</div>
        </div>
        <div class="back hidden">${exprCard(c)}
          <div class="btns grade">
            <button class="btn" data-g="0">😵 몰랐어요</button>
            <button class="btn" data-g="1">🤔 애매해요</button>
            <button class="btn primary" data-g="2">😎 바로 나왔어요</button>
          </div>
        </div>
      </section>`;
    $("#r-hint").onclick = () => $("#r-hint-box").classList.remove("hidden");
    $("#r-show").onclick = () => { $(".back").classList.remove("hidden"); $(".front .btns").classList.add("hidden"); unlockAudio(); speak(c.expression); };
    $$("[data-g]").forEach((b) => b.onclick = async () => {
      const g = Number(b.dataset.g);
      const day = 864e5;
      if (g === 0) { c.box = 0; c.due = new Date().toISOString(); cards.push(c); }
      else if (g === 1) { c.box = Math.max(1, c.box); c.due = new Date(Date.now() + day).toISOString(); }
      else { c.box = Math.min(6, c.box + 1); c.due = new Date(Date.now() + INTERVAL_DAYS[c.box] * day).toISOString(); }
      await saveBankItem(c);
      if (g !== 0) done++;
      idx++;
      show();
    });
  };
  show();
};

// ----- Settings -----
const GEMINI_VOICES = ["Charon", "Kore", "Puck", "Zephyr", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];

pages.settings = async () => {
  const s = getSettings();
  main.innerHTML = `
    <section class="card">
      <h2>⚙️ 설정</h2>
      <h3>1. Gemini API 키 (무료)</h3>
      <ol class="small">
        <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>에 Google 계정으로 로그인해요.</li>
        <li><b>Create API key</b>를 눌러 키를 만들고 복사해요. 결제 정보를 등록하지 않으면 무료 등급으로만 동작해서 요금이 나가지 않아요.</li>
        <li>아래 칸에 붙여넣고 <b>저장</b> → <b>연결 테스트</b>를 눌러요.</li>
      </ol>
      <div class="notice small">🔒 키는 <b>이 브라우저 안에만</b> 저장되고 GitHub에는 올라가지 않아요. 공용 컴퓨터에서는 쓰지 마세요.
      무료 등급에서는 Google이 입력 내용을 서비스 개선에 쓸 수 있으니, 민감한 개인정보는 답변에 넣지 않는 게 좋아요.</div>
      <div class="form-row"><label>API 키 <input id="st-key" type="password" value="${esc(s.apiKey)}" placeholder="AIza…" autocomplete="off"></label></div>
      <div class="btns"><button class="btn small" id="st-test">연결 테스트</button><span id="st-test-r" class="muted small"></span></div>

      <h3>2. 교정 수준</h3>
      <div class="form-row"><label>목표 밴드 (교정본 수준) <select id="st-band">${["7", "7.5", "8", "8.5", "9"].map((b) => `<option ${b === s.targetBand ? "selected" : ""}>${b}</option>`).join("")}</select></label></div>
      <label class="check"><input type="checkbox" id="st-ait" ${s.aiTranscribe ? "checked" : ""}> AI가 녹음을 직접 듣고 받아쓰기 (더 정확하고, um·uh 같은 군말도 잡아내요. 발음 피드백도 이때만 가능해요)</label>

      <h3>3. 음성 (시험관 목소리)</h3>
      <div class="seg" id="st-engine">
        <button data-e="browser" class="${s.ttsEngine === "browser" ? "on" : ""}">브라우저 음성 (무료·즉시)</button>
        <button data-e="gemini" class="${s.ttsEngine === "gemini" ? "on" : ""}">Gemini 음성 (더 자연스러움)</button>
      </div>
      <div id="st-browser" class="${s.ttsEngine === "browser" ? "" : "hidden"}">
        <div class="form-row"><label>브라우저 음성 <select id="st-voice"></select></label></div>
        <p class="muted small">호주 억양: Mac은 <b>Karen</b>, <b>Lee</b>, <b>Catherine</b> 같은 en-AU 음성이 있어요. 더 자연스러운 고품질 버전은 <b>시스템 설정 → 손쉬운 사용 → 읽기 및 말하기 → 시스템 음성 → 음성 관리</b>에서 영어(오스트레일리아) 음성을 내려받으면 돼요. 내려받은 고품질 음성은 Safari에서 더 잘 보여요.</p>
      </div>
      <div id="st-gemini" class="${s.ttsEngine === "gemini" ? "" : "hidden"}">
        <div class="form-row"><label>Gemini 목소리 <select id="st-gvoice">${GEMINI_VOICES.map((v) => `<option ${v === s.geminiVoice ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>
        <p class="muted small">"호주 억양으로 읽어줘"라고 지시하는 방식이라, 목소리에 따라 억양이 다르게 들릴 수 있어요. 몇 개 들어 보고 마음에 드는 걸 고르세요. 한 번 만든 음성은 저장해 두기 때문에, 같은 문장을 다시 들을 때는 사용량이 들지 않아요.</p>
      </div>
      <div class="form-row"><label>말하기 속도 <input id="st-rate" type="range" min="0.7" max="1.2" step="0.05" value="${s.rate}"> <span id="st-rate-v">${s.rate}</span></label></div>
      <button class="btn small" id="st-try">🔊 들어보기</button>

      <h3>4. 실전 옵션</h3>
      <label class="check"><input type="checkbox" id="st-hide" ${s.hideQuestionText ? "checked" : ""}> 질문 글자 가리기 (실제 시험처럼 듣기만으로 이해하기)</label>
      <div class="form-row"><label>실시간 받아쓰기 언어 <select id="st-lang">${["en-AU", "en-GB", "en-US"].map((l) => `<option ${l === s.recogLang ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>

      <details><summary>고급: 모델 이름</summary>
        <p class="muted small">Google이 모델 이름을 바꾸면 여기서 고칠 수 있어요. 사용 가능한 이름은 Google AI Studio 문서에서 확인하세요.</p>
        <div class="form-row"><label>교정·받아쓰기 모델 <input id="st-tm" value="${esc(s.textModel)}"></label></div>
        <div class="form-row"><label>음성(TTS) 모델 <input id="st-ttsm" value="${esc(s.ttsModel)}"></label></div>
      </details>

      <div class="btns sticky-save"><button class="btn primary" id="st-save">저장</button></div>
    </section>
    <section class="card">
      <h3>백업</h3>
      <p class="muted small">기록과 표현은 이 브라우저에만 저장돼요. 브라우저 데이터를 지우면 사라지니까, 가끔 백업해 두세요. (녹음 파일은 백업에 포함되지 않아요)</p>
      <div class="btns"><button class="btn small" id="st-exp">백업 내보내기 (JSON)</button>
      <label class="btn small">백업 가져오기<input type="file" id="st-imp" accept=".json" hidden></label>
      <button class="btn small ghost" id="st-clear-tts">음성 캐시 비우기</button></div>
    </section>`;

  let engine = s.ttsEngine;
  const fillVoices = () => {
    const sel = $("#st-voice");
    if (!sel) return;
    const vs = voices();
    sel.innerHTML = vs.length ? vs.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === s.browserVoice ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("") : `<option value="">음성을 불러오는 중…</option>`;
    if (!s.browserVoice) { const au = vs.find((v) => /AU/i.test(v.lang)); if (au) sel.value = au.voiceURI; }
  };
  onVoicesReady(fillVoices); fillVoices();
  $$("#st-engine button").forEach((b) => b.onclick = () => {
    engine = b.dataset.e;
    $$("#st-engine button").forEach((x) => x.classList.toggle("on", x === b));
    $("#st-browser").classList.toggle("hidden", engine !== "browser");
    $("#st-gemini").classList.toggle("hidden", engine !== "gemini");
  });
  $("#st-rate").oninput = (e) => ($("#st-rate-v").textContent = e.target.value);
  const collect = () => ({
    ...getSettings(),
    apiKey: $("#st-key").value.trim(), targetBand: $("#st-band").value, aiTranscribe: $("#st-ait").checked,
    ttsEngine: engine, browserVoice: $("#st-voice").value, geminiVoice: $("#st-gvoice").value, rate: Number($("#st-rate").value),
    hideQuestionText: $("#st-hide").checked, recogLang: $("#st-lang").value,
    textModel: $("#st-tm").value.trim() || "gemini-2.5-flash", ttsModel: $("#st-ttsm").value.trim() || "gemini-2.5-flash-preview-tts",
  });
  $("#st-save").onclick = () => { saveSettings(collect()); toast("저장했어요."); };
  $("#st-test").onclick = async () => {
    saveSettings(collect());
    $("#st-test-r").textContent = "확인 중…";
    try { const r = await testKey(); $("#st-test-r").textContent = `✅ 연결됨 (응답: ${r.slice(0, 20)})`; }
    catch (e) { $("#st-test-r").textContent = "❌ " + e.message; }
  };
  $("#st-try").onclick = async () => {
    saveSettings(collect()); unlockAudio();
    $("#st-try").textContent = "🔊 재생 중…";
    await speak("G'day! Let's talk about your hometown. What do you like most about living there?");
    $("#st-try").textContent = "🔊 들어보기";
  };
  $("#st-exp").onclick = async () => download(`ielts-speaking-backup-${localDate()}.json`, JSON.stringify(await exportAll(), null, 1), "application/json");
  $("#st-imp").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = await importAll(JSON.parse(await f.text())); toast(`${n}개 항목을 가져왔어요.`); } catch (err) { toast("가져오기 실패: " + err.message); }
  };
  $("#st-clear-tts").onclick = async () => {
    const d = await new Promise((res) => { const r = indexedDB.open("ielts-speaking"); r.onsuccess = () => res(r.result); });
    d.transaction("tts", "readwrite").objectStore("tts").clear();
    toast("음성 캐시를 비웠어요.");
  };
};

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- router ----------------
async function route() {
  stopRunner();
  let [name, arg] = location.hash.replace(/^#/, "").split("/");
  if (name === "mock-reset") { location.replace("#mock"); return; }
  if (!pages[name]) name = "home";
  $$("nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + (name === "session" ? "history" : name === "review" ? "bank" : name)));
  window.scrollTo(0, 0);
  try { await pages[name](arg); } catch (e) { console.error(e); main.innerHTML = `<div class="notice error">페이지 오류: ${esc(e.message)}</div>`; }
}
window.addEventListener("hashchange", route);
route();
