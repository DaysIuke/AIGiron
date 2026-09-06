// tests/filesave.test.js — JSON のファイル書き出し（FR-07-06・FR-11-03）の純粋部分。

import { group, test, eq, ok } from "./runner.js";
import { timestampedName } from "../js/filesave.js";
import { looksLikeSession } from "../js/ui/sessions.js";

export function run() {
  group("filesave.js ファイル名");

  test("F-1 タイムスタンプ付きの名前になる", () => {
    const name = timestampedName("aigiron-settings", "json");
    ok(/^aigiron-settings-\d{8}-\d{4}\.json$/.test(name), "形式が違う: " + name);
  });

  test("F-2 拡張子と接頭辞をそのまま使う", () => {
    const name = timestampedName("aigiron-session", "json");
    ok(name.startsWith("aigiron-session-"), "接頭辞が違う: " + name);
    ok(name.endsWith(".json"), "拡張子が違う: " + name);
  });

  group("ui/sessions.js looksLikeSession（FR-07-06 のインポート検証）");

  const okSession = () => ({
    id: "s_1", topic: "t", status: "paused",
    cursor: { round: 1, index: 0 },
    config: { agents: [{ id: "a0", roleIndex: 0 }] }, turns: []
  });

  test("F-3 正しい形のセッションは通る", () => {
    ok(looksLikeSession(okSession()));
  });

  test("F-4 必須フィールドが欠けたものは弾く", () => {
    ok(!looksLikeSession(null), "null が通った");
    ok(!looksLikeSession({}), "空オブジェクトが通った");
    ok(!looksLikeSession({ ...okSession(), turns: undefined }), "turns が無いのに通った");
    ok(!looksLikeSession({ ...okSession(), config: undefined }), "config が無いのに通った");
    ok(!looksLikeSession({ ...okSession(), config: {} }), "config.agents が無いのに通った");
    ok(!looksLikeSession({ ...okSession(), id: 123 }), "id が文字列でないのに通った");
  });

  test("F-5 無関係なJSON（Markdownやプリセット等）は弾く", () => {
    ok(!looksLikeSession({ name: "プリセットA", agents: [] }), "プリセットのファイルが通った");
    ok(!looksLikeSession(["a", "b"]), "配列が通った");
    ok(!looksLikeSession("文字列"), "文字列が通った");
  });

  // レビュー: cursor と agents 要素の形（id/roleIndex）を見ていなかったため、
  //   cursor 無しのセッションが通り、engine.restore() が s.cursor.round で
  //   TypeError を投げていた（起動時の自動再開確認でも毎回再現する Critical バグ）。
  test("F-6 cursor が無い・agentsの要素にid/roleIndexが無いセッションは弾く（多角レビューで発見）", () => {
    ok(!looksLikeSession({ id: "s_1", topic: "t", status: "paused", config: { agents: [] }, turns: [] }),
      "cursor が無いのに通った");
    ok(!looksLikeSession({ ...okSession(), cursor: { round: 1 } }), "cursor.index が無いのに通った");
    ok(!looksLikeSession({ ...okSession(), status: undefined }), "status が無いのに通った");
    ok(!looksLikeSession({ ...okSession(), config: { agents: [{ name: "壊れたエージェント" }] } }),
      "agents要素にid/roleIndexが無いのに通った");
  });
}
