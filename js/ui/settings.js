// ui/settings.js — 設定モーダル。開くたびに生成し、閉じたら破棄する。

import { emit } from "../state.js";
import { el, clear } from "./dom.js";
import { bindModal } from "./modal.js";
import { PROVIDERS, DEFAULTS, FORMAT_LABELS, MAX_AGENTS, makeAgent,
         FREE_TIER_PRESET, estimateTokensPerRequest, expandSolo, DEFAULT_PERSONAS } from "../config.js";
import { loadSettings, saveSettings, getKey, setKey } from "../storage/settings.js";
import { loadPresets, savePreset, deletePreset, instantiatePreset } from "../storage/presets.js";
import { downloadJson, pickJsonFile, timestampedName } from "../filesave.js";
import { setMockConfig, mockConfig } from "../providers/mock.js";
import { listModels } from "../providers/index.js";
import { detectSummarizer } from "../summarize.js";
import { maskKey } from "../errors.js";
import { defaultAgents } from "../config.js";

// enabled: true のプロバイダだけ見せる（Phase 1a は mock と groq のみ）
function enabledProviders() {
  return Object.entries(PROVIDERS).filter(([, d]) => d.enabled);
}

function field(labelText, control, hint) {
  return el("label", { class: "field" }, [
    el("span", { class: "field-label", text: labelText }),
    control,
    hint ? el("span", { class: "field-hint", text: hint }) : null
  ]);
}

function select(value, options, onChange) {
  const s = el("select", { onChange: (e) => onChange(e.target.value) });
  for (const [v, label] of options) {
    s.appendChild(el("option", { value: v, text: label, selected: v === value }));
  }
  s.value = value;
  return s;
}

