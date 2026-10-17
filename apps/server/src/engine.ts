import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ZenEngine, type ZenDecision } from "@gorules/zen-engine";
import { bucketOf } from "@venue/shared";
import type { Domain } from "./domains.js";

export interface EvaluateOptions {
  /** "draft" or a published version such as "v1". */
  version: string;
  trace?: boolean;
}

export interface Evaluation {
  result: Record<string, unknown>;
  trace?: unknown;
  performance?: string;
  ruleVersion: string;
  decisionId: string;
  latencyMs: number;
}

/**
 * One ZenEngine for the process. Compiled decisions are cached per (domain, version);
 * published versions are immutable so they never go stale. Draft is cached by content hash.
 */
export class DecisionService {
  private engine = new ZenEngine();
  private cache = new Map<string, ZenDecision>();

  private decisionFor(domain: Domain, version: string): ZenDecision {
    const raw = domain.readRules(version);
    const key = version === "draft" ? `${domain.name}@draft:${sha(raw)}` : `${domain.name}@${version}`;
    let decision = this.cache.get(key);
    if (!decision) {
      decision = this.engine.createDecision(Buffer.from(raw));
      if (version === "draft") for (const k of this.cache.keys()) if (k.startsWith(`${domain.name}@draft:`)) this.cache.delete(k);
      this.cache.set(key, decision);
    }
    return decision;
  }

  async evaluate(domain: Domain, input: unknown, { version, trace = false }: EvaluateOptions): Promise<Evaluation> {
    const started = performance.now();
    const facts = await domain.facts.get(input);
    const context = {
      ...(input as object),
      ...facts,
      meta: { now: new Date().toISOString(), domain: domain.name, version, bucket: bucketOf(domain.meta, input) },
    };
    const out = await this.decisionFor(domain, version).evaluate(context, trace ? { trace: true } : undefined);
    return {
      result: out.result,
      ...(trace ? { trace: out.trace, performance: out.performance } : {}),
      ruleVersion: version,
      decisionId: randomUUID(),
      latencyMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
  }

  /** Append one line to the domain's decision log. */
  logDecision(domain: Domain, input: unknown, ev: Evaluation) {
    const line = { decisionId: ev.decisionId, at: new Date().toISOString(), version: ev.ruleVersion, inputHash: sha(JSON.stringify(input)), input, output: ev.result, latencyMs: ev.latencyMs };
    appendFileSync(join(domain.dir, "decisions.jsonl"), JSON.stringify(line) + "\n");
  }

  dispose() {
    this.cache.clear();
    this.engine.dispose();
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
