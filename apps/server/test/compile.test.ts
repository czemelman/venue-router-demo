import { describe, expect, it } from "vitest";
import { evaluateExpressionSync } from "@gorules/zen-engine";
import type { Group, RuleField, Test } from "@venue/shared";
import { groupExpr } from "../src/compile.js";

const field = (id: string, type: RuleField["type"], expr = id): RuleField => ({ id, label: id, group: "g", type, expr });
const fields = new Map([field("tier", "enum"), field("amount", "number"), field("country", "text"), field("bucket", "percent", "meta.bucket"), field("vip", "boolean")].map((f) => [f.id, f]));

let n = 0;
const t = (f: string, op: Test["op"], value: unknown): Test => ({ id: `t${n++}`, kind: "test", field: f, op, value });
const g = (combinator: "and" | "or", ...items: Group["items"]): Group => ({ id: `g${n++}`, kind: "group", combinator, items });
const ctx = { tier: "gold", amount: 5000, country: "DE-berlin", meta: { bucket: 17 }, vip: true };
const run = (grp: Group) => evaluateExpressionSync(groupExpr(fields, grp), ctx);

describe("rule conditions compile to correct engine logic", () => {
  it.each([
    [t("tier", "in", ["gold", "platinum"]), true], [t("tier", "in", ["standard"]), false],
    [t("tier", "not in", ["standard"]), true], [t("tier", "=", "gold"), true], [t("tier", "!=", "gold"), false],
    [t("amount", ">", 5000), false], [t("amount", ">=", 5000), true], [t("amount", "<", 5001), true], [t("amount", "<=", 4999), false],
    [t("amount", "between", [1000, 5000]), true], [t("amount", "between", [6000, 9000]), false],
    [t("country", "contains", "ber"), true], [t("country", "starts with", "FR"), false], [t("country", "matches regex", "^[A-Z]{2}-"), true],
    [t("country", "in", ["DE-berlin"]), true],
    [t("bucket", "within", 20), true], [t("bucket", "within", 10), false],
    [t("vip", "=", true), true], [t("vip", "=", false), false],
  ] as [Test, boolean][])("%j", (test, expected) => {
    expect(run(g("and", test))).toBe(expected);
  });

  const yes = t("tier", "=", "gold");
  const no = t("tier", "=", "standard");
  it("AND needs every test, OR needs one", () => {
    expect(run(g("and", yes, yes))).toBe(true);
    expect(run(g("and", yes, no))).toBe(false);
    expect(run(g("or", no, yes))).toBe(true);
    expect(run(g("or", no, no))).toBe(false);
  });
  it("nested groups keep their own precedence", () => {
    // no AND (yes OR no)  -> false; yes AND (no OR yes) -> true
    expect(run(g("and", no, g("or", yes, no)))).toBe(false);
    expect(run(g("and", yes, g("or", no, yes)))).toBe(true);
    // (no AND no) OR yes -> true, even though a flat reading "no AND no OR yes" is ambiguous
    expect(run(g("or", g("and", no, no), yes))).toBe(true);
    expect(run(g("and", g("or", no, no), yes))).toBe(false);
  });
  it("rejects an empty group and unknown fields", () => {
    expect(() => groupExpr(fields, g("and"))).toThrow(/no tests/);
    expect(() => groupExpr(fields, g("and", t("nope", "=", 1)))).toThrow(/unknown field/);
  });
  it("quotes values safely (no expression injection)", () => {
    const evil = 'x") or true or ("';
    // every quote kind and a backslash in one value must round-trip exactly
    const nasty = "a\"b'c`d\\e";
    expect(run(g("and", t("country", "=", nasty)))).toBe(false);
    expect(evaluateExpressionSync(groupExpr(fields, g("and", t("country", "=", nasty))), { ...ctx, country: nasty })).toBe(true);
    expect(evaluateExpressionSync(groupExpr(fields, g("and", t("country", "matches regex", "^[A-Z]\\d$"))), { ...ctx, country: "A1" })).toBe(true);
    expect(run(g("and", t("country", "=", evil)))).toBe(false);
    expect(run(g("and", t("country", "contains", evil)))).toBe(false);
  });
});
