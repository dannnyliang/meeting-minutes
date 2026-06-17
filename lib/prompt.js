// 會議記錄的 prompt 與輸出後處理。

export const DEFAULT_MODEL = "gemini-2.5-flash";

export const PROMPT = `你是專業的繁體中文會議記錄員。請聽完這段會議錄音，輸出一份 Markdown 文件，**全程使用繁體中文**，包含以下兩大區塊：

## 會議摘要

- **TL;DR**：3 句話內講完這場會議的重點。
- **與會人員**：能辨識出的發言者（若無名字，用「發言者 A／B」標記）。
- **決議事項**：條列已拍板的結論。
- **待辦事項**：條列 action items，每項標註〔負責人〕與〔期限〕，無法辨識則寫「未明確」。
- **主要討論議題**：依主題分段，摘要各議題的討論脈絡與不同意見。

## 逐字稿

- 依時間順序輸出完整逐字稿。
- 盡量標註發言者與大致時間點（如有）。
- 修正明顯的口語贅字與辨識錯字，但不要改變原意。

只輸出 Markdown 內容本身，不要額外的開場白或結尾。`;

// 若提供與會者名單，補一段提示讓模型用真實名字（解決講者命名不一致）。
export function buildPrompt(attendees) {
  const names = (attendees || []).map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return PROMPT;
  return (
    PROMPT +
    `\n\n本場與會者可能包含：${names.join("、")}。請盡量用這些真實名字標註發言者。`
  );
}

// 模型有時把整份輸出包在 ```markdown ... ``` 圍欄裡，剝掉外層。
export function stripCodeFence(text) {
  let t = (text || "").trim();
  if (t.startsWith("```")) {
    const lines = t.split("\n");
    lines.shift(); // 去掉開頭 ```markdown
    if (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
    t = lines.join("\n");
  }
  return t.trim();
}
