import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, parseRun, ReviewSchema } from "../src/contracts.ts";
import { run } from "./helpers.ts";

test("external findings use reviewer IDs rather than coordinator UUIDs", () => {
  const review = parse(
    ReviewSchema,
    {
      verdict: "findings",
      reviewedHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      summary: "One defect",
      findings: [
        {
          id: "R1",
          priority: 1,
          path: "src/feature.ts",
          line: 7,
          detail: "The output can be stale",
          disposition: "open",
          evidence: "",
        },
      ],
    },
    "review",
  );
  assert.equal(review.findings[0]?.id, "R1");
});

test("persisted runs reject changed plan content, unsafe IDs, and forged branches", () => {
  const current = run();
  assert.equal(parseRun(current).id, current.id);
  assert.throws(() => parseRun({ ...current, id: "../other" }), /Invalid/);
  assert.throws(
    () => parseRun({ ...current, plan: { ...current.plan, body: "Different accepted work" } }),
    /content changed/,
  );
  assert.throws(
    () =>
      parseRun({ ...current, units: current.units.map((unit) => ({ ...unit, branch: "main" })) }),
    /branch identity/,
  );
});
