// 設定頁邏輯。
import * as auth from "./lib/auth.js";
import * as drive from "./lib/drive.js";
import { ensureSeeded, saveTemplates } from "./lib/templates.js";
import { DEFAULT_MODEL } from "./lib/prompt.js";
import { listAvailableModels } from "./lib/gemini.js";

// 撈不到清單時的 fallback（離線、key 還沒存等情境）。
const FALLBACK_MODELS = [
  { id: "gemini-2.5-flash", displayName: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash-lite", displayName: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", displayName: "Gemini 2.0 Flash" },
];

let savedModel = DEFAULT_MODEL;

const $ = (id) => document.getElementById(id);

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  setTimeout(() => t.classList.add("hidden"), 1800);
}

async function refreshSignIn() {
  $("redirectUrl").value = chrome.identity.getRedirectURL();
  const signedIn = await auth.isSignedIn();
  $("signInStatus").textContent = signedIn ? "已登入 ✓" : "尚未登入";
  $("signInBtn").classList.toggle("hidden", signedIn);
  $("signOutBtn").classList.toggle("hidden", !signedIn);
}

// 暫存目前選到的資料夾（id + name）
let inputFolder = { id: "", name: "" };
let outputFolder = { id: "", name: "" }; // 空 = 與來源相同

async function load() {
  const d = await chrome.storage.local.get([
    "apiKey",
    "model",
    "systemInstruction",
    "inputFolderId",
    "inputFolderName",
    "outputFolderId",
    "outputFolderName",
    "processedFolderName",
  ]);
  if (d.apiKey) $("apiKey").placeholder = "已儲存（重貼可更新）";
  savedModel = d.model || DEFAULT_MODEL;
  $("systemInstruction").value = d.systemInstruction || "";
  renderModels(FALLBACK_MODELS);
  if (d.apiKey) refreshModels({ silent: true });
  inputFolder = { id: d.inputFolderId || "", name: d.inputFolderName || "" };
  outputFolder = { id: d.outputFolderId || "", name: d.outputFolderName || "" };
  if (inputFolder.name) $("inputFolderName").value = inputFolder.name;
  if (outputFolder.name) $("outputFolderName").value = outputFolder.name;
  $("processedFolderName").value = d.processedFolderName || "";
  await refreshSignIn();
  await initTemplates();
}

// 用一份模型清單（fallback 或實際撈到的）重畫 select，並把儲存值還原進去。
function renderModels(models) {
  const sel = $("modelSelect");
  const custom = $("modelCustom");
  sel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.displayName ? `${m.id} — ${m.displayName}` : m.id;
    sel.append(opt);
  }
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "自訂…";
  sel.append(customOpt);

  const known = models.some((m) => m.id === savedModel);
  if (known) {
    sel.value = savedModel;
    custom.value = "";
    custom.classList.add("hidden");
  } else {
    sel.value = "__custom__";
    custom.value = savedModel;
    custom.classList.remove("hidden");
  }
}

function setModelStatus(text, kind) {
  const el = $("modelStatus");
  el.textContent = text;
  el.classList.remove("warn", "muted");
  el.classList.add(kind === "warn" ? "warn" : "muted");
}

async function refreshModels({ silent = false } = {}) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) {
    if (!silent) setModelStatus("請先儲存 API key 才能載入清單。", "warn");
    return;
  }
  setModelStatus("讀取可用模型中…");
  try {
    const models = await listAvailableModels(apiKey);
    if (!models.length) {
      setModelStatus("這把 key 沒有可用的 Gemini 模型，請確認方案或換 key。", "warn");
      return;
    }
    renderModels(models);
    setModelStatus(`✓ 已偵測 ${models.length} 個可用模型。`);
  } catch (e) {
    setModelStatus(`讀取失敗：${e.userMessage || e.message}`, "warn");
  }
}

// ── 資料夾選擇器（逐層瀏覽真實 Drive 結構）──────────────
let pickTarget = null; // "input" | "output"
let stack = []; // 麵包屑路徑，最後一個為目前所在資料夾 {id, name, pseudo?}

