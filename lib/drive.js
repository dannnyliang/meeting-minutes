// Drive / Docs 操作，全部用使用者的 OAuth token。
import { toApiError } from "./backoff.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

async function api(token, url, opts = {}) {
  const resp = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!resp.ok) throw await toApiError(resp);
  return resp;
}

function q(query) {
  return encodeURIComponent(query);
}

// 找指定名稱的資料夾，回傳 id 或 null。
export async function findFolder(token, name, parentId = null) {
  let query = `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (parentId) query += ` and '${parentId}' in parents`;
  const url = `${DRIVE}/files?q=${q(query)}&fields=files(id,name)&pageSize=1`;
  const resp = await api(token, url);
  const { files } = await resp.json();
  return files?.[0]?.id || null;
}

// 找不到就建立，回傳資料夾 id。
export async function getOrCreateFolder(token, name, parentId = null) {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  const body = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    ...(parentId ? { parents: [parentId] } : {}),
  };
  const resp = await api(token, `${DRIVE}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await resp.json()).id;
}

// 找 Meet 自動錄影資料夾（通常叫 "Meet Recordings"）。
export async function findMeetRecordingsFolder(token) {
  return (
    (await findFolder(token, "Meet Recordings")) ||
    (await findFolder(token, "Meet 錄影"))
  );
}

// 搜尋資料夾（供 options 的資料夾選擇器）。
// 只列「你自己擁有」的資料夾（'me' in owners），避免列出一堆別人分享給你的目錄。
export async function searchFolders(token, nameQuery = "") {
  let query =
    "mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'me' in owners";
  if (nameQuery) query += ` and name contains '${nameQuery.replace(/'/g, "\\'")}'`;
  // 無關鍵字時用「最近異動」排序讓常用資料夾浮上來；有關鍵字時用名稱排序。
  const orderBy = nameQuery ? "name" : "modifiedByMeTime desc";
  const url = `${DRIVE}/files?q=${q(query)}&fields=files(id,name)&orderBy=${encodeURIComponent(orderBy)}&pageSize=50`;
  const resp = await api(token, url);
  return (await resp.json()).files || [];
}

// 列出某資料夾的子資料夾（供逐層瀏覽）。parentId 可用 'root' 代表我的雲端硬碟。
export async function listChildFolders(token, parentId) {
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `${DRIVE}/files?q=${q(query)}&fields=files(id,name)&orderBy=name&pageSize=200`;
  const resp = await api(token, url);
  return (await resp.json()).files || [];
}

// 列出「與我共用」最上層的資料夾。
export async function listSharedFolders(token) {
  const query =
    "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const url = `${DRIVE}/files?q=${q(query)}&fields=files(id,name)&orderBy=name&pageSize=200`;
  const resp = await api(token, url);
  return (await resp.json()).files || [];
}

// 取得單一檔案的 metadata（name + parents）。
export async function getFileMeta(token, fileId) {
  const resp = await api(token, `${DRIVE}/files/${fileId}?fields=id,name,parents`);
  return await resp.json();
}

// 列出某資料夾下的影片（排除子資料夾即排除「已處理」）。
export async function listRecordings(token, folderId, { pageSize = 25 } = {}) {
  const query = `'${folderId}' in parents and mimeType contains 'video/' and trashed = false`;
  const url =
    `${DRIVE}/files?q=${q(query)}` +
    `&fields=files(id,name,size,createdTime,videoMediaMetadata(durationMillis))` +
    `&orderBy=createdTime desc&pageSize=${pageSize}`;
  const resp = await api(token, url);
  return (await resp.json()).files || [];
}

// 下載檔案內容為 Blob，附下載進度回呼。
export async function downloadFile(token, fileId, onProgress) {
  const resp = await api(token, `${DRIVE}/files/${fileId}?alt=media`);
  const total = Number(resp.headers.get("Content-Length")) || 0;
  if (!resp.body || !onProgress || !total) return await resp.blob();

  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded / total);
  }
  return new Blob(chunks);
}

// 取得檔案目前所在的 parent 資料夾 ids。
export async function getParents(token, fileId) {
  const resp = await api(token, `${DRIVE}/files/${fileId}?fields=parents`);
  return (await resp.json()).parents || [];
}

// 把檔案從一個資料夾移到另一個（改 parents）→ 用來搬到「已處理」。
export async function moveFile(token, fileId, addParentId, removeParentId) {
  const url =
    `${DRIVE}/files/${fileId}?addParents=${addParentId}` +
    `&removeParents=${removeParentId}&fields=id,parents`;
  const resp = await api(token, url, { method: "PATCH" });
  return await resp.json();
}

// 用 markdown 匯入建立 Google Doc（Google 自動轉排版），回傳 {id, webViewLink}。
export async function createDocFromMarkdown(token, name, markdown, parentFolderId) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.document",
    ...(parentFolderId ? { parents: [parentFolderId] } : {}),
  };
  const boundary = "----meetingminutes" + Math.random().toString(16).slice(2);
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
    markdown +
    `\r\n--${boundary}--`;

  const resp = await api(
    token,
    `${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  return await resp.json();
}
