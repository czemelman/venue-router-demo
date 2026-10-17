import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Domain } from "./domains.js";
import { NotFoundError } from "./domains.js";

export interface VersionMeta { version: string; author: string; note: string; publishedAt: string }

const metaPath = (d: Domain) => join(d.dir, "rules/versions.json");

export function listVersions(d: Domain): VersionMeta[] {
  return existsSync(metaPath(d)) ? JSON.parse(readFileSync(metaPath(d), "utf8")) : [];
}

/** Freeze the current draft as the next immutable vN. */
export function publish(d: Domain, author: string, note: string): VersionMeta {
  const versions = listVersions(d);
  const next = `v${Math.max(0, ...versions.map((v) => Number(v.version.slice(1)))) + 1}`;
  // COPYFILE_EXCL (1) refuses to overwrite: published versions are immutable
  copyFileSync(join(d.dir, "rules/draft.json"), join(d.dir, "rules/versions", `${next}.json`), 1);
  const meta = { version: next, author, note, publishedAt: new Date().toISOString() };
  writeFileSync(metaPath(d), JSON.stringify([...versions, meta], null, 2) + "\n");
  return meta;
}

export function activate(d: Domain, version: string) {
  d.readRules(version); // throws NotFoundError if absent
  if (version === "draft") throw new NotFoundError("cannot activate the draft; publish it first");
  writeFileSync(join(d.dir, "rules/active.txt"), version);
}

export function loadIntoDraft(d: Domain, version: string) {
  writeFileSync(join(d.dir, "rules/draft.json"), d.readRules(version));
}
