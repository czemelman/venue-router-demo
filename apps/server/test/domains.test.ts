import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decisionModelSchema } from "@gorules/jdm-editor/dist/schema";
import { buildApp } from "../src/app.js";
import { DEFAULT_DOMAINS_DIR } from "../src/domains.js";

// Work on a copy so publish/activate tests never touch the real domain files.
let dir: string;
let ctx: Awaited<ReturnType<typeof buildApp>>;
const post = (url: string, payload?: unknown) => ctx.app.inject({ method: "POST", url, payload: payload as any });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "domains-"));
  cpSync(DEFAULT_DOMAINS_DIR, dir, { recursive: true });
  ctx = await buildApp({ domainsDir: dir, logDecisions: true });
});
afterAll(async () => { await ctx.app.close(); });

describe("generality: payout-approval (no changes outside domains/)", () => {
  it("is discovered alongside venue-selection", async () => {
    const names = (await ctx.app.inject({ url: "/domains" })).json().map((d: any) => d.name);
    expect(names).toEqual(expect.arrayContaining(["venue-selection", "payout-approval"]));
  });
  it("JDM files pass decisionModelSchema", () => {
    for (const f of ["draft.json", "versions/v1.json"]) {
      expect(decisionModelSchema.safeParse(JSON.parse(readFileSync(join(dir, "payout-approval/rules", f), "utf8"))).success).toBe(true);
    }
  });
  it("all scenarios pass via /scenarios/run", async () => {
    const body = (await post("/domains/payout-approval/scenarios/run")).json();
    expect(body.results.filter((r: any) => !r.pass)).toEqual([]);
    expect(body.total).toBe(7);
  });
});

describe("versioning on venue-selection", () => {
  const small = { customer: { id: "c", tier: "standard", importanceScore: 20 }, txn: { asset: "BTC", fiat: "USD", amountUsd: 5000, urgency: "standard", requestedAt: "2026-10-14T12:00:00Z" } };

  it("publish -> activate -> rollback, with decision log", async () => {
    const draft = (await ctx.app.inject({ url: "/domains/venue-selection/rules/draft" })).json();
    // edit the visual policy: the default (no rule matched) strategy becomes "fastest"
    draft.policy.strategy.default[0].params.strategy = "fastest";
    expect((await ctx.app.inject({ method: "PUT", url: "/domains/venue-selection/rules/draft", payload: draft })).statusCode).toBe(200);

    const pub = (await post("/domains/venue-selection/rules/publish", { author: "tester", note: "default -> fastest" })).json();
    expect(pub).toMatchObject({ version: "v2", author: "tester", note: "default -> fastest" });
    expect((await post("/domains/venue-selection/decide", small)).json().strategy).toBe("best_price"); // still v1

    expect((await post("/domains/venue-selection/rules/activate/v2")).statusCode).toBe(200);
    expect((await post("/domains/venue-selection/decide", small)).json()).toMatchObject({ strategy: "fastest", ruleVersion: "v2" });

    const v1 = JSON.parse(readFileSync(join(dir, "venue-selection/rules/versions/v1.json"), "utf8"));
    expect(v1.policy.strategy.default[0].params.strategy).toBe("best_price"); // immutable

    expect((await post("/domains/venue-selection/rules/activate/v1")).statusCode).toBe(200); // rollback
    expect((await post("/domains/venue-selection/decide", small)).json().ruleVersion).toBe("v1");
    expect((await post("/domains/venue-selection/rules/activate/v99")).statusCode).toBe(404);

    const vs = (await ctx.app.inject({ url: "/domains/venue-selection/rules/versions" })).json();
    expect(vs.active).toBe("v1");
    expect(vs.versions.map((v: any) => v.version)).toEqual(["v1", "v2"]);

    const log = (await ctx.app.inject({ url: "/domains/venue-selection/decisions?limit=10" })).json();
    expect(log[0]).toMatchObject({ version: "v1" });
    expect(log.map((l: any) => l.version)).toContain("v2");
  });

  it("rejects a policy that uses a condition or action the rule set does not allow", async () => {
    const draft = (await ctx.app.inject({ url: "/domains/venue-selection/rules/draft" })).json();
    draft.policy.strategy.trees[0].root.when.items[0].field = "venue.status"; // venue field in a request-level rule set
    const res = await ctx.app.inject({ method: "PUT", url: "/domains/venue-selection/rules/draft", payload: draft });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not allowed here/);
  });

  it("replay v2 vs v1 changes decisions; counts sum to n; identical versions change nothing", async () => {
    const res = (await post("/domains/venue-selection/replay", { n: 200, a: "v2", b: "v1" })).json();
    const sum = (k: "a" | "b") => Object.values<any>(res.distribution).reduce((s, v) => s + v[k], 0);
    expect([res.n, sum("a"), sum("b")]).toEqual([200, 200, 200]);
    expect(res.changedCount).toBeGreaterThan(0);
    expect(res.samples.length).toBeGreaterThan(0);
    expect((await post("/domains/venue-selection/replay", { n: 50, a: "v1", b: "v1" })).json().changedCount).toBe(0);
  });

  it("replay from the decision log", async () => {
    expect((await post("/domains/venue-selection/replay", { n: 10, a: "v1", b: "v2", source: "log" })).json().n).toBeGreaterThan(0);
  });

  it("scenario run is isolated from live overrides and restores them", async () => {
    const facts = ctx.domains.get("venue-selection")!.facts;
    facts.override!({ venueId: "atlas", status: "down" });
    const body = (await post("/domains/venue-selection/scenarios/run")).json();
    expect(body.results.filter((r: any) => !r.pass)).toEqual([]);
    expect((facts.snapshot() as any).venues.find((v: any) => v.id === "atlas").status).toBe("down");
    facts.reset!();
  });

  it("override validates venue ids", async () => {
    expect((await post("/domains/venue-selection/facts/override", { venueId: "nope", status: "down" })).statusCode).toBe(400);
  });
});
