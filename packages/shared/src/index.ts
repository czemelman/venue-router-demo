/** Contract every domain's facts.ts default-exports. The server only knows this interface. */
export interface FactsProvider {
  /** Extra context merged into the request input before evaluation. */
  get(input: unknown): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Raw current facts for display (GET /domains/:d/facts). */
  snapshot(): Record<string, unknown>;
  /** Demo control: force part of the facts into a given state. */
  override?(body: unknown): Record<string, unknown>;
  /** Clear all overrides (used by tests / scenario runner). */
  reset?(): void;
  /** Stop timers on shutdown. */
  stop?(): void;
  /** Hold live jitter steady while the returned release function has not been called (replays). */
  freeze?(): () => void;
  /** Run fn with neutral facts and no overrides, then restore live state (scenario runs). */
  isolate?<T>(fn: () => Promise<T>): Promise<T>;
  /** Synthetic request input for replays; rng returns [0,1). */
  generateInput?(rng: () => number): unknown;
  /** Reduce an output to a bucket (for distribution charts) and a signature (to detect changed decisions). */
  describe?(output: any): { bucket: string; signature: string };
}

export interface Scenario {
  name: string;
  description?: string;
  input: unknown;
  /** Facts overrides applied (via facts.override) before running the scenario. */
  factsOverrides?: unknown[];
  /** Path -> expected value. `a.b[0]` paths; `.length` on arrays; a trailing `~` on the key means "array includes all of". */
  expect: Record<string, unknown>;
}

export interface DomainMeta {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

// ---- visual rule trees (IXOPAY-style) ----
/** percent: share of traffic, 0-100, matched against a stable per-request bucket. */
export type FieldType = "enum" | "number" | "text" | "boolean" | "percent";
export interface RuleField {
  id: string;
  label: string;
  group: string;
  type: FieldType;
  options?: string[];
  /** ZEN expression that reads the value. Written once by the domain author, never by the rule editor. */
  expr: string;
  hint?: string;
}
export interface ActionParam { name: string; label: string; type: FieldType; options?: string[]; default: unknown; min?: number; max?: number; step?: number }
export interface ActionEmit { output: string; param?: string; value?: unknown; merge?: "replace" | "append" | "or" }
export interface ActionDef { id: string; label: string; tone: "good" | "warn" | "bad" | "info"; description?: string; params: ActionParam[]; emits: ActionEmit[] }
export interface RuleSetDef {
  id: string;
  title: string;
  description: string;
  /** first: one tree, first matching branch wins. all: many independent rules, every match applies. */
  mode: "first" | "all";
  /** Expression node (in the JDM) that this rule set generates. */
  node: string;
  /** Evaluate the tree once per item of `source` and keep the items for which output "include" is true. */
  filter?: { key: string; source: string };
  fields: string[];
  actions: string[];
  multiAction?: boolean;
  /** Applied when a branch ends without an action. */
  default: ActionInstance[];
}
export interface RulesConfig { fields: RuleField[]; actions: ActionDef[]; sets: RuleSetDef[] }

export interface ActionInstance { actionId: string; params: Record<string, unknown> }
export type Op = "in" | "not in" | "=" | "!=" | ">" | ">=" | "<" | "<=" | "between" | "contains" | "starts with" | "matches regex" | "within";
export interface Test { id: string; kind: "test"; field: string; op: Op; value: unknown }
/** A group of tests joined by AND ("and") or OR ("or"); groups can nest. */
export interface Group { id: string; kind: "group"; combinator: "and" | "or"; items: (Test | Group)[] }
export interface ConditionNode {
  id: string; type: "condition"; when: Group; collapsed?: boolean;
  then: TreeNode | null; else: TreeNode | null;
}
export interface ActionsNode { id: string; type: "actions"; actions: ActionInstance[] }
export type TreeNode = ConditionNode | ActionsNode;
export interface RuleTree { id: string; name?: string; root: TreeNode | null }
export interface SetPolicy { trees: RuleTree[]; default: ActionInstance[] }
export type Policy = Record<string, SetPolicy>;

export * from "./compile.js";
export * from "./core.js";
export * from "./sha256.js";
