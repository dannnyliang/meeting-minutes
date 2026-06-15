// ffmpeg.wasm 包裝（在 offscreen document 內跑）。
// 用 WORKERFS 掛載輸入 Blob 供讀取，不複製進 wasm heap → 可處理大檔；輸出小音檔走 MEMFS。
import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { FFFSType } from "../vendor/ffmpeg/index.js";

let ffmpeg = null;

async function ensureLoaded(onLog) {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL("vendor/core/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("vendor/core/ffmpeg-core.wasm"),
  });
  return ffmpeg;
}

/**
 * 從影片 Blob 抽出 mono 16kHz m4a。
 * @param {Blob} blob 影片內容
 * @param {string} inputExt 副檔名（不含點），如 "mp4"
 * @param {(p:number)=>void} onProgress 0..1
 * @returns {{bytes: ArrayBuffer, mimeType: string}}
 */
export async function extractAudio(blob, inputExt = "mp4", onProgress) {
  const fm = await ensureLoaded();
  const mountDir = "/in";
  const inputName = `input.${inputExt}`;
  const outputName = "output.m4a";

  if (onProgress) {
    fm.on("progress", ({ progress }) => onProgress(Math.min(Math.max(progress, 0), 1)));
  }

  await fm.createDir(mountDir).catch(() => {});
  // WORKERFS 掛載：以 blob 供讀取，避免整檔進記憶體。
  await fm.mount(FFFSType.WORKERFS, { blobs: [{ name: inputName, data: blob }] }, mountDir);

  try {
    await fm.exec([
      "-i", `${mountDir}/${inputName}`,
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "aac", "-b:a", "64k",
      outputName,
    ]);
    const data = await fm.readFile(outputName); // Uint8Array
    return { bytes: data.buffer, mimeType: "audio/mp4" };
  } finally {
    await fm.unmount(mountDir).catch(() => {});
    await fm.deleteFile(outputName).catch(() => {});
  }
}
