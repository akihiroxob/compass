import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, useId } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "tsx/esm/api";

test("同じ論理fieldの複数フォームは入力・要約・リンク・ARIA参照をフォーム内で対応させる", async () => {
  const web = register({ namespace: "form-error-ui", tsconfig: fileURLToPath(new URL("../src/web/tsconfig.json", import.meta.url)) });
  try {
    const { FormErrorSummary, fieldProps, invalidFieldIds } = await web.import("../src/web/components/FormErrorSummary.tsx", import.meta.url);
    const error = { kind: "validation", issues: [{ fieldId: "field-principalId", label: "Agent名", message: "required" }, { fieldId: null, label: "入力", message: "invalid" }] };
    const Form = () => {
      const formId = useId();
      return createElement("form", null,
        createElement(FormErrorSummary, { error, formId }),
        createElement("input", fieldProps(invalidFieldIds(error), "field-principalId", formId)),
        createElement("input", fieldProps(invalidFieldIds(error), "field-kind", formId)));
    };
    // Roleフォーム3件とCredentialフォームを同時表示する設定画面の構成。
    const markup = renderToStaticMarkup(createElement("main", null, ...Array.from({ length: 4 }, (_, key) => createElement(Form, { key }))));
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, 12);
    assert.equal(new Set(ids).size, ids.length);
    for (const form of markup.matchAll(/<form>(.*?)<\/form>/g)) {
      const summary = /role="alert"[^>]*id="([^"]+)"/.exec(form[1]!)?.[1];
      const target = /href="#([^"]+)"/.exec(form[1]!)?.[1];
      assert.ok(summary);
      assert.ok(target);
      assert.ok(form[1]!.includes(`id="${target}" aria-invalid="true" aria-describedby="${summary}"`));
      assert.equal((form[1]!.match(/aria-invalid/g) ?? []).length, 1);
    }
    // 単一フォーム画面の既存呼び出しも同じ論理IDを使える。
    assert.deepEqual(fieldProps(new Set(["field-title"]), "field-title"), { id: "field-title", "aria-invalid": true, "aria-describedby": "form-error-summary" });
  } finally {
    web.unregister();
  }
});
