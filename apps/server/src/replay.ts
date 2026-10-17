import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Domain } from "./domains.js";
import type { DecisionService } from "./engine.js";

export interface ReplayRequest { n?: number; a?: string; b?: string; source?: "synthetic" | "log" }

/** mulberry32: small seeded PRNG so draft and active replay the same inputs, and reruns are reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loggedInputs(d: Domain, n: number): unknown[] {
  const file = join(d.dir, "decisions.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l).input);
}

export async function replay(svc: DecisionService, d: Domain, req: ReplayRequest) {
  const n = Math.min(Math.max(req.n ?? 1000, 1), 5000);
  const a = req.a ?? "draft";
  const b = req.b ?? d.activeVersion();
  const source = req.source ?? "synthetic";
  const r = rng(42);
  const fallback = d.scenarios.map((s) => s.input);
  const inputs: unknown[] =
    source === "log"
      ? loggedInputs(d, n)
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
        a: describe((await svc.evaluate(d, input, { version: a })).result),
        b: describe((await svc.evaluate(d, input, { version: b })).result),
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
