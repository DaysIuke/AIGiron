// tests/order.test.js — 発言順の決定と再現性。

import { group, test, eq, ok } from "./runner.js";
import { computeOrder } from "../js/order.js";
import { mulberry32, shuffle } from "../js/rng.js";

function agents(n) {
  return Array.from({ length: n }, (_, i) => ({ id: "a" + i, roleIndex: i, status: "idle" }));
}

export function run() {
  group("rng.js / order.js 発言順");

  test("G-1 mulberry32 は同一シードで同一列を返す", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    eq([a(), a(), a()], [b(), b(), b()]);
  });

  test("G-2 shuffle は元配列を変更しない", () => {
    const src = [1, 2, 3, 4, 5];
    const copy = [...src];
    shuffle(src, mulberry32(7));
    eq(src, copy);
  });

  // O-1: 同一シード・同一ラウンドで結果が一致する（AC-A03）
  test("O-1 同一シード・同一ラウンドで順序が一致する", () => {
    const x = computeOrder(agents(4), 2, "random", 999).map((a) => a.id);
    const y = computeOrder(agents(4), 2, "random", 999).map((a) => a.id);
    eq(x, y);
  });

  // O-2: ラウンドが違えば順序が変わりうる
  test("O-2 ラウンドが違えば順序が変わる（5体10ラウンドで少なくとも1回）", () => {
    const base = computeOrder(agents(5), 1, "random", 42).map((a) => a.id);
    let differs = false;
    for (let r = 2; r <= 10; r++) {
      const o = computeOrder(agents(5), r, "random", 42).map((a) => a.id);
      if (JSON.stringify(o) !== JSON.stringify(base)) differs = true;
    }
    ok(differs, "全ラウンドで同じ順序になった");
  });

  // O-3: fixed では編成順のまま
  test("O-3 mode:fixed は編成順を保つ", () => {
    eq(computeOrder(agents(4), 3, "fixed", 1).map((a) => a.id), ["a0", "a1", "a2", "a3"]);
  });

  // O-4: 離脱者が含まれない
  test("O-4 離脱者は結果に含まれない", () => {
    const list = agents(4);
    list[1].status = "dropped";
    const ids = computeOrder(list, 1, "random", 5).map((a) => a.id);
    eq(ids.length, 3);
    ok(!ids.includes("a1"), "離脱者が含まれている");
  });

  test("O-6 leadId を渡すと先頭に固定され、残りはシードで再現される（D-031）", () => {
    const a = computeOrder(agents(5), 3, "random", 42, { leadId: "a3" }).map((x) => x.id);
    const b = computeOrder(agents(5), 3, "random", 42, { leadId: "a3" }).map((x) => x.id);
    eq(a[0], "a3", "先頭が lead でない");
    eq(a, b, "同一シードで再現しない");
    eq([...a].sort(), ["a0", "a1", "a2", "a3", "a4"], "全員が1回ずつ含まれない");
    // lead を外した並びは、lead 無しの並びから lead を抜いたものと一致する（残りの順序を壊さない）
    const plain = computeOrder(agents(5), 3, "random", 42).map((x) => x.id).filter((id) => id !== "a3");
    eq(a.slice(1), plain);
    // 離脱済みの lead は無視される
    const list = agents(3); list[1].status = "dropped";
    const c = computeOrder(list, 1, "random", 1, { leadId: "a1" }).map((x) => x.id);
    ok(!c.includes("a1"), "離脱者が先頭に来た");
  });

  test("O-5 順序は全員をちょうど1回ずつ含む", () => {
    const ids = computeOrder(agents(5), 7, "random", 31337).map((a) => a.id).sort();
    eq(ids, ["a0", "a1", "a2", "a3", "a4"]);
  });
}
