import type { Scenario } from "@venue/shared";
import { runScenarioCore } from "@venue/shared";
import type { Domain } from "./domains.js";
import type { DecisionService } from "./engine.js";

export { checkExpectations, getPath } from "@venue/shared";
export type { Check, ScenarioResult } from "@venue/shared";

/** Run one scenario against a rules version on neutral facts (no jitter, no live overrides). */
export function runScenario(svc: DecisionService, domain: Domain, s: Scenario, version: string) {
  return runScenarioCore(async (input, v) => (await svc.evaluate(domain, input, { version: v })).result, domain.facts, s, version);
}
