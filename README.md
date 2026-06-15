# 會議記錄產生器

選一場 Google Meet 錄影，自動產出**繁中逐字稿＋摘要**，存成 Google Doc。
純前端、零後端——每人用自己的 Google 帳號與 Gemini API key。

---

## 安裝（約 3 分鐘，做一次）

1. 取得管理者提供的專案資料夾（zip 解壓到一個**之後不會刪/搬的位置**）。
2. 開 `chrome://extensions` → 右上開啟「**開發人員模式**」→「**載入未封裝項目**」→ 選那個資料夾。
3. 點工具列圖示 → 「前往設定」→ **用 Google 登入**（授權讀雲端硬碟、建立文件）。
4. 貼上**自己的 Gemini API key**（[如何取得](https://aistudio.google.com/apikey)）。

> - 可選：在設定頁指定要掃描的錄影來源資料夾、Doc 的存放位置（預設與來源錄影同資料夾）。
> - Chrome 偶爾會跳「停用開發人員模式擴充功能」提醒，按關閉即可、不要按停用。
> - 更新版本時管理者會重發資料夾，覆蓋舊版後到 `chrome://extensions` 按該套件的「**重新載入**」。

## 怎麼用

點圖示 → 選一場最近的 Meet 錄影 → **產生會議記錄** → 等進度跑完 → 開啟 Google Doc。

來源錄影會自動移到「已處理」，下次清單不再出現它。

## 注意

- 會議音檔會送到 Google Gemini 處理。**免費 key 的內容可能被用於改進模型**；處理機密會議請在 Google Cloud 開**付費** key，資料才不會被用於訓練。
- 超大檔（>200MB）會讓你選「抽語音」或「直接送影片」——抽語音較省，影片較快。
- 一次只處理一支影片；免費 key 遇到限流會自動重試（顯示「自動重試中…」）。

---

<details>
<summary><b>管理者設定（一次性）</b></summary>

派發方式：**未封裝資料夾**，使用者各自載入（小規模內部派發，免費、不上架）。擴充套件要以使用者身份存取 Drive / Docs，需要一個 **Google OAuth client**。

擴充套件 ID 已用 [`manifest.json`](manifest.json) 的 `key` 欄位鎖定，**所有人載入都會是同一個固定 ID**，OAuth 才能共用：

```
mpibdckjdpimekkgdfonmiffbfhhelha
```

> `key` 對應的私鑰在 `extension-key.pem`（已 gitignore），請離線保管、**勿放進派發的 zip**；只有日後要改打包成 .crx 才會用到。

1. **建 OAuth client**（[GCP Console](https://console.cloud.google.com/)）：
   - 啟用 **Google Drive API**。
   - OAuth 同意畫面選 **Internal** 並**發布**（勿停在 Testing，否則 token 7 天過期、上限 100 人）。
   - 憑證 → 建立 OAuth client ID → 類型 **Chrome 擴充功能** → 填上面那個固定 ID。
2. 把產生的 client ID 填進 [`manifest.json`](manifest.json) 的 `oauth2.client_id`（取代現有的舊值）。
3. **打包派發**：把專案根資料夾壓成 zip 發給使用者（排除 `extension-key.pem`、`node_modules/`）。改版後重發、請使用者覆蓋並「重新載入」。

</details>

<details>
<summary><b>本地開發</b></summary>

```
chrome://extensions → 開「開發人員模式」→ 載入未封裝項目 → 選專案根資料夾
```

改完程式碼按「重新載入」。執行時只需 `vendor/` 內已複製好的 ffmpeg 檔；要重建可 `npm install`（`node_modules/` 已 gitignore）。

**架構**

```
popup.js ──┐                        ┌─ lib/drive.js  (Drive/Docs，使用者 OAuth)
           ├─ background.js (協調) ──┤
options.js─┘     │                  └─ lib/auth.js   (chrome.identity)
                 ▼
           offscreen.js (流程編排) ──┬─ lib/ffmpeg.js  (WORKERFS 抽音)
                                     ├─ lib/gemini.js  (inline/File API + 退避重試)
                                     └─ lib/prompt.js / backoff.js
```

**驗證（發版前跑一輪）**：短檔正常產出（## 會議摘要 / ## 逐字稿、來源移到「已處理」、popup 可開 Doc）→ >200MB 大檔走「直接送影片」→ 免費 key 連跑看到「自動重試中…」。

**已知限制**：超大檔（GB 級）`ffmpeg.wasm` 抽音較慢；尚未注入 Drive 介面按鈕、無首次使用引導（Phase B）。

</details>
