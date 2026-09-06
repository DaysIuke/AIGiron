// tests/runner.js — 依存ゼロの最小テストランナー。

import { el, clear } from "../js/ui/dom.js";

export const results = [];
let current = "（未分類）";

export function group(name) { current = name; }

export function test(name, fn) {
  try { fn(); results.push({ group: current, name, ok: true }); }
  catch (e) { results.push({ group: current, name, ok: false, msg: e.message }); }
}

export async function atest(name, asyncFn) {
  try { await asyncFn(); results.push({ group: current, name, ok: true }); }
  catch (e) { results.push({ group: current, name, ok: false, msg: e.message }); }
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + ": " : "") + a + " !== " + b);
}

export function ok(cond, msg) {
  if (!cond) throw new Error(msg || "条件が成立しませんでした");
}

export function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || "例外が投げられませんでした");
}

export async function athrows(fn, msg) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || "例外が投げられませんでした");
}

export function render(summaryRoot, listRoot) {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;

  clear(summaryRoot);
  summaryRoot.appendChild(el("div", { class: fail === 0 ? "t-pass" : "t-fail" }, [
    "成功 " + pass + " 件・失敗 " + fail + " 件（合計 " + results.length + " 件）"
  ]));

  clear(listRoot);
  let lastGroup = null;
  for (const r of results) {
    if (r.group !== lastGroup) {
      lastGroup = r.group;
      listRoot.appendChild(el("div", { class: "t-group", text: r.group }));
    }
    listRoot.appendChild(el("div", { class: "t-row " + (r.ok ? "t-pass" : "t-fail") }, [
      el("span", { class: "t-mark", text: r.ok ? "PASS" : "FAIL" }),
      el("span", { text: r.name }),
      r.ok ? null : el("span", { class: "t-msg", text: r.msg })
    ]));
  }

  // ブラウザ外から結果を拾えるようにしておく
  window.__TEST_RESULT__ = { pass, fail, total: results.length, results };
  document.title = (fail === 0 ? "PASS" : "FAIL") + " — AIGiron tests";
}
