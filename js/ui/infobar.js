// ui/infobar.js — 閉じられる情報バー（UI-03・FR-14-02）。
// APIキーの保存場所についての注意書きを表示する。×で閉じると次回起動時も出さない
// （閉じた状態を settings と同じ場所に永続化する）。

import { el, clear } from "./dom.js";
import { loadSettings, saveSettings } from "../storage/settings.js";

export function mountInfobar(root, onOpenSettings) {
  function render() {
    clear(root);
    if (loadSettings().infobarClosed) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    root.appendChild(el("span", { class: "infobar-icon", text: "ⓘ" }));
    root.appendChild(el("span", { class: "infobar-text", text:
      "APIキーは設定画面で選んだ場所（このブラウザ／タブを閉じるまで／保存しない）にのみ置かれ、" +
      "各プロバイダへのリクエスト以外には送信されません。" }));
    root.appendChild(el("button", {
      type: "button", class: "btn-mini", text: "設定",
      onClick: () => onOpenSettings(null)
    }));
    root.appendChild(el("button", {
      type: "button", class: "btn-mini infobar-close", text: "×",
      "aria-label": "この情報バーを閉じる",
      onClick: () => { saveSettings({ infobarClosed: true }); render(); }
    }));
  }
  render();
}
