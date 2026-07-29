/**
 * Single source of colour for the dashboard. Previously the palette was spread
 * across four functions plus a dozen inline style attributes, so a change meant
 * hunting every copy.
 */
export const THEME = {
  ink: "#0B1418",
  raised: "#122126",
  raisedHi: "#172A30",
  edge: "#1E3238",
  text: "#E6EDEF",
  muted: "#7C939A",
  faint: "#4A5F66",
  accent: "#4FD1C5",
  fresh: "#34D399",
  warn: "#F59E0B",
  danger: "#F87171",
} as const;

/** Hue per source. Doubles as the row rail colour. */
export const SOURCE_COLORS: Record<string, string> = {
  linkedin: "#3B9EDB",
  greenhouse: "#3AAB6D",
  lever: "#8B7BFF",
  ashby: "#E0913A",
  instahyre: "#E0567A",
  remotive: "#31A8C4",
  remoteok: "#8FB63C",
};

export const VERDICT_COLORS: Record<string, string> = {
  strong_apply: THEME.fresh,
  apply: "#2BAE7E",
  maybe: THEME.warn,
  skip: THEME.danger,
};

export const STATUS_COLORS: Record<string, string> = {
  applied: THEME.fresh,
  skipped: THEME.warn,
  failed: THEME.danger,
  pending: THEME.faint,
};

export function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? THEME.faint;
}
