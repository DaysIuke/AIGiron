// mdlite.js — 安全な Markdown サブセットのレンダラ（Phase 3・NFR-03-02）。
// AI応答を読みやすく整形するが、リンクは絶対に生成しない。
// HTML文字列の流し込みは一切使わず、常に el()（textContent 経由）でDOMへ入れる。AC-A17 を維持する。
//
// 対応する記法: 見出し(#〜######) / 箇条書き(- ・ *) / 番号付きリスト / コードブロック(```) /
//   インラインの **強調** *斜体* `コード`。[text](url) はURLを捨ててテキストだけ残す。
// それ以外（表・脚注・生HTMLなど）は解釈せず、そのまま文字として表示する。

import { el } from "./ui/dom.js";

function stripLinkSyntax(text) {
  // リンクを生成しない（NFR-03-02）。URL側は捨て、表示テキストだけ残す。
  // URL部分は1階層のネスト括弧（javascript:alert(1) 等）まで対応し、
  // 閉じ括弧を1つ内側で消費して外側に余らせないようにする。
  return text.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
}

// インライン強調を解釈し、文字列と要素が混在した配列を返す。常に el() かテキストのみ。
function renderInline(text) {
  const src = stripLinkSyntax(text);
  const nodes = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) nodes.push(src.slice(last, m.index));
    if (m[1] !== undefined) nodes.push(el("code", {}, [m[1]]));
    else if (m[2] !== undefined) nodes.push(el("strong", {}, [m[2]]));
    else nodes.push(el("em", {}, [m[3] ?? m[4]]));
    last = re.lastIndex;
  }
  if (last < src.length) nodes.push(src.slice(last));
  return nodes.length ? nodes : [""];
}

function isListLine(line) { return /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line); }
function isOrderedLine(line) { return /^\s*\d+\.\s+/.test(line); }
function listContent(line) { return line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""); }
function headingOf(line) {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  return m ? { level: m[1].length, text: m[2] } : null;
}
function isBlockStart(line) {
  return line.trim() === "" || isListLine(line) || headingOf(line) || /^\s*```/.test(line);
}

// Markdown（安全なサブセット）を DOM ノードの配列にする。空文字なら空配列。
export function renderMarkdownLite(text) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }

    // コードブロック ```...```。中はインライン解釈せず、そのまま表示する。
    if (/^\s*```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++;   // 閉じフェンスを読み飛ばす（無くても末尾で自然に止まる）
      out.push(el("pre", { class: "md-code" }, [el("code", {}, [body.join("\n")])]));
      continue;
    }

    const h = headingOf(line);
    if (h) {
      // 本文中の見出しなので、文書全体の見出しより大きくならないよう h4〜h6 に丸める
      const tag = "h" + Math.min(6, h.level + 3);
      out.push(el(tag, { class: "md-heading" }, renderInline(h.text)));
      i++;
      continue;
    }

    if (isListLine(line)) {
      const ordered = isOrderedLine(line);
      const items = [];
      while (i < lines.length && isListLine(lines[i])) {
        items.push(el("li", {}, renderInline(listContent(lines[i]))));
        i++;
      }
      out.push(el(ordered ? "ol" : "ul", { class: "md-list" }, items));
      continue;
    }

    // 段落。空行や次のブロック開始まで連続行をまとめ、改行は <br> にする。
    const para = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    const p = el("p", { class: "md-p" });
    para.forEach((ln, idx) => {
      if (idx > 0) p.appendChild(el("br"));
      for (const n of renderInline(ln)) {
        p.appendChild(typeof n === "string" ? document.createTextNode(n) : n);
      }
    });
    out.push(p);
  }

  return out;
}
