// The browser demo runs the WASI build of ZEN (@gorules/zen-engine-wasm32-wasip1), the same engine version compiled for the web.
// These tests check that it gives the same decisions as the native engine the server uses, and that the shared hash
// (used for traffic buckets in the browser) matches node:crypto.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { bucketOf, checkExpectations, sha256Hex } from "@venue/shared";
import { loadDomains, DEFAULT_DOMAINS_DIR } from "../src/domains.js";
import { DecisionService } from "../src/engine.js";

describe("sha256Hex", () => {
  it.each(["", "abc", "cust-1001", "a".repeat(200), "naïve ✓ 日本"])("matches node:crypto for %j", (s) => {
    expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });
});

describe("WASI engine matches the native engine", async () => {
  const { ZenEngine } = createRequire(import.meta.url)("@gorules/zen-engine-wasm32-wasip1");
  const wasi = new ZenEngine();
  const domains = await loadDomains(DEFAULT_DOMAINS_DIR);
  const svc = new DecisionService();
  for (const [name, d] of domains) {
    for (const s of d.scenarios) {
      it(`${name}: ${s.name}`, async () => {
        d.facts.reset?.();
        for (const o of s.factsOverrides ?? []) d.facts.override?.(o);
        const native = (await svc.evaluate(d, s.input, { version: "v1" })).result;
        const facts = await d.facts.get(s.input);
        const ctx = { ...(s.input as object), ...facts, meta: { now: new Date().toISOString(), domain: name, version: "v1", bucket: bucketOf(d.meta, s.input) } };
        const out = (await wasi.createDecision(Buffer.from(d.readRules("v1"))).evaluate(ctx)).result;
        d.facts.reset?.();
        expect(JSON.parse(JSON.stringify(out))).toEqual(JSON.parse(JSON.stringify(native)));
        expect(checkExpectations(out, s.expect).filter((c) => !c.ok)).toEqual([]);
      });
    }
  }
});
