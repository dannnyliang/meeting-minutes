# 會議記錄產生器 — 專案說明

Chrome（Manifest V3）擴充套件：選一場 Google Meet 錄影，抽語音 → Gemini 整理 → 存成 Google Doc。
散布方式：使用者下載 GitHub release 的 zip，解壓後在 `chrome://extensions` 載入。

## 發布流程（每次出新版都要照做，缺一不可）

> 觸發語：當使用者說「發布 / 出版 / 推 vX.Y.Z」時，**完整跑完以下 1～6 步**。
> 過去常漏掉 tag 與 GitHub release，務必確認到第 6 步都完成。

1. **改版號** — 同步改 `manifest.json` 與 `package.json` 的 `version`（兩個都要）。
2. **commit** — 訊息格式 `release: vX.Y.Z — <一句重點>`，沿用 git log 既有風格。
3. **push** — `git push origin main`。
4. **建 tag 並推** — lightweight tag，對齊既有格式：
   `git tag vX.Y.Z && git push origin vX.Y.Z`
5. **打包 zip** — `bash scripts/package.sh`，產出 `meeting-minutes-vX.Y.Z.zip`（已被 gitignore，不進版控）。
6. **建 GitHub release 並附 zip**：
   ```
   gh release create vX.Y.Z --title vX.Y.Z --notes "<更新說明>" meeting-minutes-vX.Y.Z.zip
   ```
   release notes 用非技術讀者看得懂的話寫「## 更新」＋「## 安裝」兩段（參考既有 release）。

完成後回報：commit hash、tag、release URL 三者都列出來，確認沒漏。

## 打包內容（scripts/package.sh 維護）

zip 只收執行期檔案：根目錄 html/js/css、`README.md`、`icons/`、`lib/`、`vendor/`。
**排除** `node_modules`、`package*.json`、`.git`、`.env`、`*.pem`、開發雜物。

## OAuth 設定（首次架設 / 換環境才需要）

登入走 `chrome.identity.launchWebAuthFlow`（標準網頁授權，跨 Chromium 瀏覽器通用），
不是 Chrome 專屬的 `getAuthToken`。設定需求：

- `manifest.json` 的 `oauth2.client_id` 必須是 **Google Cloud Console「Web 應用程式」類型** 的 OAuth client。
- 該 client 的「已授權的重新導向 URI」要加入本套件的 redirect URL
  （`chrome.identity.getRedirectURL()`，可在設定頁「OAuth 設定」區複製）。
- `manifest.json` 有 `key` 欄位，擴充套件 ID 固定，故 redirect URL 對所有安裝者一致。

## 已知限制

- OAuth token（implicit flow）約 1 小時到期；單一超大檔處理逾時可能 401。沿用舊行為，未處理。
