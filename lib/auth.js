// Google OAuth：用 chrome.identity 取得使用者自己的 access token。
// Doc/Drive 操作都以「使用者本人」身份進行 → Doc 歸屬本人、只碰他有權限的檔。

export function getToken({ interactive = true } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "無法取得 Google 授權"));
        return;
      }
      resolve(token);
    });
  });
}

// token 失效時清掉快取，下次重新取得。
export function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
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
    const token = await getToken({ interactive: false });
    await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" });
    await removeCachedToken(token);
  } catch (_) {}
}
