// Released schema snapshots live in schemas/<major>.<minor>/ and never change once committed.
// `node scripts/export-schemas.js --snapshot` writes the snapshot for the current PROTOCOL_VERSION.
// `node scripts/export-schemas.js <out>` builds the Pages site from the committed snapshots:
// schema/<major>.<minor>/ for every snapshot and schema/v<major>/ from the newest minor of each major.
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishedSchemas, PROTOCOL_VERSION, SCHEMA_BASE } from "../dist/schema/publish.js";

const snapshots = "schemas";
if (process.argv[2] === "--snapshot") {
  const dir = join(snapshots, PROTOCOL_VERSION);
  mkdirSync(dir, { recursive: true });
  for (const [name, schema] of Object.entries(publishedSchemas())) writeFileSync(join(dir, `${name}.json`), JSON.stringify(schema, null, 2) + "\n");
  console.log(`wrote snapshot ${dir}`);
  process.exit(0);
}

const out = process.argv[2] ?? "site";
if (!existsSync(join(snapshots, PROTOCOL_VERSION))) throw new Error(`no committed snapshot for protocol ${PROTOCOL_VERSION}; run npm run schemas -- --snapshot`);
const versions = readdirSync(snapshots).filter(v => /^\d+\.\d+$/.test(v)).map(v => v.split(".").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const newest = new Map();
for (const [major, minor] of versions) {
  cpSync(join(snapshots, `${major}.${minor}`), join(out, "schema", `${major}.${minor}`), { recursive: true });
  newest.set(major, `${major}.${minor}`);
}
for (const [major, version] of newest) cpSync(join(snapshots, version), join(out, "schema", `v${major}`), { recursive: true });
const names = Object.keys(publishedSchemas());
const links = names.map(name => `<li><a href="schema/v1/${name}.json">${SCHEMA_BASE}v1/${name}.json</a></li>`).join("\n");
const snapshotLinks = versions.map(([major, minor]) => `<a href="schema/${major}.${minor}/">${major}.${minor}</a>`).join(", ");
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>crosstalk schemas</title>
<h1>crosstalk protocol schemas</h1>
<p>Protocol: <a href="https://github.com/flix-wg/crosstalk/blob/main/docs/protocol.md">docs/protocol.md</a>. Snapshots: ${snapshotLinks}.</p>
<ul>
${links}
</ul>
`);
writeFileSync(join(out, ".nojekyll"), "");
console.log(`wrote ${versions.length} snapshot(s) to ${out}`);
