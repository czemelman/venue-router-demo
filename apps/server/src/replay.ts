import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replayCore, type ReplayRequest } from "@venue/shared";
import type { Domain } from "./domains.js";
import type { DecisionService } from "./engine.js";

export type { ReplayRequest };

function loggedInputs(d: Domain, n: number): unknown[] {
  const file = join(d.dir, "decisions.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l).input);
}

export function replay(svc: DecisionService, d: Domain, req: ReplayRequest) {
  return replayCore({
    evaluate: async (input, version) => (await svc.evaluate(d, input, { version })).result,
    facts: d.facts, scenarios: d.scenarios, activeVersion: d.activeVersion(), loggedInputs: (n) => loggedInputs(d, n),
  }, req);
}
