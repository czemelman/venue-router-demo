/**
 * In-browser stand-in for the Fastify server, used by the static GitHub Pages build (VITE_DEMO=1).
 *
 * It answers the same routes as apps/server/src/app.ts and runs decisions on the WASI build of the same ZEN engine
 * version the server uses. The domains (rules, scenarios, facts) are bundled at build time. Edits, published versions
 * and the active version are kept in localStorage, so a visitor can change rules, publish and roll back for real.
 */
import { ZenEngine, type ZenDecision } from "@gorules/zen-engine";
import { decisionModelSchema } from "@gorules/jdm-editor/dist/schema";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { bucketOf, compilePolicy, PolicyError, replayCore, runScenarioCore, sha256Hex, type DomainMeta, type FactsProvider, type Scenario } from "@venue/shared";
import { ApiError } from "../api";

const glob = <T,>(g: Record<string, T>) => Object.fromEntries(Object.entries(g).map(([p, v]) => [p.match(/domains\/([^/]+)\//)![1], v] as const));
const seedMeta = glob(import.meta.glob<DomainMeta>("../../../../domains/*/domain.json", { eager: true, import: "default" }));
const seedScenarios = glob(import.meta.glob<Scenario[]>("../../../../domains/*/scenarios.json", { eager: true, import: "default" }));
const seedDraft = glob(import.meta.glob<any>("../../../../domains/*/rules/draft.json", { eager: true, import: "default" }));
const seedVersionList = glob(import.meta.glob<VersionMeta[]>("../../../../domains/*/rules/versions.json", { eager: true, import: "default" }));
const seedActive = glob(import.meta.glob<string>("../../../../domains/*/rules/active.txt", { eager: true, query: "?raw", import: "default" }));
const seedFacts = glob(import.meta.glob<{ default: FactsProvider }>("../../../../domains/*/facts.ts", { eager: true }));
const seedVersions: Record<string, Record<string, any>> = {};
for (const [path, json] of Object.entries(import.meta.glob<any>("../../../../domains/*/rules/versions/*.json", { eager: true, import: "default" }))) {
  const [, d, v] = path.match(/domains\/([^/]+)\/rules\/versions\/(v\d+)\.json$/)!;
  (seedVersions[d] ??= {})[v] = json;
}

interface VersionMeta { version: string; author: string; note: string; publishedAt: string }
interface Stored { draft: any; versions: Record<string, any>; versionList: VersionMeta[]; active: string }
interface DomainState extends Stored { name: string; meta: DomainMeta; scenarios: Scenario[]; facts: FactsProvider; log: any[] }

const STORE = "venue-router-demo/v1/";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const fail = (status: number, message: string, details?: unknown): never => {
  throw new ApiError(message + (details ? " " + JSON.stringify(details).slice(0, 300) : ""), { error: message, details, status });
};

const states = new Map<string, DomainState>();
const validators = new Map<string, ReturnType<Ajv["compile"]>>();
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

function load(name: string): DomainState {
  let s = states.get(name);
  if (s) return s;
  if (!seedMeta[name]) fail(404, `unknown domain: ${name}`);
  let stored: Stored | undefined;
  try { stored = JSON.parse(localStorage.getItem(STORE + name) ?? "null") ?? undefined; } catch { /* private mode or corrupt: start from the seed */ }
  s = {
    name, meta: seedMeta[name], scenarios: seedScenarios[name] ?? [], facts: seedFacts[name].default, log: [],
    draft: stored?.draft ?? clone(seedDraft[name]),
    versions: stored?.versions ?? clone(seedVersions[name] ?? {}),
    versionList: stored?.versionList ?? clone(seedVersionList[name] ?? []),
    active: stored?.active ?? seedActive[name].trim(),
  };
  states.set(name, s);
  validators.set(name, ajv.compile(s.meta.inputSchema as object));
  return s;
}
function save(s: DomainState) {
  try { localStorage.setItem(STORE + s.name, JSON.stringify({ draft: s.draft, versions: s.versions, versionList: s.versionList, active: s.active } satisfies Stored)); } catch { /* storage full or blocked: edits last until reload */ }
}
export function resetDemo() {
  try { Object.keys(localStorage).filter((k) => k.startsWith(STORE)).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
}

const rulesOf = (s: DomainState, which: string) => {
  const g = which === "draft" ? s.draft : s.versions[which];
  return g ?? fail(404, `rules version not found: ${which}`);
};

// ---------------------------------------------------------------- engine
const engine = new ZenEngine();
const decisions = new Map<string, ZenDecision>();
const decisionFor = (s: DomainState, version: string) => {
  const raw = JSON.stringify(rulesOf(s, version));
  const key = version === "draft" ? `${s.name}@draft:${sha256Hex(raw).slice(0, 16)}` : `${s.name}@${version}`;
  let d = decisions.get(key);
  if (!d) {
    d = engine.createDecision(new TextEncoder().encode(raw) as any);
    if (version === "draft") for (const k of decisions.keys()) if (k.startsWith(`${s.name}@draft:`)) decisions.delete(k);
    decisions.set(key, d);
  }
  return d;
};
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

async function evaluate(s: DomainState, input: unknown, version: string, trace = false) {
  const started = performance.now();
  const facts = await s.facts.get(input);
  const context = { ...(input as object), ...facts, meta: { now: new Date().toISOString(), domain: s.name, version, bucket: bucketOf(s.meta, input) } };
  const out = await decisionFor(s, version).evaluate(context, trace ? { trace: true } : undefined);
  return { result: out.result as Record<string, unknown>, trace: out.trace, performance: out.performance, ruleVersion: version, decisionId: uuid(), latencyMs: Math.round((performance.now() - started) * 1000) / 1000 };
}
const validInput = (s: DomainState, input: unknown) => {
  const v = validators.get(s.name)!;
  return v(input) ? input : fail(400, "invalid input", v.errors);
};
const text = (b: any, k: string, dflt: string) => (typeof b?.[k] === "string" && b[k].trim() ? b[k].trim() : dflt);

// ---------------------------------------------------------------- router
export async function handle(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const url = new URL(path, "http://demo");
  const method = init?.method ?? (init?.body !== undefined ? "POST" : "GET");
  const body = init?.body;
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "domains") fail(404, "not found");
  if (seg.length === 1) return Object.keys(seedMeta).map((n) => ({ name: n, description: seedMeta[n].description, activeVersion: load(n).active }));

  const s = load(seg[1]);
  const rest = "/" + seg.slice(2).join("/");
  const q = url.searchParams;
  const is = (m: string, p: string | RegExp) => method === m && (typeof p === "string" ? rest === p : p.test(rest));

  if (is("GET", "/")) return { ...s.meta, scenarios: s.scenarios, activeVersion: s.active };
  if (is("GET", "/facts")) return s.facts.snapshot();
  if (is("POST", "/facts/override")) {
    if (!s.facts.override) fail(400, "domain facts are not overridable");
    try { return s.facts.override!(body); } catch (e) { return fail(400, (e as Error).message); }
  }

  if (is("GET", "/rules/draft")) return clone(s.draft);
  if (is("PUT", "/rules/draft")) {
    const { policy: sent, ...graph } = (body ?? {}) as any;
    const parsed = decisionModelSchema.safeParse(graph);
    if (!parsed.success) fail(400, "invalid decision model", parsed.error.issues.slice(0, 10));
    const policy = sent ?? s.draft.policy;
    const rules = (s.meta as any).rules;
    let out: any = graph;
    if (rules && policy) {
      try { out = { ...compilePolicy(rules, graph, policy), policy }; }
      catch (e) { if (e instanceof PolicyError) fail(400, e.message); throw e; }
    }
    s.draft = clone(out);
    save(s);
    return { ok: true };
  }

  if (is("GET", "/rules/versions")) return { active: s.active, versions: s.versionList };
  if (is("POST", "/rules/publish")) {
    const { policy: _policy, ...graph } = s.draft;
    if (!decisionModelSchema.safeParse(graph).success) fail(400, "draft is not a valid decision model");
    const next = `v${Math.max(0, ...s.versionList.map((v) => Number(v.version.slice(1)))) + 1}`;
    const meta: VersionMeta = { version: next, author: text(body, "author", "anonymous"), note: text(body, "note", ""), publishedAt: new Date().toISOString() };
    s.versions[next] = clone(s.draft);
    s.versionList = [...s.versionList, meta];
    save(s);
    return meta;
  }
  let m = rest.match(/^\/rules\/activate\/([^/]+)$/);
  if (method === "POST" && m) {
    if (m[1] === "draft") fail(404, "cannot activate the draft; publish it first");
    rulesOf(s, m[1]);
    s.active = m[1];
    save(s);
    return { active: s.active };
  }
  m = rest.match(/^\/rules\/draft\/from\/([^/]+)$/);
  if (method === "POST" && m) { s.draft = clone(rulesOf(s, m[1])); save(s); return { ok: true }; }
  m = rest.match(/^\/rules\/versions\/([^/]+)$/);
  if (method === "GET" && m) return clone(rulesOf(s, m[1]));

  if (is("POST", "/decide")) {
    const input = validInput(s, body);
    const trace = q.get("trace") === "1";
    const ev = await evaluate(s, input, s.active, trace);
    s.log.push({ decisionId: ev.decisionId, at: new Date().toISOString(), version: ev.ruleVersion, input, output: ev.result, latencyMs: ev.latencyMs });
    if (s.log.length > 500) s.log.shift();
    return { ...ev.result, ruleVersion: ev.ruleVersion, decisionId: ev.decisionId, latencyMs: ev.latencyMs, ...(trace ? { trace: ev.trace } : {}) };
  }
  if (is("POST", "/simulate")) {
    // the editor's simulator posts { context }; direct callers post the input itself
    const b = body as { context?: unknown };
    const input = validInput(s, b && typeof b === "object" && "context" in b ? b.context : body);
    const ev = await evaluate(s, input, q.get("version") ?? "draft", true);
    return { result: ev.result, trace: ev.trace, performance: ev.performance, ruleVersion: ev.ruleVersion, decisionId: ev.decisionId, latencyMs: ev.latencyMs };
  }
  if (is("GET", "/decisions")) return s.log.slice(-Math.min(Number(q.get("limit")) || 50, 500)).reverse();

  if (is("POST", "/replay")) {
    try {
      return await replayCore({
        evaluate: async (input, version) => (await evaluate(s, input, version)).result,
        facts: s.facts, scenarios: s.scenarios, activeVersion: s.active, loggedInputs: (n) => s.log.slice(-n).map((l) => l.input),
        maxInputs: 1000, // the engine runs in this tab; 1000 inputs against two versions takes a couple of seconds
      }, (body ?? {}) as any);
    } catch (e: any) { return fail(e.statusCode ?? 500, e.message); }
  }
  if (is("POST", "/scenarios/run")) {
    const version = q.get("version") ?? s.active;
    const results = [];
    for (const sc of s.scenarios) results.push(await runScenarioCore(async (i, v) => (await evaluate(s, i, v)).result, s.facts, sc, version));
    return { version, passed: results.filter((r) => r.pass).length, total: results.length, results };
  }
  return fail(404, `no route: ${method} ${url.pathname}`);
}
