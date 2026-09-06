// tests/jsonx.test.js — 寛容JSONパースと再要求ループ（AC-A15）。

import { group, test, atest, eq, ok } from "./runner.js";
import { extractJson, conforms, requestJson } from "../js/jsonx.js";

export async function run() {
  group("jsonx.js 寛容JSONパース");

  test("J-1 素のJSONを読める", () => {
    eq(extractJson('{"a":1}'), { a: 1 });
  });

  test("J-2 コードフェンス付きを読める", () => {
    const text = "```json\n{\"winner\":\"参加者A\",\"score\":7}\n```";
    eq(extractJson(text), { winner: "参加者A", score: 7 });
  });

  test("J-3 前置き・後置き付きを読める", () => {
    const text = "はい、以下が判定結果です。\n{\"a\":{\"b\":[1,2]}}\nご確認ください。";
    eq(extractJson(text), { a: { b: [1, 2] } });
  });

  test("J-4 壊れたJSONは null", () => {
    eq(extractJson("はい。```json\n{壊れ"), null);
    eq(extractJson("JSONはありません"), null);
    eq(extractJson(""), null);
    eq(extractJson(null), null);
  });

  // D-063: 末尾カンマは LLM の出力で頻出。救えないと毎回2リクエストを無駄にする。
  test("J-4b 末尾カンマは直して読む", () => {
    eq(extractJson('{"a":1,}'), { a: 1 });
    eq(extractJson('{"a":[1,2,],}'), { a: [1, 2] });
    eq(extractJson('{\n "a": 1,\n}'), { a: 1 }, "改行を挟んだ末尾カンマ");
  });

  test("J-4c 元から妥当なJSONの文字列値は書き換えない", () => {
    // 直接パースに成功する場合は救済処理を通らないため、値の中の `, }` は無傷
    eq(extractJson('{"a":"閉じ括弧 , } を含む"}'), { a: "閉じ括弧 , } を含む" });
  });

  test("J-5 conforms は型と検証関数で確かめる", () => {
    ok(conforms({ a: "x", n: 1, l: [] }, { a: "string", n: "number", l: "array" }));
    ok(!conforms({ a: 1 }, { a: "string" }), "型違いが通った");
    ok(!conforms(null, { a: "string" }), "null が通った");
    ok(conforms({ v: [1] }, { v: (x) => Array.isArray(x) && x.length > 0 }));
    ok(!conforms({ v: [] }, { v: (x) => Array.isArray(x) && x.length > 0 }));
  });

  await atest("J-6 パース失敗で指示を強めて再要求し、2回まで（AC-A15）", async () => {
    const prompts = [];
    let n = 0;
    const call = async (p) => {
      prompts.push(p);
      n++;
      if (n < 3) return { text: "すみません、JSONにできませんでした" };
      return { text: '{"a":"ok"}' };
    };
    const r = await requestJson(call, "基本の指示", { a: "string" }, { maxRetry: 2 });
    eq(r.ok, true);
    eq(r.json, { a: "ok" });
    eq(prompts.length, 3);
    ok(!prompts[0].includes("JSONオブジェクトのみ"), "初回から強い指示を足している");
    ok(prompts[1].includes("JSONオブジェクトのみ"), "再要求で指示が強まっていない");
  });

  await atest("J-7 全滅したら生テキストを返す（捨てない・AC-A15）", async () => {
    const call = async () => ({ text: "どうしてもJSONにしない" });
    const logs = [];
    const r = await requestJson(call, "指示", { a: "string" }, { maxRetry: 2, onLog: (m) => logs.push(m) });
    eq(r.ok, false);
    eq(r.raw, "どうしてもJSONにしない");
    eq(logs.length, 3, "失敗ごとに WARN が出るべき");
  });
}
