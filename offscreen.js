// Offscreen document：實際跑整段處理流程（需要 DOM 才能跑 ffmpeg.wasm worker）。
// 由 background 透過訊息觸發；進度用 chrome.runtime 廣播給 popup。
import * as drive from "./lib/drive.js";
import { generateMinutes } from "./lib/gemini.js";
import { extractAudio } from "./lib/ffmpeg.js";
import { ApiError } from "./lib/backoff.js";

function emit(msg) {
  chrome.runtime.sendMessage({ from: "offscreen", ...msg }).catch(() => {});
}
function progress(stage, detail = {}) {
  emit({ type: "progress", stage, ...detail });
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return (m ? m[1] : "mp4").toLowerCase();
}
function baseName(name) {
  return (name || "會議記錄").replace(/\.[^.]+$/, "");
}

async function process(job) {
  const { fileId, fileName, token, mode, settings } = job;
  const { apiKey, prompt, inputFolderId, outputFolderId, processedFolderName } = settings;

  // 先取得來源檔的所在資料夾（決定預設輸出位置與移檔來源）
  const meta = await drive.getFileMeta(token, fileId);
  const sourceParent = meta.parents?.[0] || inputFolderId;

  // 1. 下載
  progress("download", { pct: 0 });
  const blob = await drive.downloadFile(token, fileId, (p) =>
    progress("download", { pct: p })
  );

  // 2. 取得 bytes：抽音 或 直送影片
  let bytes, mimeType;
  if (mode === "video") {
    progress("prepare");
    bytes = await blob.arrayBuffer();
    mimeType = "video/mp4";
  } else {
    progress("extract", { pct: 0 });
    try {
      const out = await extractAudio(blob, extOf(fileName), (p) =>
        progress("extract", { pct: p })
      );
      bytes = out.bytes;
      mimeType = out.mimeType;
    } catch (err) {
      // 抽音失敗 → 讓 popup 提供「改用直送影片」重試
      emit({ type: "error", kind: "extract_failed", message: "抽取語音失敗，要改用「直接送影片」重試嗎？" });
      return;
    }
  }

  // 3. Gemini 一條龍
  const { markdown, usage } = await generateMinutes(bytes, mimeType, {
    apiKey,
    prompt,
    onStatus: (s) => progress("ai", { note: s }),
    onRetry: ({ attempt, waitMs }) =>
      progress("ai", { note: `限流，自動重試中（第 ${attempt} 次，約 ${Math.round(waitMs / 1000)}s）…` }),
  });

  // 4. 建立 Google Doc：預設放來源檔所在資料夾；有指定輸出資料夾才放那裡
  progress("doc");
  const outFolderId = outputFolderId || sourceParent;
  const doc = await drive.createDocFromMarkdown(token, baseName(fileName), markdown, outFolderId);

  // 5. 成功後才移動來源檔到「已處理」（失敗不毀資料）
  // 「已處理」固定建在輸入資料夾下（用穩定的 inputFolderId，避免每次依個別 parent 而巢狀）。
  try {
    const baseFolder = inputFolderId || sourceParent;
    const processedId = await drive.getOrCreateFolder(token, processedFolderName || "已處理", baseFolder);
    // 來源已在「已處理」就不重複搬，避免 已處理/已處理 巢狀。
    if (sourceParent && sourceParent !== processedId) {
      await drive.moveFile(token, fileId, processedId, sourceParent);
    }
  } catch (_) {
    // 移檔失敗不影響已產生的 Doc，只是下次列表還會看到它
  }

  emit({ type: "done", docLink: doc.webViewLink, docId: doc.id, usage, fileName });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen" || msg.type !== "process") return;
  process(msg.job).catch((err) => {
    const e = err instanceof ApiError ? err : null;
    emit({
      type: "error",
      kind: e?.kind || "unknown",
      message: e?.userMessage || "發生未預期的錯誤，請重試。",
    });
  });
});
