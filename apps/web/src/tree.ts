import type { ActionDef, ActionInstance, ConditionNode, Group, Op, RuleField, RuleSetDef, RuleTree, Test, TreeNode } from "@venue/shared";

export const uid = () => Math.random().toString(36).slice(2, 9);

export type Slot = { treeId: string } & ({ kind: "root" } | { kind: "branch"; parentId: string; branch: "then" | "else" });
export type Payload =
  | { type: "condition"; fieldId: string }
  | { type: "action"; actionId: string }
  | { type: "move"; nodeId: string; treeId: string }
  | { type: "paste"; node: TreeNode };

export const OPS: Record<string, Op[]> = {
  enum: ["=", "!=", "in", "not in"],
  text: ["=", "!=", "in", "not in", "contains", "starts with", "matches regex"],
  number: [">=", ">", "<=", "<", "=", "!=", "between"],
  boolean: ["="],
  percent: ["within"],
};
export const OP_LABEL: Record<string, string> = { "=": "is", "!=": "is not", in: "is any of", "not in": "is none of", ">": ">", ">=": "≥", "<": "<", "<=": "≤", between: "is between", contains: "contains", "starts with": "starts with", "matches regex": "matches regex", within: "is in the first" };

export const defaultActionParams = (def: ActionDef) => Object.fromEntries(def.params.map((p) => [p.name, p.default]));
export const newAction = (def: ActionDef): ActionInstance => ({ actionId: def.id, params: defaultActionParams(def) });

export function defaultValue(f: RuleField, op: string): unknown {
  if (f.type === "boolean") return true;
  if (f.type === "percent") return 10;
  if (f.type === "number") return op === "between" ? [0, 100] : 0;
  if (op === "in" || op === "not in") return f.type === "enum" ? [f.options![0]] : [];
  return f.type === "enum" ? f.options![0] : "";
}

export function newTest(f: RuleField): Test {
  const op = OPS[f.type][0];
  return { id: uid(), kind: "test", field: f.id, op, value: defaultValue(f, op) };
}
export const newGroup = (combinator: "and" | "or", items: Group["items"]): Group => ({ id: uid(), kind: "group", combinator, items });
export const newCondition = (f: RuleField): ConditionNode => ({ id: uid(), type: "condition", when: newGroup("and", [newTest(f)]), then: null, else: null });

/** Problem with a test that would make the rule meaningless, or null. */
export function testIssue(t: Test, f?: RuleField): string | null {
  if (!f) return "Unknown condition";
  const v = t.value;
  if ((t.op === "in" || t.op === "not in") && (!Array.isArray(v) || v.length === 0)) return "Pick at least one value";
  if ((t.op === "=" || t.op === "!=" || t.op === "contains" || t.op === "starts with" || t.op === "matches regex") && f.type === "text" && String(v ?? "") === "") return "Enter a value";
  if (t.op === "between" && Array.isArray(v) && Number(v[0]) > Number(v[1])) return "Minimum is larger than maximum";
  if (t.op === "matches regex") { try { new RegExp(String(v)); } catch { return "Not a valid regular expression"; } }
  return null;
}

export function groupIssues(g: Group, fields: Map<string, RuleField>): string[] {
  return g.items.flatMap((i) => (i.kind === "group" ? groupIssues(i, fields) : [testIssue(i, fields.get(i.field))].filter(Boolean) as string[]));
}
export function treeIssues(n: TreeNode | null, fields: Map<string, RuleField>): string[] {
  if (!n || n.type === "actions") return [];
  return [...groupIssues(n.when, fields), ...treeIssues(n.then, fields), ...treeIssues(n.else, fields)];
}

export const countNodes = (n: TreeNode | null): number => (!n ? 0 : n.type === "actions" ? 1 : 1 + countNodes(n.then) + countNodes(n.else));

/** Deep copy with fresh ids, for copy/paste. */
export function cloneNode(n: TreeNode): TreeNode {
  const cg = (g: Group): Group => ({ ...g, id: uid(), items: g.items.map((i) => (i.kind === "group" ? cg(i) : { ...i, id: uid(), value: structuredClone(i.value) })) });
  if (n.type === "actions") return { ...n, id: uid(), actions: structuredClone(n.actions) };
  return { ...n, id: uid(), when: cg(n.when), then: n.then && cloneNode(n.then), else: n.else && cloneNode(n.else) };
}

export function find(n: TreeNode | null, id: string): TreeNode | null {
  if (!n) return null;
  if (n.id === id) return n;
  return n.type === "condition" ? find(n.then, id) ?? find(n.else, id) : null;
}

/** ids of every ancestor condition of a node */
export function ancestors(n: TreeNode | null, id: string, trail: string[] = []): string[] | null {
  if (!n) return null;
  if (n.id === id) return trail;
  if (n.type !== "condition") return null;
  return ancestors(n.then, id, [...trail, n.id]) ?? ancestors(n.else, id, [...trail, n.id]);
}

/** Replace the node with this id by fn(node) (null removes it). */
export function mapNode(n: TreeNode | null, id: string, fn: (n: TreeNode) => TreeNode | null): TreeNode | null {
  if (!n) return null;
  if (n.id === id) return fn(n);
  if (n.type !== "condition") return n;
  return { ...n, then: mapNode(n.then, id, fn), else: mapNode(n.else, id, fn) };
}

const slotContent = (tree: RuleTree, s: Slot): TreeNode | null =>
  s.kind === "root" ? tree.root : (find(tree.root, s.parentId) as ConditionNode | null)?.[s.branch] ?? null;

function setSlot(tree: RuleTree, s: Slot, node: TreeNode | null): RuleTree {
  if (s.kind === "root") return { ...tree, root: node };
  return { ...tree, root: mapNode(tree.root, s.parentId, (p) => ({ ...(p as ConditionNode), [s.branch]: node })) };
}

/** Put a new, moved or pasted node into a slot. Returns null if the drop is not allowed. */
export function drop(tree: RuleTree, slot: Slot, payload: Payload, set: RuleSetDef, rules: { fields: RuleField[]; actions: ActionDef[] }): RuleTree | null {
  let t = tree;
  let node: TreeNode;
  if (payload.type === "move") {
    const moving = find(tree.root, payload.nodeId);
    if (!moving) return null;
    if (slot.kind === "branch" && (slot.parentId === payload.nodeId || find(moving, slot.parentId))) return null; // not into itself
    node = moving;
    t = { ...tree, root: mapNode(tree.root, payload.nodeId, () => null) };
  } else if (payload.type === "paste") {
    node = cloneNode(payload.node);
  } else if (payload.type === "condition") {
    if (!set.fields.includes(payload.fieldId)) return null;
    node = newCondition(rules.fields.find((f) => f.id === payload.fieldId)!);
  } else {
    if (!set.actions.includes(payload.actionId)) return null;
    node = { id: uid(), type: "actions", actions: [newAction(rules.actions.find((a) => a.id === payload.actionId)!)] };
  }
  const cur = slotContent(t, slot);
  if (!cur) return setSlot(t, slot, node);
  if (node.type === "condition") {
    if (node.then) return null; // would orphan the existing branch
    return setSlot(t, slot, { ...node, then: cur }); // nested condition: wrap what was there
  }
  if (cur.type === "actions") {
    if (set.multiAction) return setSlot(t, slot, { ...cur, actions: [...cur.actions, ...node.actions] });
    return setSlot(t, slot, node); // single-action sets: replace
  }
  return null; // an action cannot replace a whole sub-tree
}

export const describeValue = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));
