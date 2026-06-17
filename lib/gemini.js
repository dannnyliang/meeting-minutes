// Gemini 呼叫：小檔走 inlineData，大檔走 File API resumable upload。
// 全程用使用者自己的 key，並套退避重試處理免費 tier 限流。
import { DEFAULT_MODEL, PROMPT, stripCodeFence } from "./prompt.js";
import { toApiError, withRetry, ApiError } from "./backoff.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta";

// 小於此大小（base64 後仍在 ~20MB 請求上限內）走 inline，否則走 File API。
const INLINE_LIMIT = 15 * 1024 * 1024;

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await toApiError(resp);
  return resp.json();
}

function parseResult(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("");
  return { markdown: stripCodeFence(text), usage: data?.usageMetadata || {} };
}

// 走 inlineData：把 bytes base64 直接塞進請求。
async function generateInline(apiKey, model, prompt, base64, mimeType) {
  const url = `${BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      { parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] },
    ],
  };
  return parseResult(await postJson(url, body));
}

// File API resumable upload，回傳 file uri（state=ACTIVE）。
async function uploadFile(apiKey, bytes, mimeType) {
  const numBytes = bytes.byteLength;
  const startResp = await fetch(`${UPLOAD}/files?key=${apiKey}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(numBytes),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "meeting" } }),
  });
  if (!startResp.ok) throw await toApiError(startResp);
  const uploadUrl = startResp.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new ApiError("unknown", "上傳初始化失敗，請重試。");

  const putResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Length": String(numBytes),
    },
    body: bytes,
  });
  if (!putResp.ok) throw await toApiError(putResp);
  let file = (await putResp.json()).file;

  // 輪詢到 ACTIVE。
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${BASE}/files/${file.name.split("/").pop()}?key=${apiKey}`);
    if (!poll.ok) throw await toApiError(poll);
    file = await poll.json();
  }
  if (file.state === "FAILED") throw new ApiError("unknown", "音訊處理失敗，請重試。");
  return file.uri;
}

async function generateFromFile(apiKey, model, prompt, fileUri, mimeType) {
  const url = `${BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }],
  };
  return parseResult(await postJson(url, body));
}

/**
 * 產生會議記錄。
 * @param {ArrayBuffer} bytes 音訊或影片 bytes
 * @param {string} mimeType
 * @param {object} opts { apiKey, attendees, onStatus, onRetry }
 * @returns {{markdown:string, usage:object}}
 */
// 過濾掉 preview / experimental / 帶日期或版本號尾綴的 model，只留正式名稱。
// 想用特殊版本可走設定頁的「自訂…」欄位手動輸入。
function isStableModel(id) {
  if (/-(preview|exp|experimental|tuning|latest|thinking)\b/.test(id)) return false;
  if (/-\d{3,}$/.test(id)) return false; // -001、-002 之類版本號
  if (/-\d{2}-\d{2}$/.test(id)) return false; // -04-17 之類日期
  if (/-\d{4}$/.test(id)) return false; // -1219 之類日期
  return true;
}

/**
 * 用使用者的 key 撈出「真的可叫得到 generateContent」的 Gemini 模型清單。
 * 拿來在設定頁顯示，免得使用者選到 key 沒權限的 model。
 */
export async function listAvailableModels(apiKey) {
  if (!apiKey) throw new ApiError("bad_key", "尚未設定 Gemini API key。");
  const resp = await fetch(`${BASE}/models?key=${apiKey}&pageSize=200`);
  if (!resp.ok) throw await toApiError(resp);
  const data = await resp.json();
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => ({
      id: (m.name || "").replace(/^models\//, ""),
      displayName: m.displayName || m.name,
    }))
    .filter((m) => m.id.startsWith("gemini-") && isStableModel(m.id));
}

export async function generateMinutes(bytes, mimeType, { apiKey, model, prompt, onStatus, onRetry } = {}) {
  if (!apiKey) throw new ApiError("bad_key", "尚未設定 Gemini API key，請到設定貼上。");
  const finalPrompt = prompt || PROMPT;
  const finalModel = (model || "").trim() || DEFAULT_MODEL;

  return withRetry(
    async () => {
      if (bytes.byteLength <= INLINE_LIMIT) {
        onStatus?.("AI 整理中…");
        const base64 = arrayBufferToBase64(bytes);
        return generateInline(apiKey, finalModel, finalPrompt, base64, mimeType);
      }
      onStatus?.("上傳音訊中…");
      const uri = await uploadFile(apiKey, bytes, mimeType);
      onStatus?.("AI 整理中…");
      return generateFromFile(apiKey, finalModel, finalPrompt, uri, mimeType);
    },
    { onRetry }
  );
}