const current = () => stack[stack.length - 1];

function openPicker(target) {
  pickTarget = target;
  $("folderModalTitle").textContent = target === "input" ? "選擇輸入資料夾" : "選擇輸出資料夾";
  $("folderModal").classList.remove("hidden");
  enterRoot("myDrive");
}

function closePicker() {
  $("folderModal").classList.add("hidden");
}

function enterRoot(mode) {
  $("rootMyDrive").classList.toggle("active", mode === "myDrive");
  $("rootShared").classList.toggle("active", mode === "shared");
  stack =
    mode === "shared"
      ? [{ id: "__shared__", name: "與我共用", pseudo: true }]
      : [{ id: "root", name: "我的雲端硬碟" }];
  loadChildren();
}

function enterFolder(f) {
  stack.push({ id: f.id, name: f.name });
  loadChildren();
}

function gotoCrumb(index) {
  stack = stack.slice(0, index + 1);
  loadChildren();
}

function renderCrumb() {
  const c = $("folderCrumb");
  c.innerHTML = "";
  stack.forEach((node, i) => {
    if (i > 0) c.append(document.createTextNode(" › "));
    const a = document.createElement("span");
    a.className = "crumb-link";
    a.textContent = node.name;
    a.onclick = () => gotoCrumb(i);
    c.append(a);
  });
}

