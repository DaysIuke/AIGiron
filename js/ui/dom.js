// ui/dom.js — DOM生成の唯一の窓口。HTML文字列の流し込みと style 属性を禁止する。

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "style") throw new Error("style属性は禁止。CSSクラスを使うこと");
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "value") node.value = v;   // 属性に載せない。キー入力欄が DOM に平文で残るのを防ぐ
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function $(sel, root = document) { return root.querySelector(sel); }

export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
