// tests/mdlite.test.js — 安全な Markdown サブセットのレンダラ（Phase 3・NFR-03-02）。

import { group, test, eq, ok } from "./runner.js";
import { renderMarkdownLite } from "../js/mdlite.js";

function textOf(nodes) {
  const wrap = document.createElement("div");
  nodes.forEach((n) => wrap.appendChild(n));
  return wrap;
}

export function run() {
  group("mdlite.js 安全な Markdown サブセット");

  test("ML-1 <script> を含む本文は文字列としてのみ現れ、要素は生成されない（AC-A17）", () => {
    const wrap = textOf(renderMarkdownLite("<script>alert(1)</script> と <img src=x onerror=alert(1)>"));
    ok(!wrap.querySelector("script"), "script要素が生成された");
    ok(!wrap.querySelector("img"), "img要素が生成された");
    ok(wrap.textContent.includes("<script>alert(1)</script>"), "元の文字列が読めない");
  });

  test("ML-2 リンク記法はURLを捨ててテキストだけ残す。<a>は絶対に作らない（NFR-03-02）", () => {
    const wrap = textOf(renderMarkdownLite("詳しくは[公式サイト](https://evil.example/phish)を見て"));
    ok(!wrap.querySelector("a"), "a要素が生成された。リンクを作ってはいけない");
    ok(wrap.textContent.includes("公式サイト"), "リンクの表示テキストが消えている");
    ok(!wrap.textContent.includes("evil.example"), "URLが残っている");
  });

  test("ML-3 javascript: スキームを含むリンク記法も同様に無害化される", () => {
    const wrap = textOf(renderMarkdownLite("[クリック](javascript:alert(1))してください"));
    ok(!wrap.querySelector("a"), "a要素が生成された");
    ok(wrap.textContent.includes("クリック"));
    ok(!wrap.textContent.includes("javascript:"), "スキームが残っている");
    // URL内の括弧は1階層まで対応し、外側に閉じ括弧が余らないこと
    eq(wrap.textContent, "クリックしてください");
  });

  test("ML-4 見出しは h4〜h6 に丸められる（文書全体の見出しより目立たせない）", () => {
    const wrap = textOf(renderMarkdownLite("# 大見出し\n\n###### 最小見出し\n\n####### 7個は見出しにならない"));
    const h = wrap.querySelectorAll("h4,h5,h6");
    eq(h.length, 2, "見出しの数が違う");
    eq(h[0].tagName, "H4");
    eq(h[0].textContent, "大見出し");
    eq(h[1].tagName, "H6");
    ok(wrap.textContent.includes("####### 7個は見出しにならない"), "# が7個の行まで見出しとして解釈された");
  });

  test("ML-5 箇条書きと番号付きリストが ul/ol になる", () => {
    const wrap = textOf(renderMarkdownLite("- りんご\n- みかん\n\n1. 一番目\n2. 二番目"));
    const ul = wrap.querySelector("ul");
    ok(ul, "ul が無い");
    eq([...ul.querySelectorAll("li")].map((li) => li.textContent), ["りんご", "みかん"]);
    const ol = wrap.querySelector("ol");
    ok(ol, "ol が無い");
    eq([...ol.querySelectorAll("li")].map((li) => li.textContent), ["一番目", "二番目"]);
  });

  test("ML-6 インラインの強調・斜体・コードが解釈される", () => {
    const wrap = textOf(renderMarkdownLite("これは**重要**で、*補足*があり、`code.js`も書く。"));
    eq(wrap.querySelector("strong")?.textContent, "重要");
    eq(wrap.querySelector("em")?.textContent, "補足");
    eq(wrap.querySelector("code")?.textContent, "code.js");
  });

  test("ML-7 コードブロックの中身はインライン解釈されず、そのまま表示される", () => {
    const wrap = textOf(renderMarkdownLite("```\nconst x = **not bold** here;\n[link](url)\n```"));
    const code = wrap.querySelector("pre.md-code code");
    ok(code, "コードブロックが無い");
    ok(code.textContent.includes("**not bold**"), "コード内が誤って強調解釈された");
    ok(code.textContent.includes("[link](url)"), "コード内のリンク記法が消えた");
    ok(!wrap.querySelector("pre.md-code strong"), "コードブロック内に strong 要素が生成された");
  });

  test("ML-8 段落中の改行は <br> になり、空行で段落が分かれる", () => {
    const wrap = textOf(renderMarkdownLite("一行目\n二行目\n\n次の段落"));
    const ps = wrap.querySelectorAll("p.md-p");
    eq(ps.length, 2, "段落の数が違う");
    ok(ps[0].querySelector("br"), "行内改行が br になっていない");
    eq(ps[1].textContent, "次の段落");
  });

  test("ML-9 空文字は空配列を返す", () => {
    eq(renderMarkdownLite("").length, 0);
    eq(renderMarkdownLite(null).length, 0);
    eq(renderMarkdownLite(undefined).length, 0);
  });

  test("ML-10 通常の文章（記法を含まない）が壊れずそのまま表示される", () => {
    const wrap = textOf(renderMarkdownLite("これは普通の日本語の発言です。特に記法は使っていません。"));
    eq(wrap.textContent, "これは普通の日本語の発言です。特に記法は使っていません。");
  });
}