async function loadChildren() {
  renderCrumb();
  const cur = current();
  $("folderCurrentName").textContent = cur.pseudo ? "" : `將選擇：${cur.name}`;
  $("folderPickCurrent").disabled = !!cur.pseudo;
  const ul = $("folderResults");
  ul.innerHTML = "<li class='muted'>讀取中…</li>";
  try {
    const token = await auth.getToken({ interactive: true });
    const folders = cur.id === "__shared__"
      ? await drive.listSharedFolders(token)
      : await drive.listChildFolders(token, cur.id);
    ul.innerHTML = "";
    if (!folders.length) {
      ul.innerHTML = "<li class='muted'>（這層沒有子資料夾）</li>";
      return;
    }
    for (const f of folders) {
      const li = document.createElement("li");
      li.className = "folder-item";
      const name = document.createElement("span");
      name.textContent = f.name;
      const arrow = document.createElement("span");
      arrow.className = "muted";
      arrow.textContent = "›";
      li.append(name, arrow);
      li.onclick = () => enterFolder(f);
      ul.append(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class='muted'>讀取失敗：${e.message}</li>`;
  }
}

function pickCurrent() {
  const cur = current();
  if (cur.pseudo) return;
  if (pickTarget === "input") {
    inputFolder = { id: cur.id, name: cur.name };
    $("inputFolderName").value = cur.name;
  } else {
    outputFolder = { id: cur.id, name: cur.name };
    $("outputFolderName").value = cur.name;
  }
  closePicker();
}

$("pickInput").onclick = () => openPicker("input");
$("pickOutput").onclick = () => openPicker("output");
$("folderClose").onclick = closePicker;
$("rootMyDrive").onclick = () => enterRoot("myDrive");
$("rootShared").onclick = () => enterRoot("shared");
$("folderPickCurrent").onclick = pickCurrent;
$("clearOutput").onclick = () => {
  outputFolder = { id: "", name: "" };
  $("outputFolderName").value = "";
  toast("輸出改為「與來源相同資料夾」");
};

// ── 模板管理 ──────────────────────────────
let templates = [];
let defaultId = "";
let editId = null;

function renderTemplates() {
  const ul = $("templateList");
  ul.innerHTML = "";
  for (const t of templates) {
    const li = document.createElement("li");
    li.className = "template-item";

    const left = document.createElement("label");
    left.className = "tpl-default";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "defaultTpl";
    radio.checked = t.id === defaultId;
    radio.onchange = () => setDefault(t.id);
    const nm = document.createElement("span");
    nm.textContent = t.name;
    left.append(radio, nm);

    const edit = document.createElement("button");
    edit.className = "link";
    edit.textContent = "編輯";
    edit.onclick = () => openEditor(t);
    const del = document.createElement("button");
    del.className = "link";
    del.textContent = "刪除";
    del.onclick = () => deleteTemplate(t.id);

    const actions = document.createElement("div");
    actions.append(edit, del);
    li.append(left, actions);
    ul.append(li);
  }
}

function openEditor(t) {
  editId = t ? t.id : null;
  $("tplName").value = t ? t.name : "";
  $("tplPrompt").value = t ? t.prompt : "";
  $("templateEditor").classList.remove("hidden");
  $("tplName").focus();
}

async function persistTemplates() {
  await saveTemplates(templates, defaultId);
}

async function setDefault(id) {
  defaultId = id;
  await persistTemplates();
  toast("已設為預設模板");
}

async function deleteTemplate(id) {
  if (templates.length <= 1) return toast("至少保留一個模板");
  templates = templates.filter((t) => t.id !== id);
  if (defaultId === id) defaultId = templates[0].id;
  await persistTemplates();
  renderTemplates();
  toast("已刪除模板");
}

$("addTemplate").onclick = () => openEditor(null);
$("tplCancel").onclick = () => $("templateEditor").classList.add("hidden");
$("tplSave").onclick = async () => {
  const name = $("tplName").value.trim();
  const prompt = $("tplPrompt").value.trim();
  if (!name || !prompt) return toast("請填模板名稱與內容");
  if (editId) {
    const t = templates.find((x) => x.id === editId);
    if (t) { t.name = name; t.prompt = prompt; }
  } else {
    const t = { id: crypto.randomUUID(), name, prompt };
    templates.push(t);
    if (!defaultId) defaultId = t.id;
  }
  await persistTemplates();
  renderTemplates();
  $("templateEditor").classList.add("hidden");
  toast("已儲存模板");
};

async function initTemplates() {
  const seeded = await ensureSeeded();
  templates = seeded.templates;
  defaultId = seeded.defaultId;
  renderTemplates();
}

// ── 儲存 ──────────────────────────────
$("signInBtn").onclick = async () => {
  try {
    await auth.getToken({ interactive: true });
    toast("登入成功");
  } catch (e) {
    toast("登入失敗：" + e.message);
  }
  refreshSignIn();
};

$("signOutBtn").onclick = async () => {
  await auth.signOut();
  toast("已登出");
  refreshSignIn();
};

$("copyRedirect").onclick = async () => {
  await navigator.clipboard.writeText($("redirectUrl").value);
  toast("已複製 redirect URL");
};

$("saveKey").onclick = async () => {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) return toast("請先貼上 key");
  await chrome.storage.local.set({ apiKey });
  $("apiKey").value = "";
  $("apiKey").placeholder = "已儲存（重貼可更新）";
  toast("已儲存 API key");
  refreshModels();
};

$("saveSystemInstruction").onclick = async () => {
  await chrome.storage.local.set({ systemInstruction: $("systemInstruction").value.trim() });
  toast("已儲存系統指令");
};

$("refreshModels").onclick = () => refreshModels();

$("modelSelect").onchange = () => {
  const sel = $("modelSelect");
  const custom = $("modelCustom");
  if (sel.value === "__custom__") {
    custom.classList.remove("hidden");
    custom.focus();
  } else {
    custom.classList.add("hidden");
  }
};

$("saveModel").onclick = async () => {
  const sel = $("modelSelect");
  const custom = $("modelCustom").value.trim();
  const model = sel.value === "__custom__" ? custom : sel.value;
  if (!model) return toast("請填模型代號");
  await chrome.storage.local.set({ model });
  savedModel = model;
  toast(`已儲存模型：${model}`);
};

$("saveAdvanced").onclick = async () => {
  await chrome.storage.local.set({
    inputFolderId: inputFolder.id,
    inputFolderName: inputFolder.name,
    outputFolderId: outputFolder.id,
    outputFolderName: outputFolder.name,
    processedFolderName: $("processedFolderName").value.trim() || "已處理",
  });
  toast("已儲存資料夾設定");
};

load();
