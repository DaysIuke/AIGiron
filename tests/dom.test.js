// tests/dom.test.js — DOM生成の窓口。

import { group, test, eq, ok, throws } from "./runner.js";
import { el, clear } from "../js/ui/dom.js";

export function run() {
  group("ui/dom.js DOM生成");

  test("D-1 style 属性は例外になる（VF-02 / RB-C5）", () => {
    throws(() => el("div", { style: "color:red" }), "style属性が通ってしまった");
  });

  test("D-2 文字列の子は textContent として入る（AC-A17）", () => {
    const node = el("div", {}, ["<script>alert(1)</script>"]);
    eq(node.children.length, 0, "要素として解釈されてしまった");
    eq(node.textContent, "<script>alert(1)</script>");
    ok(!node.querySelector("script"), "script要素が生成された");
  });

  test("D-3 text 属性も textContent として入る", () => {
    const node = el("div", { text: "<img src=x onerror=alert(1)>" });
    eq(node.children.length, 0);
    eq(node.textContent, "<img src=x onerror=alert(1)>");
  });

  test("D-4 class / dataset / イベントが付く", () => {
    let clicked = 0;
    const node = el("button", { class: "btn a", dataset: { status: "idle" }, onClick: () => clicked++ });
    eq(node.className, "btn a");
    eq(node.dataset.status, "idle");
    node.dispatchEvent(new Event("click"));
    eq(clicked, 1);
  });

  test("D-5 clear は子を全部消す", () => {
    const node = el("div", {}, [el("span"), el("span")]);
    clear(node);
    eq(node.childNodes.length, 0);
  });
}
