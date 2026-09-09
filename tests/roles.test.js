// tests/roles.test.js — 役割割り当て。

import { group, test, eq, ok } from "./runner.js";
import { roleOf, proposerFor } from "../js/roles.js";

function cfg(n, extra = {}) {
  return {
    format: "rotation",
    rounds: 10,
    agents: Array.from({ length: n }, (_, i) => ({ roleIndex: i })),
    ...extra
  };
}

export function run() {
  group("roles.js 役割割り当て");

  // R-1: n=3 で提案役が2ラウンド連続にならない（FR-03-02 / AC-A02）
  test("R-1 n=3 で同じAIが2ラウンド連続で提案役にならない", () => {
    const c = cfg(3);
    for (let i = 0; i < 3; i++) {
      let prev = null;
      for (let r = 1; r <= 10; r++) {
        const role = roleOf(i, r, c);
        ok(!(role === "propose" && prev === "propose"),
          "roleIndex=" + i + " が R" + (r - 1) + "→R" + r + " で連続提案役になった");
        prev = role;
      }
    }
  });

  // R-2: 各ラウンドで提案役はちょうど1体
  test("R-2 各ラウンドの提案役はちょうど1体", () => {
    const c = cfg(4, { rounds: 12 });   // 総括ラウンドに入ると提案役はいなくなるので通常ラウンド内で検査する
    for (let r = 1; r <= 12; r++) {
      const proposers = [0, 1, 2, 3].filter((i) => roleOf(i, r, c) === "propose");
      eq(proposers.length, 1, "R" + r + " の提案役の数");
    }
  });

  // R-3: n=2 では毎ラウンド役割が入れ替わる
  test("R-3 n=2 で両者の役割が毎ラウンド反転する", () => {
    const c = cfg(2);
    eq(roleOf(0, 1, c), "propose");
    eq(roleOf(1, 1, c), "critique");
    eq(roleOf(0, 2, c), "critique");
    eq(roleOf(1, 2, c), "propose");
    eq(roleOf(0, 3, c), "propose");
  });

  // R-4: 離脱者が出ても roleIndex は不変なので連続禁止が保たれる（RB-C1）
  test("R-4 離脱が起きても提案役の連続が発生しない", () => {
    const c = cfg(3);
    // roleIndex=1 が離脱しても roleOf の入力は変わらない
    for (const i of [0, 2]) {
      let prev = null;
      for (let r = 1; r <= 12; r++) {
        const role = roleOf(i, r, c);
        ok(!(role === "propose" && prev === "propose"), "離脱後に連続提案役が発生");
        prev = role;
      }
    }
  });

  // R-7: FR-06-08 離脱後は生存メンバーで役割を組み直す
  test("R-7 離脱者を除いた生存メンバーで提案役が回る（FR-06-08）", () => {
    const c = cfg(3);
    c.agents[1].status = "dropped";
    let prev = null;
    for (let r = 1; r <= 8; r++) {
      const p = proposerFor(r, c);
      ok(p === 0 || p === 2, "R" + r + " の提案役が離脱者になっている: " + p);
      ok(p !== prev, "R" + r + " で提案役が連続した");
      prev = p;
      eq(roleOf(p, r, c), "propose");
      eq(roleOf(p === 0 ? 2 : 0, r, c), "critique");
    }
  });

  // R-5: 総括ラウンドは summary
  test("R-5 rounds を超えたラウンドは summary", () => {
    const c = cfg(3, { rounds: 3 });
    eq(roleOf(0, 4, c), "summary");
    eq(roleOf(2, 4, c), "summary");
  });

  // R-6: 形式ごとの固定役割
  test("R-6 free / allpropose / debate は固定の役割を返す", () => {
    eq(roleOf(0, 1, cfg(3, { format: "free" })), "free");
    eq(roleOf(0, 1, cfg(3, { format: "allpropose" })), "both");
    eq(roleOf(0, 1, cfg(3, { format: "debate" })), "stance");
  });

  // R-8: R-5 は rotation だけ、R-6 は R1 だけを見ていた。その隙間に落ちていた（D-089）
  test("R-8 どの形式でも総括ラウンドは summary（D-089）", () => {
    for (const format of ["rotation", "debate", "allpropose", "free"]) {
      eq(roleOf(0, 4, cfg(3, { rounds: 3, format })), "summary",
        format + " の総括ラウンドで summary が返っていない");
      eq(roleOf(1, 5, cfg(3, { rounds: 3, format })), "summary",
        format + " の総括より後のラウンドでも summary のはず");
    }
  });

  test("R-9 通常ラウンドの役割は形式ごとに変わらない（R-8 の修正で壊していない）", () => {
    eq(roleOf(0, 3, cfg(3, { rounds: 3, format: "debate" })), "stance");
    eq(roleOf(0, 3, cfg(3, { rounds: 3, format: "free" })), "free");
    eq(roleOf(0, 3, cfg(3, { rounds: 3, format: "allpropose" })), "both");
  });
}
