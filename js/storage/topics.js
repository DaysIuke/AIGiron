// storage/topics.js — 議題の履歴（FR-12-03）。localStorage に文字列配列で持つ。

const KEY = "aigiron_topics_v1";
const MAX_TOPICS = 15;

export function loadTopics() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((t) => typeof t === "string" && t.trim()) : [];
  } catch {
    return [];
  }
}

// 直近を先頭に、重複は先頭へ寄せて1件に。上限を超えたら古いものから捨てる。
export function pushTopic(text) {
  const t = String(text ?? "").trim();
  if (!t) return loadTopics();
  const list = [t, ...loadTopics().filter((x) => x !== t)].slice(0, MAX_TOPICS);
  // レビュー: presets.js と同じ理由（失敗が完全に無痕跡になる）で console.warn だけ足す。
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch (e) { console.warn("議題履歴の保存に失敗しました", e); }
  return list;
}
