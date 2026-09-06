// storage/settings.js — 設定とAPIキーの永続化。キーは指定された置き場所にだけ書く。

import { registerSecret } from "../errors.js";

const KEY_SETTINGS = "aigiron_settings_v1";
const KEY_PREFIX = "aigiron_key_v1_";

const DEFAULT_SETTINGS = {
  keyStorage: "local",   // local | session | none
  agents: null,          // 編成（null なら既定を組む）
  models: {},            // プロバイダごとの取得済みモデルID
  debate: null,          // 議論設定の上書き
  infobarClosed: false   // UI-03/FR-14-02: 情報バーを閉じた状態を記憶する
};

const memoryKeys = new Map();   // keyStorage === "none" のときの置き場所

// 保存されている値の「形」を検めて、壊れていれば既定に落とす（D-058）。
// JSON として読めるかだけを見ていたため、`{"agents":"文字列"}` のような
// 形の違う値がそのままエンジンまで届き、`agents.filter is not a function` で
// 「内部エラー」終了していた。壊れた設定・手で編集した値・古い形式に備える。
function sanitize(v) {
  const s = { ...DEFAULT_SETTINGS };
  if (!v || typeof v !== "object" || Array.isArray(v)) return s;

  if (["local", "session", "none"].includes(v.keyStorage)) s.keyStorage = v.keyStorage;
  // agents は「オブジェクトの配列」でなければ採用しない（null なら既定編成が組まれる）
  if (Array.isArray(v.agents) && v.agents.every((a) => a && typeof a === "object")) {
    s.agents = v.agents;
  }
  if (v.debate && typeof v.debate === "object" && !Array.isArray(v.debate)) s.debate = v.debate;
  if (v.models && typeof v.models === "object" && !Array.isArray(v.models)) s.models = v.models;
  if (typeof v.infobarClosed === "boolean") s.infobarClosed = v.infobarClosed;
  return s;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY_SETTINGS);
    return raw ? sanitize(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(next)); } catch { /* 保存できなくても続行 */ }
  return next;
}

export function getKey(provider) {
  const where = loadSettings().keyStorage;
  let v = "";
  if (where === "none") v = memoryKeys.get(provider) ?? "";
  else {
    const store = where === "session" ? sessionStorage : localStorage;
    try { v = store.getItem(KEY_PREFIX + provider) ?? ""; } catch { v = ""; }
  }
  if (v) registerSecret(v);   // 実値マスクの対象に登録（接頭辞の無い Mistral キーも伏せられる）
  return v;
}

export function setKey(provider, value) {
  const where = loadSettings().keyStorage;
  // 置き場所を変えたときに前の場所へ残さない
  try { localStorage.removeItem(KEY_PREFIX + provider); } catch { /* 無視 */ }
  try { sessionStorage.removeItem(KEY_PREFIX + provider); } catch { /* 無視 */ }
  memoryKeys.delete(provider);

  if (!value) return;
  registerSecret(value);
  if (where === "none") { memoryKeys.set(provider, value); return; }
  const store = where === "session" ? sessionStorage : localStorage;
  try { store.setItem(KEY_PREFIX + provider, value); } catch { memoryKeys.set(provider, value); }
}

export function hasKey(provider) { return Boolean(getKey(provider)); }
