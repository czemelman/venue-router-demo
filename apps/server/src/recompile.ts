// Regenerate the expression nodes from each domain's visual rules:
//   tsx src/recompile.ts [--include-versions]
// Published versions are immutable, so they are only touched with the explicit flag (used when seeding).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DOMAINS_DIR } from "./domains.js";
import { compilePolicy } from "./compile.js";

const includeVersions = process.argv.includes("--include-versions");
for (const d of readdirSync(DEFAULT_DOMAINS_DIR, { withFileTypes: true })) {
  const meta = join(DEFAULT_DOMAINS_DIR, d.name, "domain.json");
  if (!d.isDirectory() || !existsSync(meta)) continue;
  const rules = JSON.parse(readFileSync(meta, "utf8")).rules;
  if (!rules) continue;
  const dir = join(DEFAULT_DOMAINS_DIR, d.name, "rules");
  const files = ["draft.json", ...(includeVersions ? readdirSync(join(dir, "versions")).map((f) => `versions/${f}`) : [])];
  for (const f of files) {
    const jdm = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (!jdm.policy) continue;
    writeFileSync(join(dir, f), JSON.stringify(compilePolicy(rules, jdm, jdm.policy), null, 2) + "\n");
    console.log("recompiled", d.name, f);
  }
}
