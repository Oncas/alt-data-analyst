// Conservative company-name normalization for cross-source joins (DECISIONS.md
// D6: exact/normalized matches only). Strips punctuation and legal suffixes but
// deliberately keeps distinguishing words like HOLDINGS/GROUP to avoid false joins.
const LEGAL_SUFFIXES =
  /\b(INC|INCORPORATED|LLC|CORP|CORPORATION|LTD|LIMITED|COMPANY|CO|PLC|LP|LLP)\b/g;

export function normalizeCompanyName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,'"&/\\()-]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}
