/** Truncates to at most `max` characters, marking the cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Single-line excerpt: whitespace runs collapsed, then truncated. */
export function excerpt(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}
