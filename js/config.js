// config.js — プロバイダ定義・既定値・表示ラベル。

import { mockFetch } from "./providers/mock.js";

// enabled で Phase ごとに開けていく。Phase 1a は mock と groq のみ。
export const PROVIDERS = {
  mock: {
    label: "モック", adapter: "mock", origin: null, path: "", auth: null,
    free: true, enabled: true, needsKey: false, fetchImpl: mockFetch,
    models: ["mock-fast", "mock-slow"]
  },
  groq: {
    label: "Groq", adapter: "openai-compat", origin: "https://api.groq.com",
    path: "/openai/v1/chat/completions", modelsPath: "/openai/v1/models", auth: "bearer",
    free: true, enabled: true, needsKey: true,
    models: []   // 設定画面から取得する。ハードコードは廃止（D-014）
  },
  gemini: {
    label: "Google Gemini", adapter: "gemini",
    origin: "https://generativelanguage.googleapis.com",
    path: "/v1beta/models/{model}:generateContent", modelsPath: "/v1beta/models", auth: "x-goog-api-key",
    free: true, enabled: true, needsKey: true,
    models: []
  },
  // 実機確認 VF-04: エラー応答に Access-Control-Allow-Origin が付かない。
  //   プリフライト(OPTIONS)は "*" を返すが実応答には無いため、ブラウザは 401/429 の
  //   ステータスを読めず TypeError になる。→ 429 を判別できず自動待機が働かない。
  //   実キーで 200 応答の ACAO を確認できるまで enabled:false のままにする。
  cerebras: {
    label: "Cerebras", adapter: "openai-compat", origin: "https://api.cerebras.ai",
    path: "/v1/chat/completions", modelsPath: "/v1/models", auth: "bearer",
    free: true, enabled: false, needsKey: true, corsBroken: true,
    models: []
  },
  mistral: {
    label: "Mistral", adapter: "openai-compat", origin: "https://api.mistral.ai",
    path: "/v1/chat/completions", modelsPath: "/v1/models", auth: "bearer",
    free: true, enabled: true, needsKey: true,
    models: []
  },
  openrouter: {
    label: "OpenRouter", adapter: "openai-compat", origin: "https://openrouter.ai",
    path: "/api/v1/chat/completions", modelsPath: "/api/v1/models", auth: "bearer",
    free: true, enabled: true, needsKey: true,
    models: []
  },
  openai: {
    label: "OpenAI", adapter: "openai-compat", origin: "https://api.openai.com",
    path: "/v1/chat/completions", modelsPath: "/v1/models", auth: "bearer",
    free: false, enabled: false, needsKey: true,
    models: []
  },
  anthropic: {
    label: "Anthropic", adapter: "anthropic", origin: "https://api.anthropic.com",
    path: "/v1/messages", modelsPath: "/v1/models", auth: "x-api-key",
    free: false, enabled: true, needsKey: true,
    extraHeaders: {
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    models: ["claude-haiku-4-5-20251001"]
  }
};

export const ROLE_LABELS = {
  propose: "提案役", critique: "批判役", free: "自由",
  both: "提案＋指摘", stance: "立場", summary: "総括",
  moderator: "司会"   // FR-05-07: 人間の差し込み（D-070）
};

// FR-05-07（D-070）: 人間が司会として差し込んだ発言の agentId。
//   参加AIの id は "a0","a1",… なので衝突しない。config.agents には含めない。
export const HUMAN_ID = "human";

export const AGENT_SHAPES = ["●", "■", "▲", "◆", "★"];

export const FORMAT_LABELS = {
  rotation: "持ち回り（提案役が交代）",
  debate: "対立型（賛成 / 反対）",
  allpropose: "全員提案＋指摘",
  free: "自由討論"
};

// FR-12-02: 最初の一歩を軽くするためのサンプル議題。賛否が割れやすいものを選ぶ。
export const SAMPLE_TOPICS = [
  "リモートワークは生産性を上げるか",
  "AIによる創作物に著作権を認めるべきか",
  "義務教育でプログラミングを必修にすべきか",
  "SNSの実名制は健全な議論を増やすか",
  "都市部への人口集中は是正すべきか",
  "終身雇用は今後も維持すべきか"
];

// A034: 3体・3ラウンドが費用対効果の中心
export const DEFAULTS = {
  format: "rotation",
  rounds: 3,
  enableSummaryRound: true,
  order: "random",
  topology: "all",
  maxChars: 400,
  contextRounds: 2,
  requestLimit: 30,
  dropThreshold: 3,
  maxWaitSec: 60,
  // FR-08-01: 審判の有無を選べる。**既定ON**。provider/model が未設定のうちは
  //   engine 側の条件（enabled && provider && model）で実際には走らないため、
  //   既定ONでも勝手にAPIを消費することはない。
  // FR-08-09（D-070）: synthesize は議長による統合（結論タブ）。完走後に +1 リクエスト。既定ON。
  judge: { enabled: true, provider: null, model: null, checkStability: false, synthesize: true },
  reasoningEffort: "low",       // 推論モデルの思考量。低いほど本文に枠が回る（D-024）
  enableContextSummary: true,
  solo: { enabled: false, count: 3, personas: [] }   // FR-03-09: ソロ議論モード（D-043）
};

// A035: 参加数を増やす効果は頭打ちになる
export const MAX_AGENTS = 5;

// D-021: 1リクエストが最大どれくらいのトークンを要求するかの目安。
//   無料枠は TPM（1分あたりトークン数）で効いてくるので、リクエスト数だけ見ても足りない。
//   maxChars を上げると「出力枠」と「過去発言の長さ」の両方が伸びる点が見えないと、
//   文字数上限を上げた結果レート制限に当たる、という手詰まりになる。
export function estimatePromptChars(cfg) {
  const n = cfg.agents?.length ?? 0;
  const maxChars = cfg.maxChars ?? 400;
  const base = 300 + (cfg.topicLength ?? 60);            // システム指示と議題
  const others = Math.max(0, n - 1) * (cfg.contextRounds ?? 2) * maxChars;
  const own = (cfg.rounds ?? 3) * maxChars;
  return base + others + own;
}

// 日本語は概ね 1 文字 1.1 トークン前後（モデルによってはこれより大きく割れる）
export function estimateTokensPerRequest(cfg) {
  const promptTokens = Math.round(estimatePromptChars(cfg) * 1.1);
  const outputTokens = Math.min(2000, Math.max(256, Math.round((cfg.maxChars ?? 400) * 2)));
  return promptTokens + outputTokens;
}

// D-081: 保存済み設定と既定値のマージ。**入れ子（judge / solo）は浅いマージだと既定が補われない**。
//   実際に踏んだ: `synthesize` を後から足したため、それ以前に保存された `judge` には
//   このキーが無い。`{...DEFAULTS, ...saved}` では `judge` ごと置き換わるので
//   `synthesize` が undefined になり、設定画面は既定の「する」を表示しているのに
//   エンジンは統合を実行しない、という食い違いが起きた。
//   新しいキーを DEFAULTS に足すたびに同じ問題が起きるので、ここで一律に補う。
const NESTED_KEYS = ["judge", "solo"];

export function mergeDebate(saved) {
  const out = { ...DEFAULTS, ...(saved ?? {}) };
  for (const k of NESTED_KEYS) {
    const d = DEFAULTS[k];
    const v = saved?.[k];
    out[k] = { ...d, ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}) };
  }
  return out;
}

