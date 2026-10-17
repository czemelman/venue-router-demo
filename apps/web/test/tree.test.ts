import { describe, expect, it } from "vitest";
import type { ActionDef, ConditionNode, RuleField, RuleSetDef, RuleTree, TreeNode } from "@venue/shared";
import { ancestors, cloneNode, drop, find, mapNode, newCondition, testIssue, treeIssues, type Slot } from "../src/tree";

const fields: RuleField[] = [
  { id: "tier", label: "Tier", group: "C", type: "enum", options: ["gold", "std"], expr: "tier" },
  { id: "amount", label: "Amount", group: "C", type: "number", expr: "amount" },
  { id: "country", label: "Country", group: "C", type: "text", expr: "country" },
];
const actions: ActionDef[] = [
  { id: "approve", label: "Approve", tone: "good", params: [{ name: "reason", label: "Reason", type: "text", default: "OK" }], emits: [] },
  { id: "flag", label: "Flag", tone: "warn", params: [], emits: [] },
];
const rules = { fields, actions };
const single: RuleSetDef = { id: "s", title: "S", description: "", mode: "first", node: "n", fields: ["tier", "amount", "country"], actions: ["approve"], default: [] };
const multi: RuleSetDef = { ...single, mode: "all", actions: ["approve", "flag"], multiAction: true };
const tree = (root: TreeNode | null = null): RuleTree => ({ id: "t", root });
const root: Slot = { treeId: "t", kind: "root" };
const branch = (parentId: string, b: "then" | "else"): Slot => ({ treeId: "t", kind: "branch", parentId, branch: b });
const cond = (t: RuleTree) => t.root as ConditionNode;

describe("dropping onto the tree", () => {
  it("a condition into an empty root creates a one-test AND group", () => {
    const t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    expect(cond(t).type).toBe("condition");
    expect(cond(t).when).toMatchObject({ kind: "group", combinator: "and", items: [{ kind: "test", field: "tier", op: "=", value: "gold" }] });
  });
  it("number fields default to >= 0 and text to empty =", () => {
    expect(cond(drop(tree(), root, { type: "condition", fieldId: "amount" }, single, rules)!).when.items[0]).toMatchObject({ op: ">=", value: 0 });
    expect(cond(drop(tree(), root, { type: "condition", fieldId: "country" }, single, rules)!).when.items[0]).toMatchObject({ op: "=", value: "" });
  });
  it("rejects fields and actions the rule set does not allow", () => {
    expect(drop(tree(), root, { type: "condition", fieldId: "nope" }, single, rules)).toBeNull();
    expect(drop(tree(), root, { type: "action", actionId: "flag" }, single, rules)).toBeNull();
  });
  it("dropping a condition on an occupied branch nests the existing node under it (wrap)", () => {
    let t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    const a = drop(t, branch(t.root!.id, "then"), { type: "action", actionId: "approve" }, single, rules)!;
    const wrapped = drop(a, branch(a.root!.id, "then"), { type: "condition", fieldId: "amount" }, single, rules)!;
    const outer = cond(wrapped);
    const inner = outer.then as ConditionNode;
    expect(inner.type).toBe("condition");
    expect(inner.when.items[0]).toMatchObject({ field: "amount" });
    expect(inner.then?.type).toBe("actions"); // the old action moved below the new condition
  });
  it("an action replaces an action in single-action sets but appends in multi-action sets", () => {
    const base = (set: RuleSetDef) => {
      const t = drop(tree(), root, { type: "condition", fieldId: "tier" }, set, rules)!;
      return drop(t, branch(t.root!.id, "then"), { type: "action", actionId: "approve" }, set, rules)!;
    };
    const s = drop(base(single), branch(base(single).root!.id, "then"), { type: "action", actionId: "approve" }, single, rules)!;
    expect((cond(s).then as any).actions).toHaveLength(1);
    const m0 = base(multi);
    const m = drop(m0, branch(m0.root!.id, "then"), { type: "action", actionId: "flag" }, multi, rules)!;
    expect((cond(m).then as any).actions.map((a: any) => a.actionId)).toEqual(["approve", "flag"]);
  });
  it("an action cannot overwrite a whole sub-tree", () => {
    let t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    t = drop(t, branch(t.root!.id, "then"), { type: "condition", fieldId: "amount" }, single, rules)!;
    expect(drop(t, branch(t.root!.id, "then"), { type: "action", actionId: "approve" }, single, rules)).toBeNull();
  });
});

