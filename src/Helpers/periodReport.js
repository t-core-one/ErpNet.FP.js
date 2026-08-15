/**
 * Shared helpers for the fiscal memory report over a custom period.
 *
 * Two request shapes reach the drivers and both must keep working:
 *
 *   { StartDate, EndDate, Detailed: true }              our original /mreport
 *   { StartDate, EndDate, Type: "short" | "detailed" }  upstream ErpNet.FP
 *
 * Type wins when both are present, matching upstream's model where Type is the
 * field and Detailed does not exist. Neither present means short, which is also
 * upstream's default.
 *
 * The date format is NOT shared across protocol families — ISL and ZFP take a
 * two-digit year, ICP a four-digit one and SIS a slash-separated one — so each
 * caller names the format it needs rather than inheriting a default that would
 * silently produce a wrong-century report.
 */

const pad2 = (n) => String(n).padStart(2, '0');

export function isDetailedPeriodReport(periodReport) {
  if (!periodReport) {
    return false;
  }
  const type = periodReport.Type ?? periodReport.type;
  if (type !== undefined && type !== null && String(type).length) {
    return String(type).toLowerCase() === 'detailed';
  }
  return Boolean(periodReport.Detailed ?? periodReport.detailed);
}

/** Parse whatever the caller sent (ISO string, epoch, Date) into a Date. */
function asDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid period report date: ${String(value)}`);
  }
  return d;
}

/** DDMMYY — ISL (Datecs, Daisy, Eltrade, Incotex) and ZFP (Tremol). */
export function formatDateDDMMYY(value) {
  const d = asDate(value);
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${String(d.getFullYear()).slice(-2)}`;
}

/** DDMMYYYY — ICP. A two-digit year here is silently accepted and misread. */
export function formatDateDDMMYYYY(value) {
  const d = asDate(value);
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}`;
}

/** DD/MM/YY — SIS JSON. */
export function formatDateSlashDDMMYY(value) {
  const d = asDate(value);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}
