import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * `styles/_tokens.scss`の色の組合せのコントラスト（WCAG 2.x）を正本の値から測定する（`npm run check:ui`）。
 * 文字は4.5:1以上、入力の枠・焦点表示・状態の枠等の非テキストは3:1以上。disabledはWCAGの対象外のため測らない。
 */

const tokensSource = readFileSync(new URL("../src/web/styles/_tokens.scss", import.meta.url), "utf8");
const declarations = new Map([...tokensSource.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

const resolveColor = (name: string, seen: string[] = []): string => {
  const value = declarations.get(name);
  assert.ok(value, `${name}が_tokens.scssに無い`);
  assert.ok(!seen.includes(name), `${name}の参照が循環している`);
  const ref = value.match(/^var\((--[\w-]+)\)$/)?.[1] ?? value.match(/solid var\((--[\w-]+)\)$/)?.[1];
  if (ref) return resolveColor(ref, [...seen, name]);
  assert.match(value, /^#([0-9a-f]{3}|[0-9a-f]{6})$/i, `${name}は不透明な#rgb・#rrggbbで測る（${value}）`);
  return value;
};

const luminance = (hex: string) => {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + .05) / (lo + .05);
};

const surfaces = ["--color-paper", "--color-surface", "--color-note"];
/** [前景, 背景, 用途]。文字の組合せ。 */
const textPairs: [string, string, string][] = [
  ...["--color-text", "--color-text-secondary", "--color-text-muted", "--color-brand"].flatMap((fg) => surfaces.map((bg): [string, string, string] => [fg, bg, "本文・注記・リンク"])),
  ["--color-brand", "--color-brand-soft", "補助ボタンのhover・nav/ViewSwitchのhoverの文字"],
  ["--color-text", "--color-brand-soft", "nav/ViewSwitchのhoverの文字"],
  ["--color-on-brand", "--color-brand", "主要ボタン・選択中のnav/ViewSwitch"],
  ["--color-on-brand", "--color-brand-strong", "主要ボタンのhover"],
  ["--color-danger", "--color-surface", "危険操作の補助ボタン・失敗の文字"],
  ["--color-danger", "--color-danger-soft", "失敗の区画・危険操作のhover"],
  ["--color-danger", "--color-danger-softer", "確認パネル"],
  ["--color-on-brand", "--color-danger", "危険操作の主要ボタン"],
  ["--color-on-brand", "--color-danger-strong", "危険操作の主要ボタンのhover"],
  ["--color-inverse-text", "--color-inverse", "濃い面の文字"],
  ["--color-inverse-muted", "--color-inverse", "濃い面の未設定"],
  ["--color-text", "--field-readonly-background", "読取専用の入力"],
  ["--tone-attention-fg", "--tone-attention-bg", "状態: 要対応"],
  ["--tone-waiting-fg", "--color-surface", "状態: 待機"],
  ["--tone-waiting-fg", "--color-paper", "状態: 待機"],
  ["--tone-progress-fg", "--tone-progress-bg", "状態: 進行中"],
  ["--tone-done-fg", "--tone-done-bg", "状態: 完了"],
  ["--tone-muted-fg", "--tone-muted-bg", "状態: 終了"],
  ["--tone-warning-fg", "--tone-warning-bg", "状態: 警告"],
];
/** 非テキスト（枠・焦点表示）の組合せ。 */
const nonTextPairs: [string, string, string][] = [
  ...surfaces.map((bg): [string, string, string] => ["--field-border-color", bg, "入力欄・ViewSwitchの枠"]),
  ...surfaces.map((bg): [string, string, string] => ["--focus-ring", bg, "焦点表示"]),
  ["--focus-ring", "--color-brand-soft", "焦点表示（淡い強調の上）"],
  ["--field-invalid-color", "--color-surface", "エラーの入力欄の枠"],
  ["--tone-waiting-border", "--color-surface", "状態: 待機の枠"],
  ["--color-brand", "--color-surface", "補助ボタンの枠"],
];

const measure = (pairs: [string, string, string][], minimum: number) => pairs.map(([fg, bg, use]) => {
  const ratio = contrast(resolveColor(fg), resolveColor(bg));
  return { fg, bg, use, ratio: Math.floor(ratio * 100) / 100, ok: ratio >= minimum };
});

test("tokens: text colors meet WCAG AA 4.5:1 on their backgrounds", (t) => {
  const results = measure(textPairs, 4.5);
  for (const r of results) t.diagnostic(`${r.ratio.toFixed(2)}:1 ${r.fg} on ${r.bg}（${r.use}）`);
  assert.deepEqual(results.filter((r) => !r.ok), []);
});

test("tokens: borders and focus meet 3:1 non-text contrast", (t) => {
  const results = measure(nonTextPairs, 3);
  for (const r of results) t.diagnostic(`${r.ratio.toFixed(2)}:1 ${r.fg} on ${r.bg}（${r.use}）`);
  assert.deepEqual(results.filter((r) => !r.ok), []);
});

test("tokens: brand and status colors are distinct", () => {
  const brand = resolveColor("--color-brand").toLowerCase();
  for (const name of ["--color-danger", "--tone-attention-bg", "--tone-done-fg", "--tone-warning-fg"])
    assert.notEqual(resolveColor(name).toLowerCase(), brand, `${name}はブランド色と分ける`);
});

test("tokens: contrast measurement rejects a failing pair", () => {
  assert.ok(contrast("#7a8794", "#ffffff") >= 3 && contrast("#7a8794", "#ffffff") < 4.5);
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
});
