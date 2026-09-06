// ui/export.js — クリップボードに書けなかったときの退避経路。
// Markdown をテキストエリアに出して、手動で選択・コピーできるようにする。

import { el, clear } from "./dom.js";
import { bindModal } from "./modal.js";

export function mountExportFallback(root) {
  const modal = bindModal(root, close);

  function close() { modal.closed(); clear(root); root.hidden = true; }

  function show(md, reason) {
    clear(root);
    root.hidden = false;

    const ta = el("textarea", { class: "export-area", readonly: true, spellcheck: "false" });
    ta.value = md;   // AI応答は textContent 相当の value 代入。HTML として解釈されない

    root.appendChild(el("div", { class: "modal-backdrop", onClick: close }));
    root.appendChild(el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
      el("div", { class: "modal-head" }, [
        el("h2", { text: "Markdown" }),
        el("button", { class: "btn-mini", text: "閉じる", onClick: close })
      ]),
      el("div", { class: "modal-body" }, [
        el("p", { class: "field-hint", text:
          "クリップボードに書き込めませんでした（" + reason + "）。下の内容を選択してコピーしてください。" }),
        ta,
        el("div", { class: "modal-foot" }, [
          el("button", { class: "btn", text: "全選択", onClick: () => { ta.focus(); ta.select(); } }),
          el("button", { class: "btn btn-primary", text: "閉じる", onClick: close })
        ])
      ])
    ]));
    modal.opened(ta);
    setTimeout(() => ta.select(), 0);
  }

  return { show, close };
}
