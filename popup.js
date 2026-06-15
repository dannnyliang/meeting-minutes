// Popup UI 邏輯。
import { ensureSeeded } from "./lib/templates.js";

const LARGE_BYTES = 200 * 1024 * 1024; // 超過此大小才詢問抽音 vs 直送影片

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove("hidden");
const hide = (el) => el.classList.add("hidden");

let lastJob = null; // 記住最後處理的檔，供「改用直送重試」

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : Math.round(n / 1e6) + " MB";
}
function fmtDuration(ms) {
  const s = Math.round(Number(ms) / 1000);
  if (!s) return "";
  const m = Math.floor(s / 60);
  return m ? `${m} 分` : `${s} 秒`;
}
// 清掉 Meet 檔名常見的尾綴，顯示乾淨一點
function prettyName(name) {
  return (name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/\s*-\s*Recording\s*$/i, "")
    .trim();
}

async function checkSetup() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    show($("needSetup"));
    hide($("listSection"));
    return false;
  }
  return true;
}

async function loadTemplates() {
  const { templates, defaultId } = await ensureSeeded();
  const sel = $("templateSelect");
  sel.innerHTML = "";
  for (const t of templates) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    if (t.id === defaultId) opt.selected = true;
    sel.append(opt);
  }
}

function recordingItem(file) {
  const li = document.createElement("li");
  li.className = "rec";
  const meta = document.createElement("div");
  meta.className = "rec-meta";
  const name = document.createElement("div");
  name.className = "rec-name";
  name.textContent = prettyName(file.name);
  name.title = file.name; // 滑過看完整原始檔名
  const sub = document.createElement("div");
  sub.className = "muted small";
  const dur = fmtDuration(file.videoMediaMetadata?.durationMillis);
  sub.textContent = [fmtSize(file.size), dur].filter(Boolean).join(" · ");
  meta.append(name, sub);

  const btn = document.createElement("button");
  btn.className = "primary small gen-btn";
  btn.textContent = "產生記錄";
  btn.onclick = () => onGenerate(file);

  li.append(meta, btn);
  return li;
}

async function loadRecordings() {
  hideAllPanels();
  show($("listSection"));
  $("recordingList").innerHTML =
    "<li class='loading'><span class='spinner'></span>讀取錄影清單…</li>";
  hide($("listEmpty"));
  const resp = await chrome.runtime.sendMessage({ type: "listRecordings" });
  if (!resp?.ok) return showError(resp?.error || "讀取清單失敗");
  $("recordingList").innerHTML = "";
  if (!resp.files.length) return show($("listEmpty"));
  resp.files.forEach((f) => $("recordingList").append(recordingItem(f)));
}

function onGenerate(file) {
  const big = Number(file.size) > LARGE_BYTES;
  if (!big) return start(file, "audio");
  // 大檔 → 讓使用者自選
  showChoice(file);
}

function showChoice(file) {
  hideAllPanels();
  const sec = $("errorSection");
  $("errorText").textContent =
    `這個檔案較大（${fmtSize(file.size)}）。「抽取語音」較省但可能較慢；「直接送影片」較穩但較貴。`;
  $("retryVideoBtn").classList.remove("hidden");
  $("retryVideoBtn").textContent = "直接送影片";
  $("retryVideoBtn").onclick = () => start(file, "video");
  // 借用 dismiss 當「抽取語音」
  $("dismissError").textContent = "抽取語音（推薦）";
  $("dismissError").onclick = () => start(file, "audio");
  show(sec);
}

async function start(file, mode) {
  lastJob = { file, mode };
  hideAllPanels();
  show($("progressSection"));
  $("progressFileName").textContent = prettyName(file.name);
  setProgress("starting", {});
  const resp = await chrome.runtime.sendMessage({
    type: "start",
    fileId: file.id,
    fileName: file.name,
    mode,
    templateId: $("templateSelect").value,
  });
  if (!resp?.ok) showError(resp?.error || "無法開始處理");
  // resp.busy：已有作業在跑，showError 已顯示提示
}

const STAGE_LABEL = {
  starting: "準備中…",
  download: "下載中…",
  prepare: "準備音訊…",
  extract: "抽取語音…",
  ai: "AI 整理中…",
  doc: "建立文件中…",
};

function setProgress(stage, { pct, note } = {}) {
  const fill = $("progressFill");
  if (typeof pct === "number") fill.style.width = Math.round(pct * 100) + "%";
  else if (["ai", "doc"].includes(stage)) fill.style.width = "90%";
  $("progressText").textContent = note || STAGE_LABEL[stage] || "處理中…";
}

function hideAllPanels() {
  // 含 listSection：處理中隱藏清單 → 防呆，避免同時點第二支
  ["needSetup", "listSection", "progressSection", "doneSection", "errorSection"].forEach((id) =>
    hide($(id))
  );
  // 還原 error 區被借用的按鈕文字
  $("dismissError").textContent = "關閉";
  $("dismissError").onclick = () => loadRecordings();
  $("retryVideoBtn").classList.add("hidden");
}

function showDone({ docLink, usage, fileName }) {
  hideAllPanels();
  show($("doneSection"));
  $("doneTitle").textContent = fileName
    ? `「${prettyName(fileName)}」已整理完成`
    : "會議記錄已完成";
  $("openDoc").onclick = () => chrome.tabs.create({ url: docLink });
  const tin = usage?.promptTokenCount, tout = usage?.candidatesTokenCount;
  $("usageText").textContent = tin
    ? `AI 用量：${tin.toLocaleString()} + ${(tout || 0).toLocaleString()} tokens`
    : "";
}

function showError(message, kind) {
  hideAllPanels();
  show($("errorSection"));
  $("errorText").textContent = message;
  if (kind === "extract_failed" && lastJob) {
    $("retryVideoBtn").classList.remove("hidden");
    $("retryVideoBtn").textContent = "改用「直接送影片」重試";
    $("retryVideoBtn").onclick = () => start(lastJob.file, "video");
  }
}

// 接收 offscreen 廣播
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.from !== "offscreen") return;
  if (msg.type === "progress") setProgress(msg.stage, msg);
  else if (msg.type === "done") showDone(msg);
  else if (msg.type === "error") showError(msg.message, msg.kind);
});

// 重開 popup 時還原最後狀態
async function restoreStatus() {
  const { status } = await chrome.storage.session.get("status");
  if (!status) return false;
  if (status.stage === "done") { showDone(status); return true; }
  if (status.stage === "error") { showError(status.message, status.kind); return true; }
  show($("progressSection"));
  setProgress(status.stage, status);
  return true;
}

$("settingsBtn").onclick = () => chrome.runtime.openOptionsPage();
$("openSetup").onclick = () => chrome.runtime.openOptionsPage();
$("refreshBtn").onclick = () => loadRecordings();
$("backList").onclick = () => loadRecordings();

(async function init() {
  hideAllPanels();
  if (!(await checkSetup())) return;
  await loadTemplates();
  if (await restoreStatus()) return;
  loadRecordings();
})();
