// filesave.js — JSON をファイルへ書き出し／ファイルから読み込む（FR-07-06・FR-11-03）。
// ダウンロードは Blob + <a download> のクリック以外に手段が無い。CSP（default-src 'self'）
// 下でも blob: の生成物はナビゲーションの対象にならないため実機で問題なく動くことを確認済み。

function pad(n) { return String(n).padStart(2, "0"); }

export function timestampedName(prefix, ext) {
  const d = new Date();
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" +
                pad(d.getHours()) + pad(d.getMinutes());
  return prefix + "-" + stamp + "." + ext;
}

export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;   // style属性は使わない。hidden 属性だけで見た目から外す
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke を即時にするとダウンロード開始前にURLが失効するブラウザがあるため少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ファイル選択ダイアログを開き、選ばれたファイルの中身を JSON として返す。
// キャンセルされたら null。JSONとして読めなければ throw する（呼び出し側でメッセージにする）。
// <input type=file> には cancel イベントが無いため、window の focus 復帰で代用検知する。
export function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.hidden = true;
    let settled = false;

    function cleanup() {
      window.removeEventListener("focus", onFocus);
      input.remove();
    }
    function onFocus() {
      setTimeout(() => {
        if (!settled && !input.files?.length) { settled = true; cleanup(); resolve(null); }
      }, 300);
    }

    input.addEventListener("change", async () => {
      settled = true;
      const file = input.files?.[0];
      cleanup();
      if (!file) { resolve(null); return; }
      try {
        resolve(JSON.parse(await file.text()));
      } catch (e) {
        reject(new Error("JSONとして読み込めませんでした: " + String(e?.message ?? e)));
      }
    });

    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    input.click();
  });
}
