// summarize.js — Chrome 内蔵 Summarizer のラッパ（BD §9）。
// 使えないときは null を返し、engine は切り詰めで代替する。日本語対応は Chrome 149 以降。

// 可用性の判定と生成で同じ言語の組を使う。食い違っていると、設定画面が
// 「利用できます」と出したのに create() が投げて無言で null になる。
const LANGS = ["ja", "en"];

export async function detectSummarizer() {
  if (!("Summarizer" in self)) return { state: "unsupported" };
  try {
    const a = await Summarizer.availability({ expectedInputLanguages: LANGS });
    return { state: a };   // "available" | "downloadable" | "downloading" | "unavailable"
  } catch {
    return { state: "unavailable" };
  }
}

// available のときだけ作る。downloadable のダウンロード開始はユーザーの明示操作から呼ぶ。
export async function createSummarizer({ allowDownload = false } = {}) {
  const { state } = await detectSummarizer();
  if (state === "unsupported" || state === "unavailable") return null;
  if (state !== "available" && !allowDownload) return null;
  try {
    const s = await Summarizer.create({
      type: "tldr",
      format: "plain-text",
      length: "short",
      expectedInputLanguages: LANGS
    });
    return {
      async summarize(text) {
        // 長すぎる入力はそのまま投げず先頭を使う（要約対象は1ラウンド分なので通常は収まる）
        const t = String(text ?? "").slice(0, 8000);
        const out = await s.summarize(t);
        return out && out.trim() ? out.trim() : null;
      }
    };
  } catch {
    return null;
  }
}
