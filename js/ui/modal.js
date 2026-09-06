// ui/modal.js — モーダル共通の振る舞い（Escape で閉じる・フォーカスの移動と復帰）。
// 中身の組み立ては各モーダルが行う。ここは「開いている間の操作」だけを持つ。
//
// 分けた理由: 同じ挙動を3つのモーダル（設定・履歴・書き出し）で書き分けた結果、
//   履歴モーダルだけ Escape で閉じられず、どれもフォーカスが開いたボタンへ戻らなかった。
//   キーボードだけで操作すると、閉じた瞬間にフォーカスが body へ落ちて位置を見失う。

const FOCUSABLE = ".modal button:not([disabled]), .modal input:not([disabled])," +
                  ".modal select:not([disabled]), .modal textarea:not([disabled])";

export function bindModal(root, close) {
  let opener = null;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden) close();
  });

  return {
    // 開いた直後に一度だけ呼ぶ。再描画のたびに呼ぶと入力中にフォーカスを奪う。
    // target を渡さなければモーダル内の最初の操作要素へ移す。
    opened(target) {
      opener = document.activeElement;
      const t = target ?? root.querySelector(FOCUSABLE);
      if (t) setTimeout(() => t.focus(), 0);
    },
    // 閉じる直前に呼ぶ。開く前にフォーカスがあった要素へ戻す。
    // 既に DOM から外れている要素には戻さない（例外にはならないが行方不明になる）。
    closed() {
      const o = opener;
      opener = null;
      if (o && o !== document.body && document.contains(o)) o.focus?.();
    }
  };
}
