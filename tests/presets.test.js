// tests/presets.test.js — 参加AIの編成プリセット（FR-02-06）。

import { group, test, eq, ok } from "./runner.js";
import { loadPresets, savePreset, deletePreset, instantiatePreset } from "../js/storage/presets.js";

function reset() {
  try { localStorage.removeItem("aigiron_presets_v1"); } catch { /* ignore */ }
}

function agent(over = {}) {
  return {
    id: "a0", roleIndex: 0, name: "テストAI", provider: "groq", model: "openai/gpt-oss-20b",
    colorIndex: 0, shapeIndex: 0, stance: null, persona: "",
    status: "idle", failures: 0, retries: 3, tokenBoost: 2,   // 実行時フィールドも混ぜて渡す
    ...over
  };
}

export function run() {
  group("storage/presets.js 編成プリセット");

  test("P-1 初期状態は空配列", () => {
    reset();
    eq(loadPresets(), []);
  });

  test("P-2 保存した内容が読める", () => {
    reset();
    savePreset("標準3体", [agent(), agent({ id: "a1", name: "AI2", colorIndex: 1 })]);
    const list = loadPresets();
    eq(list.length, 1);
    eq(list[0].name, "標準3体");
    eq(list[0].agents.length, 2);
  });

  test("P-3 実行時フィールド（status/failures/retries等）は保存されない（APIキー同様に持たない）", () => {
    reset();
    savePreset("x", [agent()]);
    const a = loadPresets()[0].agents[0];
    ok(!("status" in a), "status が保存された");
    ok(!("failures" in a), "failures が保存された");
    ok(!("retries" in a), "retries が保存された");
    ok(!("tokenBoost" in a), "tokenBoost が保存された");
    ok(!("id" in a), "id が保存された（instantiate 時に組み直すべき）");
    ok(!("roleIndex" in a), "roleIndex が保存された");
    eq(a.provider, "groq");
    eq(a.model, "openai/gpt-oss-20b");
  });

  test("P-4 同名で保存すると上書きされ、先頭に来る", () => {
    reset();
    savePreset("A", [agent({ name: "旧" })]);
    savePreset("B", [agent({ name: "べつ" })]);
    savePreset("A", [agent({ name: "新" })]);
    const list = loadPresets();
    eq(list.map((p) => p.name), ["A", "B"], "同名保存で重複したか順序がおかしい");
    eq(list[0].agents[0].name, "新", "上書きされていない");
  });

  test("P-5 削除できる", () => {
    reset();
    savePreset("A", [agent()]);
    savePreset("B", [agent()]);
    deletePreset("A");
    eq(loadPresets().map((p) => p.name), ["B"]);
  });

  test("P-6 名前や参加AIが空なら保存されない", () => {
    reset();
    savePreset("", [agent()]);
    savePreset("名前あり", []);
    eq(loadPresets(), []);
  });

  test("P-7 instantiatePreset は id/roleIndex を連番で振り直す", () => {
    reset();
    savePreset("編成", [
      agent({ id: "a99", roleIndex: 99, name: "一人目" }),
      agent({ id: "a1", roleIndex: 1, name: "二人目", colorIndex: 3 })
    ]);
    const preset = loadPresets()[0];
    const agents = instantiatePreset(preset);
    eq(agents.map((a) => a.id), ["a0", "a1"]);
    eq(agents.map((a) => a.roleIndex), [0, 1]);
    eq(agents.map((a) => a.name), ["一人目", "二人目"]);
    eq(agents[1].colorIndex, 1, "colorIndex は位置基準に振り直すべき（保存時の3ではなく）");
    ok(agents.every((a) => a.status === "idle"), "status が idle で初期化されていない");
    ok(agents.every((a) => a.failures === 0), "failures が0で初期化されていない");
  });

  test("P-8 上限を超えたら古いものから捨てる", () => {
    reset();
    for (let i = 0; i < 25; i++) savePreset("p" + i, [agent()]);
    const list = loadPresets();
    eq(list.length, 20, "上限20件を超えている");
    eq(list[0].name, "p24", "最新が先頭にない");
    ok(!list.some((p) => p.name === "p0"), "最古のプリセットが残っている");
  });

  reset();
}