export function mountSettings(root, openButton) {
  let draft = null;
  // 開いた直後に当てるフォーカス先。render() の中で決まり、open() が使う。
  let pendingFocus = null;
  const modal = bindModal(root, close);

  // 取得済みの一覧を優先し、無ければ config.js の控えを使う。
  // 既定では議論に使えるものだけに絞る（D-016）。
  function availableModels(provider) {
    const fetched = (draft?.models?.[provider] ?? []).map(normalizeModel);
    if (!fetched.length) {
      return (PROVIDERS[provider]?.models ?? []).map((id) => ({ id, chat: true, contextWindow: null }));
    }
    return draft.showAllModels ? fetched : fetched.filter((m) => m.chat);
  }

  // 旧形式（文字列の配列）で保存された設定も読めるようにする
  function normalizeModel(m) {
    return typeof m === "string" ? { id: m, chat: true, contextWindow: null } : m;
  }

  function modelLabel(m) {
    if (!m.contextWindow) return m.id;
    const k = Math.round(m.contextWindow / 1024);
    // D-019: 8k 未満は日本語の議論には手狭。レート枠も小さいことが多い。
    return m.id + "  (" + k + "k" + (m.contextWindow < 8192 ? " ※小" : "") + ")";
  }

  function close() { modal.closed(); clear(root); root.hidden = true; }

  function open(focusProvider) {
    const st = loadSettings();
    draft = {
      keyStorage: st.keyStorage,
      agents: (st.agents ?? defaultAgents(3, "mock")).map((a) => ({ ...a })),
      debate: { ...DEFAULTS, ...(st.debate ?? {}) },
      keys: Object.fromEntries(enabledProviders().map(([p]) => [p, getKey(p)])),
      models: { ...(st.models ?? {}) },
      showAllModels: false,
      failMode: mockConfig.failMode ?? "",
      failTimes: mockConfig.failTimes ?? 0,
      selectedPreset: "",   // render() の再構築をまたいで「呼び出す」の選択を保つ（プリセット削除用）
      presetNameDraft: "",  // 同上。入力中に他の操作が render() を誘発しても入力途中の名前を保つ
      includeKeysOnExport: false,   // FR-11-03: 既定はキーを含めない
      importStatus: ""
    };
    pendingFocus = null;
    render(focusProvider);
    modal.opened(pendingFocus);
  }

  function render(focusProvider) {
    clear(root);
    root.hidden = false;

    const body = el("div", { class: "modal-body" });
    const d = draft.debate;   // 複数セクション（ソロ・審判・議論設定）から参照するため先に宣言する

    // --- プロバイダとAPIキー
    body.appendChild(el("h3", { text: "プロバイダとAPIキー" }));
    body.appendChild(field("キーの保存先",
      select(draft.keyStorage, [
        ["local", "このブラウザに保存（localStorage）"],
        ["session", "タブを閉じるまで（sessionStorage）"],
        ["none", "保存しない（メモリのみ）"]
      ], (v) => { draft.keyStorage = v; }),
      "保存先を変えると、前の保存先からは削除されます"));

    for (const [p, def] of enabledProviders()) {
      if (!def.needsKey) continue;
      const input = el("input", {
        type: "password", value: draft.keys[p] ?? "", placeholder: def.label + " のAPIキー",
        autocomplete: "off", spellcheck: "false",
        onInput: (e) => { draft.keys[p] = e.target.value; }
      });
      const toggle = el("button", {
        type: "button", class: "btn-mini", text: "表示",
        onClick: () => {
          const shown = input.getAttribute("type") === "text";
          input.setAttribute("type", shown ? "password" : "text");
          toggle.textContent = shown ? "表示" : "隠す";
        }
      });
      // D-014: モデルIDはプロバイダ側で入れ替わる。ハードコードせず取得する。
      const status = el("span", { class: "field-hint" });
      const fetchBtn = el("button", {
        type: "button", class: "btn-mini", text: "モデル取得",
        onClick: async () => {
          const key = draft.keys[p];
          if (!key) { status.textContent = "先にAPIキーを入れてください"; return; }
          fetchBtn.disabled = true;
          status.textContent = "取得中…";
          try {
            const list = await listModels(p, key);
            draft.models[p] = list;
            const chat = list.filter((m) => m.chat).length;
            status.textContent =
              "全 " + list.length + " 件のうち、議論に使えるのは " + chat + " 件です";
            render(p);
          } catch (e) {
            status.textContent = "取得できません: " + maskKey(e.message);
          } finally {
            fetchBtn.disabled = false;
          }
        }
      });
      const row = el("div", { class: "key-row" }, [input, toggle, fetchBtn]);
      const known = (draft.models[p] ?? []).filter((m) => m.chat).length;
      body.appendChild(field(def.label, row,
        (def.free ? "無料枠あり（モデルではなくレート上限で制限される）" : "従量課金") +
        (known ? " / 議論に使えるモデル " + known + " 件" : " / モデル未取得")));
      body.appendChild(el("div", { class: "field" }, [el("span"), status]));
      // AC-M08: キー未設定で誘導されたときは、そのプロバイダの入力欄から始める
      if (focusProvider === p) pendingFocus = input;
    }

    // --- 参加AIの編成
    body.appendChild(el("h3", { text: "参加AIの編成" }));
    body.appendChild(field("参加数",
      select(String(draft.agents.length),
        Array.from({ length: MAX_AGENTS }, (_, i) => [String(i + 1), (i + 1) + " 体"]),
        (v) => {
          const n = Number(v);
          const cur = draft.agents;
          draft.agents = Array.from({ length: n }, (_, i) =>
            cur[i] ? { ...cur[i], roleIndex: i, colorIndex: i % 5, shapeIndex: i % 5 }
                   : makeAgent(i, "mock", "", null));
          render();
        }),
      "A035: 増やすほど良いわけではない。3体前後が費用対効果の中心"));

    body.appendChild(field("モデルの絞り込み",
      select(String(draft.showAllModels), [
        ["false", "議論に使えるモデルだけ"],
        ["true", "取得した全モデル（音声認識なども含む）"]
      ], (v) => { draft.showAllModels = v === "true"; render(); }),
      "音声認識・音声合成・ガードレール用のモデルは chat では動きません"));

    const list = el("div", { class: "agent-list" });
    draft.agents.forEach((a, i) => {
      const provSel = select(a.provider, enabledProviders().map(([p, d]) => [p, d.label]), (v) => {
        // 既定名のままならプロバイダに追随させる。手で付けた名前は残す（D-015）。
        // 「モック1」のまま Groq に変えた過去の編成も拾えるよう、全ラベルで判定する
        const isDefault = Object.values(PROVIDERS).some((d) => a.name === d.label + (i + 1));
        if (isDefault) a.name = (PROVIDERS[v]?.label ?? v) + (i + 1);
        a.provider = v;
        a.model = availableModels(v)[0]?.id ?? "";
        render();
      });
      const available = availableModels(a.provider);
      const modelSel = available.length
        ? select(a.model, available.map((m) => [m.id, modelLabel(m)]), (v) => { a.model = v; })
        : el("input", {
            type: "text", value: a.model, placeholder: "モデルを取得するか直接入力",
            onInput: (e) => { a.model = e.target.value; }
          });
      const nameInput = el("input", {
        type: "text", value: a.name, maxlength: "20",
        onInput: (e) => { a.name = e.target.value; }
      });
      // FR-03-10（D-070）: 通常編成でも参加AIごとに視点・役割を持たせる。
      //   DebateAI 等の「名前付きペルソナ」に相当。空なら従来どおり何も注入しない。
      const personaInput = el("input", {
        type: "text", value: a.persona ?? "", maxlength: "80", class: "agent-persona",
        placeholder: "視点・役割（任意。例: 経済学者として費用対効果を重視）",
        onInput: (e) => { a.persona = e.target.value; }
      });
      list.appendChild(el("div", { class: "agent-row agent-" + a.colorIndex }, [
        el("span", { class: "agent-row-idx", text: "#" + (i + 1) }),
        nameInput, provSel, modelSel, personaInput
      ]));
    });
    body.appendChild(list);

    // --- ソロ議論モード（FR-03-09）。参加AIが1体のときだけ意味を持つ。
    //   エンジン本体には手を入れない設計判断（RV-M8）。config.js の expandSolo が
    //   「開始」の直前に同じモデルを複数ペルソナへ展開する（D-043）。
    body.appendChild(el("h3", { text: "ソロ議論モード" }));
    const solo = d.solo = { enabled: false, count: 3, personas: [], ...(d.solo ?? {}) };
    body.appendChild(field("有効にする",
      select(String(solo.enabled), [["false", "使わない"], ["true", "使う"]],
        (v) => { solo.enabled = v === "true"; render(); }),
      "参加AIを1体にすると、同じモデルのまま複数の思考スタイルを立てて議論させます（A017/A042）"));
    if (solo.enabled) {
      if (draft.agents.length !== 1) {
        body.appendChild(field("状態",
          el("span", { class: "field-hint judge-warn", text:
            "参加数が1体ではないため無効です（現在 " + draft.agents.length + " 体。上の「参加数」を1体にしてください）" })));
      }
      body.appendChild(field("ペルソナ数",
        select(String(solo.count), [2, 3, 4].map((n) => [String(n), n + " 体分"]),
          (v) => { solo.count = Number(v); solo.personas = []; render(); })));
      if (solo.personas.length !== solo.count) solo.personas = DEFAULT_PERSONAS.slice(0, solo.count);
      solo.personas.forEach((p, i) => {
        body.appendChild(field("ペルソナ " + (i + 1),
          el("input", { type: "text", value: p, maxlength: "60",
            onInput: (e) => { solo.personas[i] = e.target.value; } })));
      });
    }

    // --- 編成プリセット（FR-02-06）。APIキーは含めない。
    body.appendChild(el("h3", { text: "編成プリセット" }));
    const presets = loadPresets();
    if (presets.length) {
      // 選択状態は draft.selectedPreset に持たせる。呼び出し操作が render() を誘発するたびに
      // select 要素は作り直されるため、要素自身に選択値を持たせると「削除」が空振りする
      // （呼び出した直後に削除しようとすると、再構築後の select は常にプレースホルダーに戻っていた）。
      const presetSel = select(draft.selectedPreset,
        [["", "呼び出す（" + presets.length + "件）"], ...presets.map((p) => [p.name, p.name])],
        (v) => {
          draft.selectedPreset = v;
          if (!v) return;
          const preset = presets.find((p) => p.name === v);
          if (!preset) return;
          draft.agents = instantiatePreset(preset);
          render();
        });
      const delBtn = el("button", {
        type: "button", class: "btn-mini", text: "削除",
        onClick: () => {
          if (!draft.selectedPreset) return;
          deletePreset(draft.selectedPreset);
          draft.selectedPreset = "";
          render();
        }
      });
      body.appendChild(field("呼び出す", el("div", { class: "key-row" }, [presetSel, delBtn])));
    } else {
      body.appendChild(field("呼び出す",
        el("span", { class: "field-hint", text: "保存されたプリセットはまだありません" })));
    }
    // レビュー: 他のフィールドは全て draft 経由で render() をまたいで値を保つが、
    //   この入力欄だけ draft に書き戻していなかった。名前を打っている途中に render() を
    //   誘発する他の操作（モデル取得・参加数変更等）を行うと、入力がサイレントに消えていた。
    const presetNameInput = el("input", {
      type: "text", value: draft.presetNameDraft, placeholder: "例: 標準3体", maxlength: "30",
      onInput: (e) => { draft.presetNameDraft = e.target.value; }
    });
    body.appendChild(field("現在の編成を保存",
      el("div", { class: "key-row" }, [
        presetNameInput,
        el("button", {
          // モーダル下部の全体保存ボタンと文言が同じだと、テキストだけで要素を
          // 見分ける操作（自動テスト・スクリーンリーダー等）で誤って拾われる
          type: "button", class: "btn-mini", text: "この名前で保存",
          onClick: () => {
            const name = draft.presetNameDraft.trim();
            if (!name) return;
            savePreset(name, draft.agents);
            draft.presetNameDraft = "";
            render();
          }
        })
      ]),
      "参加AIの名前・プロバイダ・モデル・見た目を保存します。APIキーは含みません"));

    // --- 議論設定
    body.appendChild(el("h3", { text: "議論設定" }));

    // D-021: 無料枠は TPM（1分あたりトークン数）で効く。1回の要求量を抑える組み合わせを1発で入れる。
    // ソロモードが有効なら展開後の人数で見積もる（D-043）。
    const tokNow = estimateTokensPerRequest({ ...d, agents: expandSolo(draft.agents, d.solo) });
    body.appendChild(field("1リクエストの推定量",
      el("span", { class: "est-line", dataset: { over: String(tokNow > 6000) },
                   text: "最大 約" + tokNow.toLocaleString() + " トークン" }),
      "無料枠の TPM は概ね 6,000〜12,000。これを1回で超える設定はほぼ必ず待たされます"));

    body.appendChild(field("無料枠向けの設定",
      el("button", {
        type: "button", class: "btn-mini", text: "この設定を入れる",
        onClick: () => { Object.assign(draft.debate, FREE_TIER_PRESET); render(); }
      }),
      "2ラウンド・250字・直近1ラウンド・直前の発言のみ。1回あたり約1,000トークンに収まります"));
    body.appendChild(field("形式",
      select(d.format, Object.entries(FORMAT_LABELS), (v) => { d.format = v; })));
    body.appendChild(field("ラウンド数",
      el("input", { type: "number", min: "1", max: "10", value: String(d.rounds),
        onInput: (e) => { d.rounds = Number(e.target.value) || 1; } })));
    body.appendChild(field("総括ラウンド",
      select(String(d.enableSummaryRound), [["true", "あり"], ["false", "なし"]],
        (v) => { d.enableSummaryRound = v === "true"; })));
    body.appendChild(field("発言順",
      select(d.order, [["random", "毎ラウンドランダム（B003）"], ["fixed", "編成順で固定"]],
        (v) => { d.order = v; })));
    body.appendChild(field("通信トポロジ",
      select(d.topology, [
        ["all", "全員の発言を見る"], ["adjacent", "隣接2体のみ"],
        ["previous", "直前の1発言のみ"], ["judgeOnly", "討論者は直前のみ"]
      ], (v) => { d.topology = v; }), "A033: 絞るほどトークンが減る"));
    body.appendChild(field("1発言の文字数上限",
      el("input", { type: "number", min: "100", max: "2000", step: "50", value: String(d.maxChars),
        onInput: (e) => { d.maxChars = Number(e.target.value) || 400; } }),
      "出力トークンの上限もここから決まる。レート制限に当たるなら下げると効く"));
    body.appendChild(field("全文で渡す直近ラウンド数",
      el("input", { type: "number", min: "1", max: "5", value: String(d.contextRounds),
        onInput: (e) => { d.contextRounds = Number(e.target.value) || 2; } })));
    body.appendChild(field("セッションのリクエスト上限",
      el("input", { type: "number", min: "1", max: "200", value: String(d.requestLimit),
        onInput: (e) => { d.requestLimit = Number(e.target.value) || 30; } })));
    body.appendChild(field("離脱までの連続失敗回数",
      el("input", { type: "number", min: "1", max: "10", value: String(d.dropThreshold),
        onInput: (e) => { d.dropThreshold = Number(e.target.value) || 3; } })));
    body.appendChild(field("コンテキスト圧縮に要約を使う",
      select(String(d.enableContextSummary ?? true), [["true", "使う（Summarizer が使えるとき）"], ["false", "使わない（常に切り詰め）"]],
        (v) => { d.enableContextSummary = v === "true"; })));

    {
      const sumStatus = el("span", { class: "field-hint", text: "確認中…" });
      const dlBtn = el("button", { type: "button", class: "btn-mini", text: "モデルをダウンロード", hidden: true,
        onClick: () => { emit("summarizer:download-requested", null); sumStatus.textContent = "ダウンロードを開始しました（進行ログを見てください）"; dlBtn.hidden = true; } });
      body.appendChild(field("Chrome Summarizer",
        el("div", { class: "key-row" }, [sumStatus, dlBtn]),
        "日本語対応は Chrome 149 以降。使えないときは切り詰めで代替します"));
      detectSummarizer().then(({ state: st }) => {
        const LABELS = {
          available: "利用できます", downloadable: "ダウンロードすると使えます",
          downloading: "ダウンロード中です", unavailable: "このブラウザでは日本語の要約は使えません",
          unsupported: "この環境には Summarizer がありません"
        };
        sumStatus.textContent = LABELS[st] ?? st;
        dlBtn.hidden = st !== "downloadable";
      });
    }

    body.appendChild(field("推論の深さ",
      select(d.reasoningEffort ?? "low", [
        ["low", "low（本文に枠を回す・推奨）"],
        ["medium", "medium"],
        ["high", "high（思考に枠を使う）"]
      ], (v) => { d.reasoningEffort = v; }),
      "gpt-oss などの推論モデル向け。high にすると思考で出力枠を使い切り本文が空になることがあります"));

    body.appendChild(field("自動待機の上限秒数",
      el("input", { type: "number", min: "1", max: "600", value: String(d.maxWaitSec),
        onInput: (e) => { d.maxWaitSec = Number(e.target.value) || 60; } })));

    // --- 審判（Phase 2）
    body.appendChild(el("h3", { text: "審判（採点と論点抽出）" }));
    const jd = d.judge = { enabled: false, provider: null, model: null, checkStability: false,
                           synthesize: true, ...(d.judge ?? {}) };
    body.appendChild(field("審判を使う",
      select(String(jd.enabled), [["false", "使わない"], ["true", "使う（完走後に +2〜3 リクエスト）"]],
        (v) => { jd.enabled = v === "true"; render(); })));
    if (jd.enabled) {
      body.appendChild(field("審判のプロバイダ",
        select(jd.provider ?? "", [["", "選んでください"], ...enabledProviders().map(([p, def2]) => [p, def2.label])],
          (v) => { jd.provider = v || null; jd.model = availableModels(v)[0]?.id ?? null; render(); })));
      if (jd.provider) {
        const jm = availableModels(jd.provider);
        body.appendChild(field("審判のモデル",
          jm.length
            ? select(jd.model ?? "", jm.map((m) => [m.id, modelLabel(m)]), (v) => { jd.model = v; render(); })
            : el("input", { type: "text", value: jd.model ?? "", placeholder: "モデルを取得するか直接入力",
                onInput: (e) => { jd.model = e.target.value; } })));
        // B009: 自己贔屓バイアスの警告
        const same = draft.agents.filter((a) => a.provider === jd.provider && a.model === jd.model);
        if (same.length) {
          body.appendChild(el("div", { class: "field" }, [el("span"),
            el("span", { class: "field-hint judge-warn", text:
              "注意: 審判が " + same.map((a) => a.name).join("・") +
              " と同じモデルです。自分の発言に甘くなる傾向（自己贔屓バイアス・B009）があります" })]));
        }
      }
      body.appendChild(el("div", { class: "field" }, [el("span"),
        el("span", { class: "field-hint", text:
          "採点は発言者を「参加者A/B/…」に匿名化して行います（B003/B009 対策）" })]));

      // FR-08-09（D-070）: 議長による統合。既定ON。
      body.appendChild(field("結論を統合する",
        select(String(jd.synthesize), [
          ["true", "する（議長が一致点・相違点・結論を書く。+1 リクエスト）"],
          ["false", "しない"]
        ], (v) => { jd.synthesize = v === "true"; }),
        "「結論」タブに出ます。総括ラウンド（各AIの見解）とは別に、議題への答えを1つにまとめます"));

      // FR-08-07: 審判の安定性チェック（既定OFF・審判のスコアリングが実質倍になる）
      body.appendChild(field("審判の安定性を確認",
        select(String(jd.checkStability), [
          ["false", "確認しない"],
          ["true", "確認する（参加者のラベル割り当てを反転して再採点。+1 リクエスト）"]
        ], (v) => { jd.checkStability = v === "true"; }),
        "反転しても勝者が変わらなければ安定、変われば「不安定」と判定タブに表示します（B003 の位置バイアス検証）"));
    }

    // --- モックの故障モード
    body.appendChild(el("h3", { text: "モックの故障モード（検証用）" }));
    body.appendChild(field("failMode",
      select(draft.failMode, [
        ["", "正常"], ["429", "レート制限"], ["500", "サーバエラー"],
        ["timeout", "無応答"], ["empty", "空応答"], ["truncated", "途中で切れた応答"], ["413", "コンテキスト超過"], ["budget", "思考で枠を使い切る"],
        ["badjson", "壊れたJSON"],
        ["xss", "スクリプト混入（AC-A17）"], ["leak", "キー混入エラー（AC-A16）"]
      ], (v) => { draft.failMode = v; }),
      "モックは実プロバイダと同じ経路を通る。実APIキー無しで例外系を検証できる"));
    body.appendChild(field("failTimes",
      el("input", { type: "number", min: "0", max: "20", value: String(draft.failTimes ?? 0),
        onInput: (e) => { draft.failTimes = Math.max(0, Number(e.target.value) || 0); } }),
      "0 は failMode で失敗し続ける。1以上ならその回数だけ失敗してから正常応答に戻る" +
      "（例: 429・failTimes=1 で「待機後に自動再開する」を再現できる）"));

    // --- 設定のバックアップ（FR-11-03）。ここで触るのは draft だけで、
    //   反映は他の項目と同じく下の「保存」を押すまで確定しない。
    body.appendChild(el("h3", { text: "設定のバックアップ" }));
    body.appendChild(field("エクスポートにキーを含める",
      select(String(draft.includeKeysOnExport), [["false", "含めない（推奨）"], ["true", "含める"]],
        (v) => { draft.includeKeysOnExport = v === "true"; }),
      "ファイルは平文のJSONです。キーを含めた場合の取り扱いに注意してください"));

    const importStatus = el("span", { class: "field-hint", text: draft.importStatus });
    body.appendChild(field("ファイル",
      el("div", { class: "key-row" }, [
        el("button", {
          type: "button", class: "btn-mini", text: "エクスポート",
          onClick: () => {
            const out = {
              app: "aigiron", kind: "settings", version: 1, exportedAt: Date.now(),
              keyStorage: draft.keyStorage, agents: draft.agents,
              debate: draft.debate, models: draft.models
            };
            if (draft.includeKeysOnExport) {
              out.keys = Object.fromEntries(
                enabledProviders().filter(([, d]) => d.needsKey).map(([p]) => [p, draft.keys[p] ?? ""]));
            }
            downloadJson(timestampedName("aigiron-settings", "json"), out);
          }
        }),
        el("button", {
          type: "button", class: "btn-mini", text: "インポート",
          onClick: async () => {
            let parsed;
            try {
              parsed = await pickJsonFile();
            } catch (e) {
              draft.importStatus = String(e?.message ?? e);
              render();
              return;
            }
            if (!parsed) return;   // キャンセル
            if (!Array.isArray(parsed.agents) || !parsed.agents.length) {
              draft.importStatus = "設定ファイルとして読めませんでした（agents がありません）";
              render();
              return;
            }
            // レビュー: 通常の編成は必ず makeAgent()（id: "a"+i・roleIndex: i を付与）を
            //   通るが、インポート経路だけがこの正規化を素通りしていた。id/roleIndex が
            //   欠けたまま engine.start() へ渡ると、context.js の Map(id→agent) がキー
            //   衝突で上書きされ、実際には発言していないエージェントの発言として表示される
            //   （クラッシュしない静かなデータ破損）。ここで必ず振り直す。
            // 人数の上限も強制する。編成エディタは MAX_AGENTS までしか作れないが、
            // インポート経路だけが素通りしていた。上限を超えると匿名化のラベル（参加者A〜）が
            // 足りなくなり、審判に「参加者undefined」が渡る（D-046 の正規化の取りこぼし）。
            const over = parsed.agents.length - MAX_AGENTS;
            draft.agents = parsed.agents.slice(0, MAX_AGENTS).map((a, i) => {
              const provider = a && PROVIDERS[a.provider] ? a.provider : "mock";
              return {
                ...makeAgent(i, provider, a?.model, a?.name),
                persona: typeof a?.persona === "string" ? a.persona : "",
                stance: a?.stance ?? null
              };
            });
            draft.debate = { ...DEFAULTS, ...(parsed.debate ?? {}) };
            draft.models = parsed.models ?? {};
            if (parsed.keyStorage) draft.keyStorage = parsed.keyStorage;
            if (parsed.keys && typeof parsed.keys === "object") {
              for (const [p, v] of Object.entries(parsed.keys)) {
                if (p in draft.keys) draft.keys[p] = v;
              }
            }
            draft.importStatus = over > 0
              ? "読み込みました（参加AIは上限 " + MAX_AGENTS + " 体のため、超過した " + over +
                " 体は切り捨てました）。内容を確認して「保存」を押してください"
              : "読み込みました。内容を確認して「保存」を押してください";
            render();
          }
        }),
        importStatus
      ])));

    const footer = el("div", { class: "modal-foot" }, [
      el("button", { class: "btn", text: "キャンセル", onClick: close }),
      el("button", { class: "btn btn-primary", text: "保存", onClick: save })
    ]);

    root.appendChild(el("div", { class: "modal-backdrop", onClick: close }));
    root.appendChild(el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
      el("div", { class: "modal-head" }, [
        el("h2", { text: "設定" }),
        el("button", { class: "btn-mini", text: "閉じる", onClick: close })
      ]),
      body, footer
    ]));
  }

  function save() {
    saveSettings({ keyStorage: draft.keyStorage });   // 先に保存先を確定させる
    for (const [p, v] of Object.entries(draft.keys)) setKey(p, v);
    saveSettings({ agents: draft.agents, debate: draft.debate, models: draft.models });
    setMockConfig({ failMode: draft.failMode || null, failTimes: draft.failTimes ?? 0 });
    emit("settings:changed", null);
    emit("log:append", { level: "INFO", message: "設定を保存しました", at: Date.now() });
    close();
  }

  openButton.addEventListener("click", () => open(null));

  return { open, close };
}
