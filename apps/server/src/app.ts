import Fastify from "fastify";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionModelSchema } from "@gorules/jdm-editor/dist/schema";
import { loadDomains, NotFoundError, type Domain } from "./domains.js";
import { DecisionService } from "./engine.js";
import { activate, listVersions, loadIntoDraft, publish } from "./versions.js";
import { replay } from "./replay.js";
import { compilePolicy, PolicyError } from "./compile.js";
import { runScenario } from "./scenarios.js";

export async function buildApp(opts: { domainsDir?: string; log?: boolean; logDecisions?: boolean } = {}) {
  const app = Fastify({ logger: opts.log ?? false });
  const domains = await loadDomains(opts.domainsDir);
  const svc = new DecisionService();
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });
  addFormats(ajv);
  const validators = new Map(Array.from(domains, ([name, d]) => [name, ajv.compile(d.meta.inputSchema as object)]));

  const domainOf = (name: string): Domain => {
    const d = domains.get(name);
    if (!d) throw new NotFoundError(`unknown domain: ${name}`);
    return d;
  };
  const validInput = (d: Domain, input: unknown) => {
    const v = validators.get(d.name)!;
    if (!v(input)) throw Object.assign(new Error("invalid input"), { statusCode: 400, details: v.errors });
    return input;
  };

  app.setErrorHandler((err: any, _req, reply) => {
    const status = err instanceof NotFoundError ? 404 : err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: err.message, details: err.details });
  });

  app.get("/domains", async () => Array.from(domains.values(), (d) => ({ name: d.name, description: d.meta.description, activeVersion: d.activeVersion() })));

  app.get<{ Params: { d: string } }>("/domains/:d", async (req) => {
    const d = domainOf(req.params.d);
    return { ...d.meta, scenarios: d.scenarios, activeVersion: d.activeVersion() };
  });

  app.get<{ Params: { d: string } }>("/domains/:d/facts", async (req) => domainOf(req.params.d).facts.snapshot());

  app.post<{ Params: { d: string } }>("/domains/:d/facts/override", async (req) => {
    const d = domainOf(req.params.d);
    if (!d.facts.override) throw Object.assign(new Error("domain facts are not overridable"), { statusCode: 400 });
    try {
      return d.facts.override(req.body);
    } catch (e) {
      throw Object.assign(e as Error, { statusCode: 400 });
    }
  });

  app.get<{ Params: { d: string } }>("/domains/:d/rules/draft", async (req) => JSON.parse(domainOf(req.params.d).readRules("draft")));

  // Body is the JDM graph, optionally with `policy` (the visual rule trees). Without `policy` the stored one is kept.
  // The generated expression nodes are always rebuilt from the policy, so they can never drift from the tree.
  app.put<{ Params: { d: string } }>("/domains/:d/rules/draft", async (req) => {
    const d = domainOf(req.params.d);
    const { policy: sent, ...graph } = (req.body ?? {}) as any;
    const parsed = decisionModelSchema.safeParse(graph);
    if (!parsed.success) throw Object.assign(new Error("invalid decision model"), { statusCode: 400, details: parsed.error.issues.slice(0, 10) });
    const policy = sent ?? JSON.parse(d.readRules("draft")).policy;
    let out: any = graph;
    const rules = (d.meta as any).rules;
    if (rules && policy) {
      try { out = { ...compilePolicy(rules, graph, policy), policy }; }
      catch (e) { if (e instanceof PolicyError) throw Object.assign(e, { statusCode: 400 }); throw e; }
    }
    writeFileSync(join(d.dir, "rules/draft.json"), JSON.stringify(out, null, 2) + "\n");
    return { ok: true };
  });

  // Evaluate the ACTIVE version and append to the decision log.
  app.post<{ Params: { d: string }; Querystring: { trace?: string } }>("/domains/:d/decide", async (req) => {
    const d = domainOf(req.params.d);
    const input = validInput(d, req.body);
    const trace = req.query.trace === "1";
    const ev = await svc.evaluate(d, input, { version: d.activeVersion(), trace });
    if (opts.logDecisions ?? true) svc.logDecision(d, input, ev);
    return { ...ev.result, ruleVersion: ev.ruleVersion, decisionId: ev.decisionId, latencyMs: ev.latencyMs, ...(trace ? { trace: ev.trace } : {}) };
  });

  const adminName = (b: any, k: string, dflt: string) => (typeof b?.[k] === "string" && b[k].trim() ? b[k].trim() : dflt);

  app.get<{ Params: { d: string } }>("/domains/:d/rules/versions", async (req) => {
    const d = domainOf(req.params.d);
    return { active: d.activeVersion(), versions: listVersions(d) };
  });

  app.post<{ Params: { d: string } }>("/domains/:d/rules/publish", async (req) => {
    const d = domainOf(req.params.d);
    const { policy: _p, ...graph } = JSON.parse(d.readRules("draft"));
    const parsed = decisionModelSchema.safeParse(graph);
    if (!parsed.success) throw Object.assign(new Error("draft is not a valid decision model"), { statusCode: 400 });
    return publish(d, adminName(req.body, "author", "anonymous"), adminName(req.body, "note", ""));
  });

  app.post<{ Params: { d: string; v: string } }>("/domains/:d/rules/activate/:v", async (req) => {
    const d = domainOf(req.params.d);
    activate(d, req.params.v);
    return { active: d.activeVersion() };
  });

  // Copy a published version into the draft (to edit from an older version).
  app.post<{ Params: { d: string; v: string } }>("/domains/:d/rules/draft/from/:v", async (req) => {
    loadIntoDraft(domainOf(req.params.d), req.params.v);
    return { ok: true };
  });

  app.get<{ Params: { d: string; v: string } }>("/domains/:d/rules/versions/:v", async (req) => JSON.parse(domainOf(req.params.d).readRules(req.params.v)));

  app.get<{ Params: { d: string }; Querystring: { limit?: string } }>("/domains/:d/decisions", async (req) => {
    const file = join(domainOf(req.params.d).dir, "decisions.jsonl");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-Math.min(Number(req.query.limit) || 50, 500)).reverse().map((l) => JSON.parse(l));
  });

  app.post<{ Params: { d: string } }>("/domains/:d/replay", async (req) => replay(svc, domainOf(req.params.d), (req.body ?? {}) as any));

  app.post<{ Params: { d: string }; Querystring: { version?: string } }>("/domains/:d/scenarios/run", async (req) => {
    const d = domainOf(req.params.d);
    const version = req.query.version ?? d.activeVersion();
    const results = [];
    for (const s of d.scenarios) results.push(await runScenario(svc, d, s, version));
    return { version, passed: results.filter((r) => r.pass).length, total: results.length, results };
  });

  // Evaluate the DRAFT (or ?version=) with a full trace.
  app.post<{ Params: { d: string }; Querystring: { version?: string } }>("/domains/:d/simulate", async (req) => {
    const d = domainOf(req.params.d);
    // the editor's simulator posts { context }; direct callers post the input itself
    const body = req.body as { context?: unknown };
    const input = validInput(d, body && typeof body === "object" && "context" in body ? body.context : req.body);
    const ev = await svc.evaluate(d, input, { version: req.query.version ?? "draft", trace: true });
    return { result: ev.result, trace: ev.trace, performance: ev.performance, ruleVersion: ev.ruleVersion, decisionId: ev.decisionId, latencyMs: ev.latencyMs };
  });

  app.addHook("onClose", async () => {
    svc.dispose();
    for (const d of domains.values()) d.facts.stop?.();
  });

  return { app, svc, domains };
}