describe("moving and pasting", () => {
  it("moves a node to another branch and removes it from the old place", () => {
    let t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    t = drop(t, branch(t.root!.id, "then"), { type: "action", actionId: "approve" }, single, rules)!;
    const actionId = cond(t).then!.id;
    const moved = drop(t, branch(t.root!.id, "else"), { type: "move", nodeId: actionId, treeId: "t" }, single, rules)!;
    expect(cond(moved).then).toBeNull();
    expect(cond(moved).else?.id).toBe(actionId);
  });
  it("refuses to move a condition into its own subtree", () => {
    let t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    t = drop(t, branch(t.root!.id, "then"), { type: "condition", fieldId: "amount" }, single, rules)!;
    const outer = t.root!.id;
    const inner = cond(t).then!.id;
    expect(drop(t, branch(inner, "then"), { type: "move", nodeId: outer, treeId: "t" }, single, rules)).toBeNull();
    expect(drop(t, branch(outer, "then"), { type: "move", nodeId: outer, treeId: "t" }, single, rules)).toBeNull();
  });
  it("paste gives every copied node and test a fresh id", () => {
    let t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    t = drop(t, branch(t.root!.id, "then"), { type: "action", actionId: "approve" }, single, rules)!;
    const copy = cloneNode(t.root!) as ConditionNode;
    const ids = (n: TreeNode | null): string[] => (!n ? [] : n.type === "actions" ? [n.id] : [n.id, n.when.id, ...n.when.items.map((i) => i.id), ...ids(n.then), ...ids(n.else)]);
    const before = new Set(ids(t.root));
    for (const id of ids(copy)) expect(before.has(id)).toBe(false);
    // mutating the copy must not touch the original
    (copy.when.items[0] as any).value = "std";
    expect((cond(t).when.items[0] as any).value).toBe("gold");
  });
});

describe("helpers", () => {
  it("mapNode / find / ancestors agree", () => {
    let t = drop(tree(), root, { type: "condition", fieldId: "tier" }, single, rules)!;
    t = drop(t, branch(t.root!.id, "else"), { type: "condition", fieldId: "amount" }, single, rules)!;
    const leaf = cond(t).else!;
    expect(find(t.root, leaf.id)).toBe(leaf);
    expect(ancestors(t.root, leaf.id)).toEqual([t.root!.id]);
    expect(mapNode(t.root, leaf.id, () => null) && (mapNode(t.root, leaf.id, () => null) as ConditionNode).else).toBeNull();
  });
  it("flags tests that would be meaningless", () => {
    const f = (id: string) => fields.find((x) => x.id === id)!;
    const base = { id: "x", kind: "test" as const };
    expect(testIssue({ ...base, field: "tier", op: "in", value: [] }, f("tier"))).toMatch(/at least one/);
    expect(testIssue({ ...base, field: "country", op: "=", value: "" }, f("country"))).toMatch(/Enter a value/);
    expect(testIssue({ ...base, field: "amount", op: "between", value: [10, 5] }, f("amount"))).toMatch(/larger/);
    expect(testIssue({ ...base, field: "country", op: "matches regex", value: "([" }, f("country"))).toMatch(/regular expression/);
    expect(testIssue({ ...base, field: "tier", op: "in", value: ["gold"] }, f("tier"))).toBeNull();
    const empty = drop(tree(), root, { type: "condition", fieldId: "country" }, single, rules)!;
    expect(treeIssues(empty.root, new Map(fields.map((x) => [x.id, x])))).toHaveLength(1);
    expect(newCondition(f("tier")).when.items).toHaveLength(1);
  });
});
