// storage/presets.js — 参加AIの編成をプリセットとして保存・呼び出す（FR-02-06）。
// APIキーは含まない。プロバイダ・モデル・名前・見た目・立場・ペルソナだけを保存する。

const KEY = "aigiron_presets_v1";
const MAX_PRESETS = 20;

// id・roleIndex・status 等の実行時フィールドは保存しない（呼び出し時に組み直す）。
function pluck(agent) {
  return {
    name: agent.name, provider: agent.provider, model: agent.model,
    colorIndex: agent.colorIndex, shapeIndex: agent.shapeIndex,
    stance: agent.stance ?? null, persona: agent.persona ?? ""
  };
}

export function loadPresets() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((p) => p && typeof p.name === "string" && Array.isArray(p.agents))
      : [];
  } catch {
    return [];
  }
}

// 同名があれば上書きして先頭へ。無ければ新規に先頭へ追加。
export function savePreset(name, agents) {
  const n = String(name ?? "").trim();
  if (!n || !agents?.length) return loadPresets();
  const entry = { name: n, agents: agents.map(pluck), savedAt: Date.now() };
  const list = [entry, ...loadPresets().filter((p) => p.name !== n)].slice(0, MAX_PRESETS);
  // レビュー: 失敗を完全に握りつぶすと devtools を開かない限り原因究明の手段が無い。
  //   ユーザー通知までは行わない（症状対処）が、痕跡だけは残す。
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch (e) { console.warn("プリセットの保存に失敗しました", e); }
  return list;
}

export function deletePreset(name) {
  const list = loadPresets().filter((p) => p.name !== name);
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch (e) { console.warn("プリセットの削除に失敗しました", e); }
  return list;
}

// プリセットの agents を、編成エディタが期待する形（id・roleIndex 付き）に組み直す。
export function instantiatePreset(preset) {
  return preset.agents.map((a, i) => ({
    id: "a" + i, roleIndex: i,
    name: a.name, provider: a.provider, model: a.model,
    colorIndex: i % 5, shapeIndex: i % 5,
    stance: a.stance ?? null, persona: a.persona ?? "",
    status: "idle", failures: 0
  }));
}
