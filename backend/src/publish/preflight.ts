import { query } from '../db.js';
import { MAPPING, TRANSLATION_MAPPING } from './mapping.js';

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

export interface PreflightReport {
  ok: boolean;
  missingTables: string[];
  missingColumns: string[];
}

/**
 * Introspect the live database and confirm every table/column the publisher
 * writes actually exists. This is the honest alternative to discovering the
 * mismatch halfway through an insert loop.
 */
export async function preflight(): Promise<PreflightReport> {
  const rows = await query<ColumnRow>(
    `select table_schema, table_name, column_name
       from information_schema.columns
      where table_schema not in ('pg_catalog','information_schema')`,
  );

  const present = new Set(
    rows.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`),
  );
  const tables = new Set(rows.map((r) => `${r.table_schema}.${r.table_name}`));

  const missingTables: string[] = [];
  const missingColumns: string[] = [];

  // The translation overlay is checked alongside the publisher's own tables:
  // the API reads it on every request, so a missing migration 0015 is worth
  // the same loud answer as a missing recipes column.
  const groups = [...Object.values(MAPPING), ...Object.values(TRANSLATION_MAPPING)];

  for (const group of groups) {
    if (!tables.has(group.table)) {
      missingTables.push(group.table);
      continue;
    }
    for (const column of Object.values(group.columns)) {
      if (!present.has(`${group.table}.${column}`)) {
        missingColumns.push(`${group.table}.${column}`);
      }
    }
  }

  return {
    ok: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
  };
}

export function printPreflight(report: PreflightReport): void {
  if (report.ok) {
    console.log('Preflight OK - every target table and column the publisher needs exists.');
    return;
  }
  console.log('Preflight found problems. Fix these before publishing:\n');
  if (report.missingTables.length > 0) {
    console.log('  Missing tables:');
    for (const table of report.missingTables) console.log(`    - ${table}`);
    console.log('\n  Either create them, or correct the names in src/publish/mapping.ts.');
    console.log('  The recipe_*_translations tables come from migration 0015.');
  }
  if (report.missingColumns.length > 0) {
    console.log('\n  Missing columns:');
    for (const column of report.missingColumns) console.log(`    - ${column}`);
    console.log('\n  Migration 0003 adds the provenance columns; the rest are app columns');
    console.log('  that must already exist, or whose names differ in mapping.ts.');
  }
}
