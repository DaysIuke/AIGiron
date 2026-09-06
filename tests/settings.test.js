// tests/settings.test.js — 設定の永続化。壊れた保存値に耐えること（D-058）。

import { group, test, eq, ok } from "./runner.js";
import { loadSettings, saveSettings } from "../js/storage/settings.js";

const KEY = "aigiron_settings_v1";

function withStored(raw, fn) {
  const before = localStorage.getItem(KEY);
  try {
    if (raw === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, raw);
    return fn();
  } finally {
    if (before === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, before);
  }
}

export function run() {
  group("storage/settings.js 壊れた保存値への耐性");

  test("ST-1 未保存なら既定値を返す", () => {
    withStored(null, () => {
      const s = loadSettings();
      eq(s.keyStorage, "local");
      eq(s.agents, null, "既定では編成を持たない（呼び出し側が既定編成を組む）");
      eq(s.infobarClosed, false);
    });
  });

  test("ST-2 JSONとして壊れていれば既定値に落ちる", () => {
    withStored("{壊れ", () => eq(loadSettings().keyStorage, "local"));
  });

  // ここが D-058 の本体。JSON として読めるかだけを見ていたため、形の違う値が
  // そのままエンジンへ届き `agents.filter is not a function` で終了していた。
  test("ST-3 agents が配列でなければ採用しない", () => {
    withStored('{"agents":"not-an-array"}', () => {
      eq(loadSettings().agents, null, "文字列の agents を採用している");
    });
    withStored('{"agents":{"0":"x"}}', () => {
      eq(loadSettings().agents, null, "オブジェクトの agents を採用している");
    });
    withStored('{"agents":[1,2,3]}', () => {
      eq(loadSettings().agents, null, "要素がオブジェクトでない agents を採用している");
    });
  });

  test("ST-4 正しい形の agents はそのまま通す", () => {
    withStored('{"agents":[{"id":"a0","name":"X"}]}', () => {
      const a = loadSettings().agents;
      ok(Array.isArray(a) && a.length === 1 && a[0].id === "a0", "正しい編成が落とされている");
    });
  });

  test("ST-5 debate / models が非オブジェクトなら採用しない", () => {
    withStored('{"debate":"x","models":[1]}', () => {
      const s = loadSettings();
      eq(s.debate, null);
      eq(JSON.stringify(s.models), "{}");
    });
  });

  test("ST-6 keyStorage は既定の3値以外を採用しない", () => {
    withStored('{"keyStorage":"cloud"}', () => eq(loadSettings().keyStorage, "local"));
    withStored('{"keyStorage":"session"}', () => eq(loadSettings().keyStorage, "session"));
  });

  test("ST-7 保存した値が読み戻せる（既存の動作を壊していない）", () => {
    withStored(null, () => {
      saveSettings({ keyStorage: "session", infobarClosed: true });
      const s = loadSettings();
      eq(s.keyStorage, "session");
      eq(s.infobarClosed, true);
    });
  });
}