// 無料枠でも通りやすい設定（D-021）
export const FREE_TIER_PRESET = {
  rounds: 2,
  enableSummaryRound: true,
  maxChars: 250,
  contextRounds: 1,
  topology: "previous",
  requestLimit: 20,
  maxWaitSec: 120
};

// 推定リクエスト数（IMPL §3.3）。再試行は含めない。
export function estimateRequests(cfg) {
  const n = cfg.agents?.length ?? 0;
  const rounds = cfg.rounds + (cfg.enableSummaryRound ? 1 : 0);
  // 審判は採点と論点抽出で2リクエスト（IMPL §3.3。再要求は見積りに含めない）。
  // FR-08-07: 安定性チェックをONにすると審判の再採点で+1（既定OFF）。
  // FR-08-01 で既定ONにしたため、provider/model が未設定なら加算しない
  //   （engine の実行条件と揃える。揃えないと、実際には走らない2件を見積りに載せてしまう）。
  const j = cfg.judge;
  // FR-08-09: 議長の統合をONにすると +1（D-070）。
  const judgeReq = (j?.enabled && j.provider && j.model)
    ? 2 + (j.checkStability ? 1 : 0) + (j.synthesize ? 1 : 0) : 0;
  return n * rounds + judgeReq;
}

// 参加AIを1体作る。roleIndex は編成順で確定し、以後変更しない（BD §3.1）。
export function makeAgent(i, provider, model, name) {
  const def = PROVIDERS[provider];
  return {
    id: "a" + i,
    roleIndex: i,
    name: name || (def ? def.label : provider) + (i + 1),
    provider,
    model: model || (def?.models?.[0] ?? ""),
    colorIndex: i % 5,
    shapeIndex: i % 5,
    stance: null,
    persona: "",
    status: "idle",
    failures: 0
  };
}

export function defaultAgents(n = 3, provider = "mock") {
  return Array.from({ length: n }, (_, i) =>
    makeAgent(i, provider, PROVIDERS[provider]?.models?.[0] ?? "", null));
}

// 対立型のときに賛成 / 反対を振り分ける
export function assignStances(agents) {
  return agents.map((a, i) => ({ ...a, stance: i % 2 === 0 ? "for" : "against" }));
}

// FR-03-09（ソロ議論モード）: A017 Self-Refine / A042 Multi-Persona Self-Collaboration。
// 参加AIが1体のとき、同じモデルの中に複数の思考スタイルを立てて議論させる既定ペルソナ。
export const DEFAULT_PERSONAS = [
  "楽観派。機会とメリットを重視し、前向きな根拠を挙げる。",
  "懐疑派。リスクと反例を重視し、主張の弱点を具体的に指摘する。",
  "調停派。両者の意見を整理し、折衷案や条件付き賛成を模索する。",
  "現実派。実行コストや運用上の制約を重視して評価する。"
];

// D-043: エンジン本体には手を入れない設計判断（RV-M8）。参加AIが1体のとき、同じ
//   プロバイダ・モデルのまま solo.count 体に「設定の段階で」展開する。展開後は
//   ただの複数エージェント構成になるため、エンジンは通常どおり処理できる。
export function expandSolo(agents, solo) {
  if (!solo?.enabled || agents.length !== 1) return agents;
  const base = agents[0];
  const n = Math.min(DEFAULT_PERSONAS.length, Math.max(2, solo.count ?? 3));
  const personas = solo.personas?.length === n ? solo.personas : DEFAULT_PERSONAS.slice(0, n);
  return Array.from({ length: n }, (_, i) => ({
    ...base,
    id: "a" + i,
    roleIndex: i,
    name: base.name + "（" + (i + 1) + "）",
    colorIndex: i % 5,
    shapeIndex: i % 5,
    persona: personas[i] || "",
    // D-070: 「ソロ展開された」ことを persona の有無ではなくこのフラグで表す。
    //   通常編成でもペルソナを付けられるようにしたため、persona の有無では区別できない。
    solo: true
  }));
}
