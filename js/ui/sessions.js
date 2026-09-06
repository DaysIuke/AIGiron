// ui/sessions.js — 保存済みセッションの一覧。開くたびに生成し、閉じたら破棄する。

import { el, clear } from "./dom.js";
import { bindModal } from "./modal.js";
import { state } from "../state.js";
import { downloadJson, pickJsonFile, timestampedName } from "../filesave.js";

function pad(n) { return String(n).padStart(2, "0"); }
function stamp(ms) {
  const d = new Date(ms);
  return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

const STATUS_LABEL = {
  running: "実行中", waiting: "待機中", paused: "一時停止",
  stopped: "停止", done: "終了", error: "エラー"
};

// 最低限の構造チェック。壊れたファイルや無関係なJSONを IndexedDB に書き込まない。
// レビュー: cursor と agents 要素の形まで見ないと、engine.restore() が
//   s.cursor.round / a.status で無条件に例外を投げる（起動時の自動再開確認でも
//   毎回踏み、ダイアログとクラッシュを繰り返す）。ここで最低限の形を強制する。
export function looksLikeSession(v) {
  return v && typeof v === "object" &&
    typeof v.id === "string" &&
    typeof v.topic === "string" &&
    typeof v.status === "string" &&
    v.cursor && typeof v.cursor === "object" &&
    Number.isInteger(v.cursor.round) && Number.isInteger(v.cursor.index) &&
    v.config && Array.isArray(v.config.agents) &&
    v.config.agents.every((a) => a && typeof a.id === "string" && typeof a.roleIndex === "number") &&
    Array.isArray(v.turns);
}

export function mountSessions(root, openButton, { storage, engine }) {
  let importStatus = "";
  const modal = bindModal(root, close);

  function close() { modal.closed(); clear(root); root.hidden = true; }

  // モーダルの外枠。閉じるボタンは必ずここで付ける。
  // 中身の組み立てに失敗しても「開いたまま閉じられない」状態を作らないため（D-057）。
  function shell(body) {
    root.appendChild(el("div", { class: "modal-backdrop", onClick: close }));
    root.appendChild(el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
      el("div", { class: "modal-head" }, [
        el("h2", { text: "セッション履歴" }),
        el("button", { class: "btn-mini", text: "閉じる", onClick: close })
      ]),
      body
    ]));
  }

  async function render() {
    // 開いたときだけフォーカスを移す。インポートや削除による再描画では奪わない。
    const wasHidden = root.hidden;
    clear(root);
    root.hidden = false;

    let list;
    try {
      list = await storage.list();
    } catch (e) {
      // IndexedDB が使えない環境（プライベートウィンドウ、ストレージの制限など）。
      // 以前はここで例外がそのまま抜け、パネルだけ開いて中身も閉じるボタンも無い
      // 状態になっていた（クリックハンドラが async なので通知もされない）。
      shell(el("div", { class: "modal-body" }, [
        el("p", { class: "placeholder", text:
          "セッション履歴を読み込めませんでした。このブラウザではブラウザ内保存（IndexedDB）が" +
          "使えない可能性があります（プライベートウィンドウやストレージの制限など）。" }),
        el("p", { class: "field-hint", text:
          "議論そのものは実行できますが、中断したセッションの保存と復元は働きません。" }),
        el("pre", { class: "verdict-raw", text: String(e?.message ?? e) })
      ]));
      if (wasHidden) modal.opened();
      return;
    }
    const body = el("div", { class: "modal-body" });

    // FR-07-06: セッションのインポート。既存と同じ id なら上書きになる。
    const importMsg = el("span", { class: "field-hint", text: importStatus });
    body.appendChild(el("div", { class: "session-import-row" }, [
      el("button", {
        class: "btn-mini", text: "インポート",
        onClick: async () => {
          let parsed;
          try {
            parsed = await pickJsonFile();
          } catch (e) {
            importStatus = String(e?.message ?? e);
            render();
            return;
          }
          if (!parsed) return;   // キャンセル
          if (!looksLikeSession(parsed)) {
            importStatus = "セッションのファイルとして読めませんでした";
            render();
            return;
          }
          // 保存も失敗しうる（ストレージ制限・容量超過）。握りつぶすと
          // 「読み込みました」と出たのに一覧に現れない状態になる（D-058）。
          try {
            await storage.save(parsed);
            importStatus = "「" + parsed.topic + "」を読み込みました";
          } catch (e) {
            importStatus = "読み込めましたが保存できませんでした: " + String(e?.message ?? e);
          }
          render();
        }
      }),
      importMsg
    ]));

    if (!list.length) {
      body.appendChild(el("p", { class: "placeholder", text: "保存されたセッションはありません。" }));
    }

    for (const s of list) {
      const busy = state.status === "running" || state.status === "waiting";
      const isCurrent = state.session?.id === s.id;
      const row = el("div", { class: "session-row", dataset: { status: s.status } }, [
        el("div", { class: "session-main" }, [
          el("div", { class: "session-topic", text: s.topic }),
          el("div", { class: "session-meta", text:
            stamp(s.updatedAt ?? s.createdAt) + " / " + (STATUS_LABEL[s.status] ?? s.status) +
            " / 発言 " + (s.turns?.length ?? 0) + " 件 / " +
            (s.config?.agents ?? []).map((a) => a.name).join("・") +
            (isCurrent ? " / 表示中" : "") })
        ]),
        el("div", { class: "session-actions" }, [
          el("button", { class: "btn-mini", text: "開く", disabled: busy || isCurrent,
            onClick: async () => {
              // レビュー: looksLikeSession を通っていない旧データ・他経路で保存された
              //   壊れたセッションだと engine.restore() が例外を投げうる。捕まえずに
              //   投げると async ハンドラが未捕捉のまま失敗し、モーダルが閉じずエラーも
              //   出ない状態になっていた。
              try {
                await engine.restore(await storage.get(s.id));
                close();
              } catch (e) {
                importStatus = "セッションを開けませんでした（データが壊れている可能性があります）: " +
                  String(e?.message ?? e);
                render();
              }
            } }),
          el("button", {
            class: "btn-mini", text: "エクスポート",
            onClick: () => downloadJson(timestampedName("aigiron-session", "json"), s)
          }),
          el("button", { class: "btn-mini", text: "削除", disabled: isCurrent,
            onClick: async () => {
              // 失敗を握りつぶすと、消えないまま何の反応も無いように見える（D-058）
              try {
                await storage.remove(s.id);
              } catch (e) {
                importStatus = "削除できませんでした: " + String(e?.message ?? e);
              }
              render();
            } })
        ])
      ]);
      body.appendChild(row);
    }

    shell(body);
    if (wasHidden) modal.opened();
  }

  openButton.addEventListener("click", render);
  return { open: render, close };
}
