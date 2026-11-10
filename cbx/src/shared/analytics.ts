/** Analytics snapshots and exports share one definition of scope and period. */
export type AnalyticsVersion = { id: string; projectId: string; project: string; sequence: number; message: string; at: string; files: number; source: number; stored: number };
export type AnalyticsRepository = { id: string; name: string; slug: string; owner: string; description: string; visibility: string; saves: number; previousSaves: number; downloads: number; source: number; stored: number };
export type AnalyticsSnapshot = {
  scope: "account" | "repository";
  period: { days: number; timeZone: string; start: string; end: string; previousStart: string; startDate: string; endDate: string };
  repositories: AnalyticsRepository[];
  daily: { date: string; saves: number }[];
  versions: AnalyticsVersion[];
  releases: { name: string; sequence: number; downloads: number }[];
  /** A project's Pages plays (usage.ts): all time and over the period's UTC days. Absent for an account, or when uncounted. */
  plays?: { total: number; period: number } | null;
};
export const smallerPercent = (source: number, stored: number) => source > 0 ? Math.max(0, Math.round((1 - stored / source) * 100)) : 0;
export function analyticsTotals(data: AnalyticsSnapshot) {
  return data.repositories.reduce((sum, row) => ({ saves: sum.saves + row.saves, previousSaves: sum.previousSaves + row.previousSaves, downloads: sum.downloads + row.downloads, source: sum.source + row.source, stored: sum.stored + row.stored }), { saves: 0, previousSaves: 0, downloads: 0, source: 0, stored: 0 });
}
/** Quote every cell, preserve Unicode/newlines, and neutralise spreadsheet formulas in user text. */
export function analyticsCsv(data: AnalyticsSnapshot, versions: readonly AnalyticsVersion[]) {
  const totals = analyticsTotals(data);
  if (versions.length !== totals.saves) throw new Error("Saved history changed during export. Refresh Analytics and export again.");
  if (new Set(versions.map(version => version.id)).size !== versions.length) throw new Error("Export returned repeated saved versions. Refresh Analytics and export again.");
  const columns = ["record_type", "scope", "period_start", "period_end", "time_zone", "repository", "repository_id", "date", "metric", "value", "version", "version_id", "message", "files", "source_bytes", "stored_bytes", "smaller_percent", "saves_in_period", "downloads_all_time"];
  type Cell = string | number;
  const rows: Cell[][] = [columns];
  const add = (type: string, cells: Partial<Record<typeof columns[number], Cell>>) => rows.push(columns.map(key => ({ record_type: type, scope: data.scope, period_start: data.period.start, period_end: data.period.end, time_zone: data.period.timeZone, ...cells })[key] ?? ""));
  for (const [metric, value] of Object.entries(totals)) add("summary", { metric, value });
  add("summary", { metric: "smaller_percent_latest_snapshots", value: smallerPercent(totals.source, totals.stored) });
  for (const day of data.daily) add("daily", { date: day.date, metric: "saved_versions", value: day.saves });
  for (const repo of data.repositories) add("repository", { repository: repo.name, repository_id: repo.id, source_bytes: repo.source, stored_bytes: repo.stored, smaller_percent: smallerPercent(repo.source, repo.stored), saves_in_period: repo.saves, downloads_all_time: repo.downloads });
  for (const version of versions) add("version", { repository: version.project, repository_id: version.projectId, date: version.at, version: version.sequence, version_id: version.id, message: version.message, files: version.files, source_bytes: version.source, stored_bytes: version.stored, smaller_percent: smallerPercent(version.source, version.stored) });
  for (const release of data.releases) add("release", { repository: data.repositories[0]?.name ?? "", version: release.sequence, message: release.name, downloads_all_time: release.downloads });
  return "\uFEFF" + rows.map(row => row.map(cell => {
    let value = String(cell);
    if (typeof cell === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(value)) value = "'" + value;
    return '"' + value.replace(/"/g, '""') + '"';
  }).join(",")).join("\r\n") + "\r\n";
}
