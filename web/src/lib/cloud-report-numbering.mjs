// Shared with manual tracker adds so they cannot reuse an evaluation number
// that has been reserved while its report is still being generated.
export const MAX_STORED_REPORT_NUMBER_SQL = `GREATEST(
 COALESCE((SELECT MAX((regexp_match(path,'^reports/([0-9]+)-'))[1]::int) FROM career_ops_documents WHERE path LIKE 'reports/%'),0),
 COALESCE((SELECT MAX(capture[1]::int) FROM career_ops_documents d CROSS JOIN LATERAL regexp_matches(d.content,'^\\|\\s*(\\d+)', 'gm') AS matches(capture) WHERE d.path='data/applications.md'),0)
)`;

const COUNTER_TABLE = "CREATE TABLE IF NOT EXISTS career_ops_evaluation_report_counter (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), last_number INTEGER NOT NULL CHECK(last_number >= 0))";

export async function ensureCareerOpsReportNumbering(sql) {
  await sql.query(COUNTER_TABLE, []);
  await sql.query(`INSERT INTO career_ops_evaluation_report_counter(singleton,last_number) SELECT TRUE,${MAX_STORED_REPORT_NUMBER_SQL} ON CONFLICT(singleton) DO UPDATE SET last_number=GREATEST(career_ops_evaluation_report_counter.last_number,EXCLUDED.last_number)`, []);
}

export async function reserveCareerOpsReportNumber(sql) {
  await ensureCareerOpsReportNumbering(sql);
  const row = (await sql.query(`INSERT INTO career_ops_evaluation_report_counter(singleton,last_number) SELECT TRUE,${MAX_STORED_REPORT_NUMBER_SQL}+1 ON CONFLICT(singleton) DO UPDATE SET last_number=GREATEST(career_ops_evaluation_report_counter.last_number+1,EXCLUDED.last_number) RETURNING last_number AS num`, []))[0];
  if (!row || !Number.isSafeInteger(Number(row.num)) || Number(row.num) < 1) throw new Error("REPORT_NUMBER_ALLOCATION_FAILED");
  return String(row.num);
}
