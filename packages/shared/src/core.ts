import type { DomainMeta, FactsProvider, Scenario } from "./index.js";
import { sha256Hex } from "./sha256.js";

/** Evaluate one input against a rules version and return the output. Server and browser each supply their own. */
export type Evaluate = (input: unknown, version: string) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------- traffic buckets
/**
 * Stable 0-99 bucket for traffic splits (A/B tests, gradual rollouts). Hashed from `bucketBy` in domain.json
 * (a dotted path such as "customer.id") or from the whole input, so the same customer always lands in the same bucket.
 */
export function bucketOf(meta: DomainMeta, input: unknown): number {
  const path = (meta as { bucketBy?: string }).bucketBy;
  const key = path ? path.split(".").reduce<any>((o, k) => o?.[k], input) : input;
  return parseInt(sha256Hex(JSON.stringify(key ?? null)).slice(0, 8), 16) % 100;
}

// ---------------------------------------------------------------- scenarios
/** Read `a.b[0].c`, with `.length` on arrays. */
export function getPath(obj: unknown, path: string): unknown {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<any>((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

export interface Check { path: string; expected: unknown; actual: unknown; ok: boolean }
export interface ScenarioResult { name: string; pass: boolean; checks: Check[]; error?: string }

export function checkExpectations(output: unknown, expect: Scenario["expect"]): Check[] {
  return Object.entries(expect).map(([key, expected]) => {
    const includes = key.endsWith("~");
    const path = includes ? key.slice(0, -1) : key;
    const actual = getPath(output, path);
    const ok = includes
      ? Array.isArray(actual) && (expected as unknown[]).every((e) => actual.includes(e))
      : JSON.stringify(actual) === JSON.stringify(expected);
    return { path: key, expected, actual, ok };
  });
}

/** Run one scenario against a rules version on neutral facts (no jitter, no live overrides). */
export async function runScenarioCore(evaluate: Evaluate, facts: FactsProvider, s: Scenario, version: string): Promise<ScenarioResult> {
  const run = async (): Promise<ScenarioResult> => {
    try {
      for (const o of s.factsOverrides ?? []) facts.override?.(o);
      const checks = checkExpectations(await evaluate(s.input, version), s.expect);
      return { name: s.name, pass: checks.every((c) => c.ok), checks };
    } catch (e) {
      return { name: s.name, pass: false, checks: [], error: String(e) };
    }
  };
  if (facts.isolate) return facts.isolate(run);
  facts.reset?.();
  try { return await run(); } finally { facts.reset?.(); }
}

// ---------------------------------------------------------------- replay
export interface ReplayRequest { n?: number; a?: string; b?: string; source?: "synthetic" | "log" }

/** mulberry32: small seeded PRNG so both versions replay the same inputs, and reruns are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ReplayDeps {
  evaluate: Evaluate;
  facts: FactsProvider;
  scenarios: Scenario[];
  activeVersion: string;
  /** The last n logged inputs, oldest first. */
  loggedInputs: (n: number) => unknown[];
  /** Cap on inputs per replay (the browser demo uses a lower one). */
  maxInputs?: number;
}

export async function replayCore(d: ReplayDeps, req: ReplayRequest) {
  const n = Math.min(Math.max(req.n ?? 1000, 1), d.maxInputs ?? 5000);
  const a = req.a ?? "draft";
  const b = req.b ?? d.activeVersion;
  const source = req.source ?? "synthetic";
  const r = rng(42);
  const fallback = d.scenarios.map((s) => s.input);
  const inputs: unknown[] =
    source === "log"
      ? d.loggedInputs(n)
      : Array.from({ length: n }, (_, i) => d.facts.generateInput?.(r) ?? fallback[i % fallback.length]);
  if (inputs.length === 0) throw Object.assign(new Error("no inputs to replay (decision log is empty)"), { statusCode: 400 });

  const describe = d.facts.describe ?? ((o: any) => ({ bucket: "result", signature: JSON.stringify(o) }));
  const release = d.facts.freeze?.();
  const started = performance.now();
  const rows: { input: unknown; a: ReturnType<typeof describe>; b: ReturnType<typeof describe> }[] = [];
  try {
    for (let i = 0; i < inputs.length; i += 25) {
      const chunk = inputs.slice(i, i + 25);
      const res = await Promise.all(chunk.map(async (input) => ({
        input,
        a: describe(await d.evaluate(input, a)),
        b: describe(await d.evaluate(input, b)),
      })));
      rows.push(...res);
    }
  } finally {
    release?.();
  }

  const dist: Record<string, { a: number; b: number }> = {};
  for (const row of rows) {
    (dist[row.a.bucket] ??= { a: 0, b: 0 }).a++;
    (dist[row.b.bucket] ??= { a: 0, b: 0 }).b++;
  }
  const changed = rows.filter((r) => r.a.signature !== r.b.signature);
  return {
    n: rows.length, a, b, source,
    elapsedMs: Math.round(performance.now() - started),
    distribution: dist,
    changedCount: changed.length,
    samples: changed.slice(0, 25).map((r) => ({ input: r.input, a: r.a, b: r.b })),
  };
}
