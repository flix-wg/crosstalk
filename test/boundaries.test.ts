import { ESLint } from "eslint";
import { expect, test } from "vitest";

test("CLI cannot import core, while store-sqlite can import core types only", async () => {
  const eslint = new ESLint();
  const [cli] = await eslint.lintText('import { execute } from "../core/index.js"; execute();', {
    filePath: "src/cli/boundary-fixture.ts",
  });
  expect(cli.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleId: "@typescript-eslint/no-restricted-imports", severity: 2 }),
  ]));
  const [store] = await eslint.lintText('export type { SqlTx } from "../core/index.js";', {
    filePath: "src/store-sqlite/boundary-fixture.ts",
  });
  expect(store.errorCount).toBe(0);
  const [value] = await eslint.lintText('import { execute } from "../core/index.js"; execute();', {
    filePath: "src/store-sqlite/boundary-fixture.ts",
  });
  expect(value.errorCount).toBe(1);
  for (const code of ['await import("../core/index.js");', 'export type T = import("../core/index.js").SqlTx;']) {
    const [bypass] = await eslint.lintText(code, { filePath: "src/cli/boundary-fixture.ts" });
    expect(bypass.errorCount).toBeGreaterThan(0);
  }
});
