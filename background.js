// Service worker：協調 popup ↔ offscreen。
// - 取得 OAuth token、列出 Meet 錄影
// - 開啟 offscreen document 跑實際處理流程
// - 把 offscreen 的進度/結果存進 session storage，供 popup 重開時還原
import * as auth from "./lib/auth.js";
import * as drive from "./lib/drive.js";
import { resolvePrompt } from "./lib/templates.js";

const OFFSCREEN_PATH = "offscreen.html";

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS", "BLOBS"],
    justification: "用 ffmpeg.wasm 抽取會議語音並在背景處理音訊。",
  });
}

async function getSettings() {
  const d = await chrome.storage.local.get([
    "apiKey",
    "model",
    "systemInstruction",
    "inputFolderId",
    "outputFolderId",
    "processedFolderName",
  ]);
  return {
    apiKey: d.apiKey || "",
    model: d.model || "",
    systemInstruction: d.systemInstruction || "", // 跨場共用的系統指令，空 = 不送
    inputFolderId: d.inputFolderId || "",
    outputFolderId: d.outputFolderId || "", // 空 = 與來源相同資料夾
    processedFolderName: d.processedFolderName || "已處理",
  };
}

// 解析要掃描的輸入資料夾：優先用設定，否則自動找 Meet Recordings。
async function resolveInputFolder(token, settings) {
  if (settings.inputFolderId) return settings.inputFolderId;
  return await drive.findMeetRecordingsFolder(token);
}

async function listRecordings() {
  const token = await auth.getToken({ interactive: true });
  const settings = await getSettings();
  const folderId = await resolveInputFolder(token, settings);
  if (!folderId)
    return { ok: false, error: "找不到輸入資料夾。請到設定選擇，或先用 Google Meet 錄一場會議。" };
  const files = await drive.listRecordings(token, folderId);
  return { ok: true, files };
}

// 從 Google Drive 分享連結或原始 ID 解析出 file id。
// 支援 .../d/<id>/...、?id=<id>、以及直接貼裸 ID。
function parseFileId(input) {
  const s = (input || "").trim();
  const m = s.match(/\/d\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  if (m) return m[1];
  if (/^[\w-]{20,}$/.test(s)) return s;
  return null;
}

// 「貼連結」入口：解析連結 → 查影片資訊（不在意檔案在誰的 Drive，
// 只要本帳號有檢視權即可），回傳給 popup 走和清單相同的處理流程。
async function fileInfoFromInput(input) {
  const fileId = parseFileId(input);
  if (!fileId)
    return { ok: false, error: "看不懂這個連結，請貼 Google Drive 影片的分享連結或檔案 ID。" };
  const token = await auth.getToken({ interactive: true });
  const file = await drive.getFileInfo(token, fileId);
  if (!(file.mimeType || "").startsWith("video/"))
    return { ok: false, error: "這個連結不是影片檔，請確認是會議錄影。" };
  return { ok: true, file };
}

// 是否正在處理中（以 session status 為準，service worker 被回收也不影響）。
async function isBusy() {
  const { status } = await chrome.storage.session.get("status");
  if (!status) return false;
  return !["done", "error"].includes(status.stage);
}

async function startJob({ fileId, fileName, mode, templateId, byLink }) {
  if (await isBusy()) {
    const { status } = await chrome.storage.session.get("status");
    return { ok: false, busy: true, error: `正在處理「${status?.fileName || "另一支影片"}」，請待完成後再試。` };
  }
  const settings = await getSettings();
  if (!settings.apiKey) return { ok: false, error: "尚未設定 Gemini API key，請到設定貼上。" };
  const token = await auth.getToken({ interactive: true });
  const inputFolderId = await resolveInputFolder(token, settings);
  const prompt = await resolvePrompt(templateId);
  await ensureOffscreen();
  await chrome.storage.session.set({ status: { stage: "starting", fileName } });
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "process",
    job: { fileId, fileName, token, mode: mode || "audio", byLink: !!byLink, settings: { ...settings, inputFolderId, prompt } },
  });
  return { ok: true };
}

// popup → background
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from === "offscreen") {
    // 持久化最新狀態，供 popup 重開還原
    if (msg.type === "progress") chrome.storage.session.set({ status: { ...msg } });
    if (msg.type === "done") chrome.storage.session.set({ status: { stage: "done", ...msg } });
    if (msg.type === "error") chrome.storage.session.set({ status: { stage: "error", ...msg } });
    return; // 不需回應；popup 也直接收得到
  }
  if (msg?.type === "listRecordings") {
    listRecordings().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === "getFileInfo") {
    fileInfoFromInput(msg.input)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.userMessage || e.message }));
    return true;
  }
  if (msg?.type === "start") {
    chrome.storage.session.remove("status");
    startJob(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
