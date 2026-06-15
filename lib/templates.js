// 會議記錄「模板」管理：使用者可新增多個 prompt 模板，現有 PROMPT 當預設範本。
import { PROMPT } from "./prompt.js";

const KEY = "templates";
const DEF = "defaultTemplateId";

const SEED = {
  name: "預設（摘要＋逐字稿）",
  prompt: PROMPT,
};

export async function getTemplates() {
  const d = await chrome.storage.local.get([KEY, DEF]);
  return { templates: d[KEY] || [], defaultId: d[DEF] || "" };
}

export async function saveTemplates(templates, defaultId) {
  await chrome.storage.local.set({ [KEY]: templates, [DEF]: defaultId });
}

// 首次使用時種一個預設模板，回傳最新狀態。
export async function ensureSeeded() {
  const { templates, defaultId } = await getTemplates();
  if (templates.length) return { templates, defaultId: defaultId || templates[0].id };
  const seeded = [{ id: crypto.randomUUID(), ...SEED }];
  await saveTemplates(seeded, seeded[0].id);
  return { templates: seeded, defaultId: seeded[0].id };
}

// 依 id 解析出要用的 prompt 文字；找不到就用預設模板，再不行就用內建 PROMPT。
export async function resolvePrompt(templateId) {
  const { templates, defaultId } = await ensureSeeded();
  const pick =
    templates.find((t) => t.id === templateId) ||
    templates.find((t) => t.id === defaultId) ||
    templates[0];
  return pick?.prompt || PROMPT;
}
