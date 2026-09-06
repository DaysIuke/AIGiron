// ui/log.js — 進行ログ。append のみ。全体再描画はしない。
// フィルタ（FR-10-05）は CSS の [data-hide-*] 属性だけで切り替える。
//   行を消したり作り直したりしないので、フィルタを外せば履歴がそのまま戻る。

import { on } from "../state.js";
import { el } from "./dom.js";

const LEVEL_CLASS = { INFO: "lv-info", WARN: "lv-warn", ERROR: "lv-error" };
const LEVELS = ["INFO", "WARN", "ERROR"];

// NFR-04-02 / BD §6.2: 進行ログは append のみで一度もクリアしないため、タブを開いたまま
// 何セッションも回すと DOM の行と entries が無制限に増える。上限を超えたら古い行から捨てる。
// 議論の記録そのものは IndexedDB とMarkdown書き出しに残るので、ここは「進行の眺め」と割り切る。
const MAX_LINES = 2000;

function stamp(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// toolbarRoot は省略可（テストや簡易表示ではフィルタ無しで使える）。
export function mountLog(root, toolbarRoot) {
  const entries = [];   // FR-10-06: コピー用に生ログを保持する（DOMからの逆算をしない）

  root.appendChild(el("div", { class: "log-lines" }));
  const lines = root.querySelector(".log-lines");

  on("log:append", ({ level, message, at }) => {
    // 追従するかは行を足す前に判定する。足した後に測ると必ず「下端ではない」になる。
    // 利用者が上へスクロールして過去のログを読んでいる最中に引き戻さないため。
    const follow = root.scrollHeight - root.scrollTop - root.clientHeight < 40;

    entries.push({ level, message, at });
    const line = el("div", { class: "log-line " + (LEVEL_CLASS[level] ?? "lv-info") }, [
      el("span", { class: "log-time", text: stamp(at) }),
      el("span", { class: "log-level", text: level }),
      el("span", { class: "log-msg", text: message })
    ]);
    lines.appendChild(line);

    // NFR-04-02: 上限を超えたら古い行から捨てる。DOM と entries を同じ数に保つ。
    while (lines.childElementCount > MAX_LINES) lines.removeChild(lines.firstChild);
    if (entries.length > MAX_LINES) entries.splice(0, entries.length - MAX_LINES);

    if (follow) root.scrollTop = root.scrollHeight;
  });

  if (toolbarRoot) {
    for (const lv of LEVELS) {
      const btn = el("button", {
        class: "btn-mini log-filter", dataset: { level: lv, active: "true" },
        text: lv, onClick: () => {
          // dataset のキーはケバブケース化されるため、境界の出ない小文字キーに揃える
          // （"hideinfo"。"hideINFO" だと "data-hide-i-n-f-o" になり CSS と噛み合わない）
          const key = "hide" + lv.toLowerCase();
          const hidden = root.dataset[key] === "true";
          root.dataset[key] = hidden ? "false" : "true";
          btn.dataset.active = String(hidden);
        }
      });
      toolbarRoot.appendChild(btn);
    }
  }

  // FR-10-06: 表示中のフィルタに関わらず全件をテキストで返す。
  // 「全件」は保持している範囲（直近 MAX_LINES 行）を指す。フィルタでは1行も落とさない。
  function getText() {
    return entries
      .map((e) => "[" + stamp(e.at) + "] " + e.level + " " + e.message)
      .join("\n");
  }

  return { getText };
}
