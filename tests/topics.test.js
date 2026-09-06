// tests/topics.test.js — 議題の履歴（FR-12-03）。

import { group, test, eq, ok } from "./runner.js";
import { loadTopics, pushTopic } from "../js/storage/topics.js";

function reset() {
  try { localStorage.removeItem("aigiron_topics_v1"); } catch { /* ignore */ }
}

export function run() {
  group("storage/topics.js 議題の履歴");

  test("T-1 初期状態は空配列", () => {
    reset();
    eq(loadTopics(), []);
  });

  test("T-2 追加した議題が先頭に来る", () => {
    reset();
    pushTopic("議題A");
    pushTopic("議題B");
    eq(loadTopics(), ["議題B", "議題A"]);
  });

  test("T-3 同じ議題を再度使うと重複せず先頭へ寄る", () => {
    reset();
    pushTopic("議題A");
    pushTopic("議題B");
    pushTopic("議題A");
    eq(loadTopics(), ["議題A", "議題B"]);
  });

  test("T-4 空文字・空白のみは無視される", () => {
    reset();
    pushTopic("");
    pushTopic("   ");
    eq(loadTopics(), []);
  });

  test("T-5 前後の空白は取り除かれる", () => {
    reset();
    pushTopic("  空白付き議題  ");
    eq(loadTopics(), ["空白付き議題"]);
  });

  test("T-6 上限を超えたら古いものから捨てる", () => {
    reset();
    for (let i = 0; i < 20; i++) pushTopic("議題" + i);
    const list = loadTopics();
    eq(list.length, 15, "上限15件を超えている");
    eq(list[0], "議題19", "最新が先頭にない");
    ok(!list.includes("議題0"), "最古の議題が残っている");
  });

  test("T-7 壊れたJSONが入っていても空配列で復帰する", () => {
    reset();
    try { localStorage.setItem("aigiron_topics_v1", "{壊れたJSON"); } catch { /* ignore */ }
    eq(loadTopics(), []);
  });

  reset();
}
