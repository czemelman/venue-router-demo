import type { ActionDef, ActionInstance, Group, Policy, RuleField, RuleSetDef, RulesConfig, Test, TreeNode } from "@venue/shared";

/**
 * Compiles visual rule trees into ZEN expression nodes. The tree is the source of truth;
 * the expressions are generated, so rule authors never write any.
 * Every output the rule set can produce gets one nested ternary: (cond) ? <then> : <else>.
 */

/**
 * ZEN string literals have no escape sequences (a backslash is literal, `\"` is a syntax error), so pick a delimiter
 * the text does not contain; if it contains all three quote kinds, split on backticks and concatenate.
 */
function strLit(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes("`")) return `\`${s}\``;
  return s.split("`").map((p) => `\`${p}\``).join(' + "`" + ');
}
const lit = (v: unknown): string =>
  typeof v === "string" ? `(${strLit(v)})` : Array.isArray(v) ? `[${v.map(lit).join(", ")}]` : JSON.stringify(v ?? null);
export type { Test };
const HIT = (set: RuleSetDef) => `${set.id}__hit`;

export class PolicyError extends Error {}

function testExpr(field: RuleField, op: string, value: unknown): string {
  const x = `(${field.expr})`;
  const list = () => lit(Array.isArray(value) ? value : [value]);
  switch (op) {
    case "in": return `${x} in ${list()}`;
    case "not in": return `not (${x} in ${list()})`;
    case "=": return `${x} == ${lit(value)}`;
    case "!=": return `${x} != ${lit(value)}`;
    case ">": case ">=": case "<": case "<=": return `${x} ${op} ${Number(value)}`;
    case "between": {
      const [lo, hi] = (value as number[]) ?? [0, 0];
      return `(${x} >= ${Number(lo)} and ${x} <= ${Number(hi)})`;
    }
    case "within": return `${x} < ${Number(value)}`; // share of traffic: bucket is 0-99
    case "contains": return `contains(${field.expr}, ${lit(String(value ?? ""))})`;
    case "starts with": return `startsWith(${field.expr}, ${lit(String(value ?? ""))})`;
    case "matches regex": return `matches(${field.expr}, ${lit(String(value ?? ""))})`;
    default: throw new PolicyError(`unknown comparator: ${op}`);
  }
}

/** Boolean expression for a group of tests joined by and/or (nested groups are parenthesised). */
export function groupExpr(fields: Map<string, RuleField>, g: Group): string {
  if (!g.items?.length) throw new PolicyError("a condition has no tests");
  const parts = g.items.map((i) => {
    if (i.kind === "group") return `(${groupExpr(fields, i)})`;
    const f = fields.get(i.field);
    if (!f) throw new PolicyError(`unknown field: ${i.field}`);
    return `(${testExpr(f, i.op, i.value)})`;
  });
  return parts.join(g.combinator === "or" ? " or " : " and ");
}

interface Ctx { rules: RulesConfig; set: RuleSetDef; fields: Map<string, RuleField>; actions: Map<string, ActionDef> }

/** Value an action list contributes to one output, as a ZEN literal, or undefined if it contributes nothing. */
function fromActions(ctx: Ctx, list: ActionInstance[], output: string): string | undefined {
  const values: unknown[] = [];
  let merge: string = "replace";
  for (const inst of list) {
    const def = ctx.actions.get(inst.actionId);
    if (!def) throw new PolicyError(`unknown action: ${inst.actionId}`);
    for (const e of def.emits) {
      if (e.output !== output) continue;
      merge = e.merge ?? "replace";
      const p = e.param ? def.params.find((x) => x.name === e.param) : undefined;
      values.push(e.param ? (inst.params?.[e.param] ?? p?.default) : e.value);
    }
  }
  if (values.length === 0) return undefined;
  if (merge === "append") return lit(values);
  if (merge === "or") return lit(values.some(Boolean));
  return lit(values[values.length - 1]);
}

const mergeOf = (ctx: Ctx, output: string): string => {
  for (const a of ctx.set.actions) for (const e of ctx.actions.get(a)?.emits ?? []) if (e.output === output) return e.merge ?? "replace";
  return "replace";
};

function emptyFor(ctx: Ctx, policy: { default: ActionInstance[] }, output: string): string {
  if (ctx.set.mode === "all") return { append: "[]", or: "false", replace: "null" }[mergeOf(ctx, output)]!;
  return fromActions(ctx, policy.default, output) ?? "null";
}

