import type { Scenario } from "@venue/shared";
import type { Domain } from "./domains.js";
import type { DecisionService } from "./engine.js";

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
export async function runScenario(svc: DecisionService, domain: Domain, s: Scenario, version: string): Promise<ScenarioResult> {
  const run = async (): Promise<ScenarioResult> => {
    try {
      for (const o of s.factsOverrides ?? []) domain.facts.override?.(o);
      const ev = await svc.evaluate(domain, s.input, { version });
      const checks = checkExpectations(ev.result, s.expect);
      return { name: s.name, pass: checks.every((c) => c.ok), checks };
    } catch (e) {
      return { name: s.name, pass: false, checks: [], error: String(e) };
    }
  };
  if (domain.facts.isolate) return domain.facts.isolate(run);
  domain.facts.reset?.();
  try { return await run(); } finally { domain.facts.reset?.(); }
}
