import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decisionModelSchema } from "@gorules/jdm-editor/dist/schema";
import { buildApp } from "../src/app.js";
import { checkExpectations, getPath } from "../src/scenarios.js";
import { DEFAULT_DOMAINS_DIR } from "../src/domains.js";

const DOMAIN = "venue-selection";
const rulesDir = join(DEFAULT_DOMAINS_DIR, DOMAIN, "rules");

let ctx: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { ctx = await buildApp({ logDecisions: false }); });
afterAll(async () => { await ctx.app.close(); });

describe("JDM files", () => {
  const files = ["draft.json", ...readdirSync(join(rulesDir, "versions")).map((f) => `versions/${f}`)];
  it.each(files)("%s passes decisionModelSchema", (f) => {
    const parsed = decisionModelSchema.safeParse(JSON.parse(readFileSync(join(rulesDir, f), "utf8")));
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
  });
});

describe("scenarios via POST /decide", () => {
  const scenarios = JSON.parse(readFileSync(join(DEFAULT_DOMAINS_DIR, DOMAIN, "scenarios.json"), "utf8"));
  it("has at least 8 scenarios", () => expect(scenarios.length).toBeGreaterThanOrEqual(8));

  it.each(scenarios as any[])("$name", async (s) => {
    const facts = ctx.domains.get(DOMAIN)!.facts;
    facts.reset?.();
    for (const o of s.factsOverrides ?? []) facts.override!(o);
    try {
      const res = await ctx.app.inject({ method: "POST", url: `/domains/${DOMAIN}/decide`, payload: s.input });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      const failed = checkExpectations(body, s.expect).filter((c) => !c.ok);
      expect(failed, JSON.stringify(failed)).toEqual([]);
      // server metadata on every response
      expect(body.ruleVersion).toBe("v1");
      expect(body.decisionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof body.latencyMs).toBe("number");
    } finally {
      facts.reset?.();
    }
  });
});

describe("API behaviour", () => {
  const base = { customer: { id: "c1", tier: "standard", importanceScore: 20 }, txn: { asset: "BTC", fiat: "USD", amountUsd: 5000, urgency: "standard", requestedAt: "2026-10-14T12:00:00Z" } };

  it("rejects input that violates the domain schema", async () => {
    const res = await ctx.app.inject({ method: "POST", url: `/domains/${DOMAIN}/decide`, payload: { ...base, txn: { ...base.txn, asset: "DOGE" } } });
    expect(res.statusCode).toBe(400);
  });

  it("404s for unknown domains", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/domains/nope" })).statusCode).toBe(404);
  });

  it("lists discovered domains", async () => {
    const list = (await ctx.app.inject({ method: "GET", url: "/domains" })).json();
    expect(list).toContainEqual(expect.objectContaining({ name: DOMAIN, activeVersion: "v1" }));
  });

  it("simulate returns a trace of every node", async () => {
    const res = await ctx.app.inject({ method: "POST", url: `/domains/${DOMAIN}/simulate`, payload: { context: base } });
    const body = res.json();
    expect(Object.values(body.trace).map((t: any) => t.name)).toEqual(expect.arrayContaining(["Derive", "Strategy rules", "Venue availability", "Score & rank", "Guardrails"]));
    expect(getPath(body, "result.strategy")).toBe("best_price");
  });

  it("is independent of the machine timezone (UTC hour/weekday)", async () => {
    // 23:30Z Friday is still a weekday in UTC even though it is Saturday in e.g. Tokyo
    const input = { ...base, txn: { ...base.txn, amountUsd: 8_000_000, requestedAt: "2026-10-16T23:30:00Z" } };
    const body = (await ctx.app.inject({ method: "POST", url: `/domains/${DOMAIN}/simulate`, payload: input })).json();
    const derive: any = Object.values(body.trace).find((t: any) => t.name === "Derive");
    expect(derive.output).toMatchObject({ hourUtc: 23, isWeekend: false });
  });
});
