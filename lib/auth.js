// Google OAuth：用 chrome.identity.launchWebAuthFlow 取得使用者自己的 access token。
// 改用 launchWebAuthFlow（標準 OAuth 網頁授權）而非 Chrome 專屬的 getAuthToken，
// 讓 Arc / Edge / Brave 等 Chromium 瀏覽器也能登入。
// Doc/Drive 操作都以「使用者本人」身份進行 → Doc 歸屬本人、只碰他有權限的檔。
//
// ⚠️ 設定需求：manifest 的 oauth2.client_id 必須是「Web 應用程式」類型的 OAuth client，
//    且在 Google Cloud Console 把這支擴充套件的 redirect URL 加進「已授權的重新導向 URI」。
//    redirect URL = chrome.identity.getRedirectURL()，可在設定頁複製（見 options）。

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_CACHE_KEY = "oauthToken"; // { token, expiresAt }
const EXPIRY_BUFFER_MS = 60 * 1000; // 提早 60 秒視為過期，留操作餘裕

function getConfig() {
  const m = chrome.runtime.getManifest();
  const clientId = m.oauth2?.client_id || "";
  const scopes = m.oauth2?.scopes || [];
  if (!clientId) throw new Error("缺少 OAuth client_id，請檢查 manifest.json");
  return { clientId, scopes };
}

// 啟動授權視窗，回傳新的 { token, expiresAt }。
function launch({ interactive }) {
  const { clientId, scopes } = getConfig();
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "token", // implicit flow：直接拿 access_token，不需 client secret
    redirect_uri: redirectUri,
    scope: scopes.join(" "),
  });
  if (!interactive) params.set("prompt", "none"); // 靜默：需要互動就直接失敗
  const authUrl = `${AUTH_ENDPOINT}?${params.toString()}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (redirect) => {
      if (chrome.runtime.lastError || !redirect) {
        reject(new Error(chrome.runtime.lastError?.message || "無法取得 Google 授權"));
        return;
      }
      // 回呼網址形如 https://<id>.chromiumapp.org/#access_token=...&expires_in=3599
      const frag = redirect.split("#")[1] || redirect.split("?")[1] || "";
      const out = new URLSearchParams(frag);
      const token = out.get("access_token");
      if (!token) {
        reject(new Error(out.get("error_description") || out.get("error") || "授權回應沒有 token"));
        return;
      }
      const expiresIn = Number(out.get("expires_in")) || 3600;
      resolve({ token, expiresAt: Date.now() + expiresIn * 1000 });
    });
  });
}

async function getCached() {
  const { [TOKEN_CACHE_KEY]: c } = await chrome.storage.local.get(TOKEN_CACHE_KEY);
  if (c?.token && c.expiresAt - EXPIRY_BUFFER_MS > Date.now()) return c.token;
  return null;
}

// 取得 access token：先用快取，過期或無快取才走授權流程。
export async function getToken({ interactive = true } = {}) {
  const cached = await getCached();
  if (cached) return cached;
  const fresh = await launch({ interactive });
  await chrome.storage.local.set({ [TOKEN_CACHE_KEY]: fresh });
  return fresh.token;
}

// token 失效時清掉快取，下次重新取得。
export async function removeCachedToken() {
  await chrome.storage.local.remove(TOKEN_CACHE_KEY);
}

// 是否已登入（非互動式拿得到 token 就算）。
export async function isSignedIn() {
  try {
    await getToken({ interactive: false });
    return true;
  } catch (_) {
    return false;
  }
}

// 撤銷授權（登出）。
export async function signOut() {
  try {
    const token = await getCached();
    if (token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" });
    }
  } catch (_) {
  } finally {
    await removeCachedToken();
  }
}
