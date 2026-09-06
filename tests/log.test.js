// tests/log.test.js — 進行ログのフィルタ（FR-10-05）とコピー（FR-10-06）。

import { group, test, eq, ok } from "./runner.js";
import { mountLog } from "../js/ui/log.js";
import { emit, resetState } from "../js/state.js";
import { el } from "../js/ui/dom.js";

function freshRoots() {
  return { logRoot: el("section"), toolbarRoot: el("div") };
}

export function run() {
  group("ui/log.js 進行ログ");

  test("L-1 追加した行がDOMに現れ、getText は全件を返す（FR-10-06）", () => {
    resetState();
    const { logRoot } = freshRoots();
    const log = mountLog(logRoot);
    emit("log:append", { level: "INFO", message: "情報です", at: 0 });
    emit("log:append", { level: "ERROR", message: "エラーです", at: 0 });
    eq(logRoot.querySelectorAll(".log-line").length, 2);
    const text = log.getText();
    ok(text.includes("INFO 情報です"), "INFO行がテキストに無い");
    ok(text.includes("ERROR エラーです"), "ERROR行がテキストに無い");
  });

  test("L-2 toolbarRoot を渡すと INFO/WARN/ERROR の3ボタンが並ぶ", () => {
    resetState();
    const { logRoot, toolbarRoot } = freshRoots();
    mountLog(logRoot, toolbarRoot);
    const labels = [...toolbarRoot.querySelectorAll("button")].map((b) => b.textContent);
    eq(labels, ["INFO", "WARN", "ERROR"]);
  });

  test("L-3 フィルタボタンは行を消さず data-hide* の切り替えだけで見せ隠しする（FR-10-05）", () => {
    resetState();
    const { logRoot, toolbarRoot } = freshRoots();
    const log = mountLog(logRoot, toolbarRoot);
    emit("log:append", { level: "INFO", message: "情報A", at: 0 });
    emit("log:append", { level: "WARN", message: "警告A", at: 0 });

    const infoBtn = [...toolbarRoot.querySelectorAll("button")].find((b) => b.textContent === "INFO");
    infoBtn.click();
    eq(logRoot.dataset.hideinfo, "true", "フィルタ属性が付いていない");
    eq(logRoot.querySelectorAll(".log-line").length, 2, "フィルタで行そのものが消えてはいけない");
    eq(infoBtn.dataset.active, "false");

    // フィルタ中でも getText は全件を返す（表示と取得を分離する）
    const text = log.getText();
    ok(text.includes("情報A"), "フィルタ中に getText から消えている");
    ok(text.includes("警告A"));

    infoBtn.click();
    eq(logRoot.dataset.hideinfo, "false", "元に戻っていない");
    eq(infoBtn.dataset.active, "true");
  });

  test("L-4 WARN/ERROR も独立して切り替えられる", () => {
    resetState();
    const { logRoot, toolbarRoot } = freshRoots();
    mountLog(logRoot, toolbarRoot);
    const btn = (lv) => [...toolbarRoot.querySelectorAll("button")].find((b) => b.textContent === lv);
    btn("WARN").click();
    eq(logRoot.dataset.hidewarn, "true");
    eq(logRoot.dataset.hideinfo, undefined, "INFOまで巻き込んでいる");
    btn("ERROR").click();
    eq(logRoot.dataset.hideerror, "true");
    eq(logRoot.dataset.hidewarn, "true", "ERRORの切り替えでWARNが戻ってしまった");
  });

  test("L-5 toolbarRoot を省略しても追加とテキスト取得は動く", () => {
    resetState();
    const { logRoot } = freshRoots();
    const log = mountLog(logRoot);
    emit("log:append", { level: "INFO", message: "ツールバー無し", at: 0 });
    eq(logRoot.querySelectorAll(".log-line").length, 1);
    ok(log.getText().includes("ツールバー無し"));
  });

  // NFR-04-02: 進行ログは一度もクリアされないため、タブを開いたまま何セッションも回すと
  // DOM と entries が無制限に増えていた（全Phase完了後の点検で発見）。
  test("L-6 2000行を超えたら古い行から捨てる（NFR-04-02・BD §6.2）", () => {
    resetState();
    const { logRoot } = freshRoots();
    const log = mountLog(logRoot);
    for (let i = 0; i < 2050; i++) {
      emit("log:append", { level: "INFO", message: "行" + i, at: 0 });
    }
    eq(logRoot.querySelectorAll(".log-line").length, 2000, "DOMの行数が上限を超えている");

    const text = log.getText();
    ok(!text.includes("行0\n") && !text.startsWith("[00:00:00] INFO 行0"),
      "最も古い行が捨てられていない");
    ok(text.includes("行2049"), "最新の行が残っていない");
    eq(text.split("\n").length, 2000, "getText の件数が上限と一致しない");
  });
}
