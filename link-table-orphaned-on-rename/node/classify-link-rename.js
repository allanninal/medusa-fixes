/**
 * Detect Medusa link table rows orphaned by a module or model rename.
 *
 * Medusa v2's Module Links system derives a link table's name deterministically
 * from the linked modules' and data models' table names, for example
 * product_product_blog_post. When a developer renames a custom module (such as
 * blog to article) or a linked data model, defineLink produces a new,
 * differently named link definition. Medusa has no way to know this is a
 * rename rather than delete the old link and add a new one. Running
 * `npx medusa db:sync-links`, or `db:migrate`, which calls it internally, then
 * prompts to drop the old link table and create an empty new one, silently
 * orphaning every existing row unless the developer passes a third defineLink
 * config argument with database: { table: "<old_table_name>" } to pin the
 * table name across the rename.
 *
 * This script reads the link tables Medusa currently generates (captured from
 * `npx medusa db:migrate --dry-run` into defined_links.json) and a table and
 * row-count report a companion step exposed over the Admin API, classifies
 * every leftover table with a pure function, and reports every table that
 * looks orphaned along with its likely rename source. It only reports by
 * default. The ALTER TABLE RENAME TO bridge and the config patch are
 * documented in the guide, reviewed by a human, and only ever run with an
 * explicit --apply flag.
 *
 * Guide: https://www.allanninal.dev/medusa/link-table-orphaned-on-rename/
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

function sharedSegments(a, b) {
  const setA = new Set(a.split("_"));
  const setB = new Set(b.split("_"));
  return [...setA].filter((seg) => setB.has(seg));
}

/**
 * Pure decision logic, no I/O.
 *
 * For each table in existingDbTables not present in definedLinkTables (a link
 * table Medusa no longer generates from current defineLink calls), mark it
 * orphaned if it has rows. Use shared name segments split on "_" to guess
 * which current link it was likely renamed from, otherwise null.
 */
export function classifyLinkRename(input) {
  const { definedLinkTables, existingDbTables, rowCounts } = input;
  const results = [];
  for (const table of existingDbTables) {
    if (definedLinkTables.includes(table)) continue;
    if (!(rowCounts[table] > 0)) continue;
    let suspected = null;
    let bestOverlap = 0;
    for (const candidate of definedLinkTables) {
      const overlap = sharedSegments(table, candidate).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        suspected = candidate;
      }
    }
    results.push({ orphanedTable: table, rowCount: rowCounts[table], suspectedRenameOf: suspected });
  }
  return results;
}

async function login() {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function loadDefinedLinkTables(path = "defined_links.json") {
  // Produced from `npx medusa db:migrate --dry-run` output, run inside the
  // Medusa project. Expected shape: ["product_product_article_post", ...]
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadDbTableReport(token) {
  // Exposed by a companion admin route or a medusa exec script that queried
  // information_schema.tables plus a count(*) per candidate table.
  // Expected shape: { "table_name": rowCount, ... }
  const res = await fetch(`${BASE}/admin/link-table-report`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.row_counts;
}

export async function run() {
  const token = await login();
  const definedLinkTables = await loadDefinedLinkTables();
  const rowCounts = await loadDbTableReport(token);
  const existingDbTables = Object.keys(rowCounts);

  const orphans = classifyLinkRename({ definedLinkTables, existingDbTables, rowCounts });
  for (const orphan of orphans) {
    console.warn(
      `Table ${orphan.orphanedTable} has ${orphan.rowCount} row(s), no longer defined. ` +
      `Suspected rename of: ${orphan.suspectedRenameOf || "unknown"}. ` +
      `${DRY_RUN ? "would report" : "confirmed, patch defineLink or restore from backup"}`
    );
  }
  console.log(`Done. ${orphans.length} orphaned link table(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
