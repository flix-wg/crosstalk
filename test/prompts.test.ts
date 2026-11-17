import { expect, test } from "vitest";
import { promptMatcher } from "./prompts.js";
test("terminal prompts match across chunks and repeated confirmations are answered once each", () => {
  const answers: string[] = [], match = promptMatcher((s: string) => answers.push(s));
  for (const chunk of ['Type "con', 'firm"', ' more text Type ', '"confirm"', ' done']) match(chunk);
  expect(answers).toEqual(["confirm\n", "confirm\n"]);
});
