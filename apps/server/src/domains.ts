import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DomainMeta, FactsProvider, Scenario } from "@venue/shared";

export interface Domain {
  name: string;
  dir: string;
  meta: DomainMeta;
  scenarios: Scenario[];
  facts: FactsProvider;
  /** Read the JDM for "draft" or a published version like "v1". Returns the raw JSON text. */
  readRules(which: string): string;
  activeVersion(): string;
}

export const DEFAULT_DOMAINS_DIR = resolve(import.meta.dirname, "../../../domains");

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** Discover domains by folder: every subdirectory with a domain.json is a domain. */
export async function loadDomains(dir = DEFAULT_DOMAINS_DIR): Promise<Map<string, Domain>> {
  const domains = new Map<string, Domain>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const root = join(dir, entry.name);
    if (!entry.isDirectory() || !existsSync(join(root, "domain.json"))) continue;

    const factsPath = join(root, "facts.ts");
    const facts: FactsProvider = existsSync(factsPath)
      ? (await import(pathToFileURL(factsPath).href)).default
      : { get: () => ({}), snapshot: () => ({}) };
    const scenariosPath = join(root, "scenarios.json");

    domains.set(entry.name, {
      name: entry.name,
      dir: root,
      meta: readJson<DomainMeta>(join(root, "domain.json")),
      scenarios: existsSync(scenariosPath) ? readJson<Scenario[]>(scenariosPath) : [],
      facts,
      readRules(which) {
        const file = which === "draft" ? join(root, "rules/draft.json") : join(root, "rules/versions", `${which}.json`);
        if (!/^(draft|v\d+)$/.test(which) || !existsSync(file)) throw new NotFoundError(`rules version not found: ${which}`);
        return readFileSync(file, "utf8");
      },
      activeVersion() {
        return readFileSync(join(root, "rules/active.txt"), "utf8").trim();
      },
    });
  }
  return domains;
}

export class NotFoundError extends Error {}