function ternary(ctx: Ctx, node: TreeNode | null, pick: (actions: ActionInstance[], id: string) => string | undefined, empty: string): string {
  if (!node) return empty;
  if (node.type === "actions") return pick(node.actions, node.id) ?? empty;
  return `(${groupExpr(ctx.fields, node.when)}) ? (${ternary(ctx, node.then, pick, empty)}) : (${ternary(ctx, node.else, pick, empty)})`;
}

export function compileSet(rules: RulesConfig, set: RuleSetDef, policy: Policy[string]): { key: string; value: string }[] {
  const ctx: Ctx = { rules, set, fields: new Map(rules.fields.map((f) => [f.id, f])), actions: new Map(rules.actions.map((a) => [a.id, a])) };
  const trees = set.mode === "first" ? policy.trees.slice(0, 1) : policy.trees;
  const outputs = set.filter ? ["include"] : [...new Set(set.actions.flatMap((a) => ctx.actions.get(a)?.emits.map((e) => e.output) ?? []))];
  const out: { key: string; value: string }[] = [];

  const hitFor = (tree: { root: TreeNode | null }, none: string) => ternary(ctx, tree.root, (_a, id) => lit(id), none);

  if (set.filter) {
    const value = ternary(ctx, trees[0]?.root ?? null, (a) => fromActions(ctx, a, "include"), emptyFor(ctx, policy, "include"));
    out.push({ key: set.filter.key, value: `filter(${set.filter.source}, ${value})` });
    return out;
  }

  for (const o of outputs) {
    const parts = trees.map((t) => ternary(ctx, t.root, (a) => fromActions(ctx, a, o), emptyFor(ctx, policy, o)));
    let value: string;
    if (set.mode === "first") value = parts[0] ?? emptyFor(ctx, policy, o);
    else {
      const m = mergeOf(ctx, o);
      value = parts.length === 0 ? emptyFor(ctx, policy, o) : m === "append" ? `flatten([${parts.join(", ")}])` : m === "or" ? parts.map((p) => `(${p})`).join(" or ") : parts[0];
    }
    out.push({ key: o, value });
  }
  // which leaf matched, so the UI can highlight the path taken
  out.push({ key: HIT(set), value: set.mode === "first" ? hitFor(trees[0] ?? { root: null }, lit("default")) : `[${trees.map((t) => hitFor(t, '""')).join(", ")}]` });
  return out;
}

/** Validate a policy against the domain's catalog. Throws PolicyError with a readable message. */
export function validatePolicy(rules: RulesConfig, policy: Policy) {
  const fields = new Map(rules.fields.map((f) => [f.id, f]));
  const actions = new Map(rules.actions.map((a) => [a.id, a]));
  const checkActions = (set: RuleSetDef, list: ActionInstance[]) => {
    for (const a of list) if (!set.actions.includes(a.actionId) || !actions.has(a.actionId)) throw new PolicyError(`${set.title}: action "${a.actionId}" is not allowed here`);
  };
  const walk = (set: RuleSetDef, n: TreeNode | null) => {
    if (!n) return;
    if (n.type === "actions") return checkActions(set, n.actions);
    const checkGroup = (g: Group) => {
      if (!g.items?.length) throw new PolicyError(`${set.title}: a condition has no tests`);
      for (const i of g.items) {
        if (i.kind === "group") checkGroup(i);
        else if (!set.fields.includes(i.field) || !fields.has(i.field)) throw new PolicyError(`${set.title}: condition field "${i.field}" is not allowed here`);
      }
    };
    checkGroup(n.when);
    walk(set, n.then); walk(set, n.else);
  };
  for (const set of rules.sets) {
    const p = policy[set.id];
    if (!p) throw new PolicyError(`policy is missing rule set "${set.id}"`);
    checkActions(set, p.default ?? []);
    for (const t of p.trees) walk(set, t.root);
  }
}

/** Replace each rule set's generated expression node in the JDM. */
export function compilePolicy<T extends { nodes: any[] }>(rules: RulesConfig, jdm: T, policy: Policy): T {
  validatePolicy(rules, policy);
  const nodes = jdm.nodes.map((n) => ({ ...n }));
  for (const set of rules.sets) {
    const idx = nodes.findIndex((n) => n.id === set.node);
    if (idx < 0) throw new PolicyError(`graph has no node "${set.node}" for rule set "${set.title}"`);
    const node = nodes[idx];
    nodes[idx] = {
      ...node,
      content: {
        ...node.content,
        passThrough: true,
        expressions: compileSet(rules, set, policy[set.id]).map((e, i) => ({ id: `${node.id}_g${i}`, key: e.key, value: e.value })),
      },
    };
  }
  return { ...jdm, nodes };
}
