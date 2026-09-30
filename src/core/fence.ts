/**
 * Neutralizes Forge's prompt-envelope tags inside untrusted text so that it
 * can neither close the block it is placed in nor open a new Forge block.
 * Used for task text, repository content, diffs — anything that is data.
 */
export function fenceData(text: string): string {
  return text.replace(/<(\/?)(forge-[a-z-]+)/gi, '<$1​$2');
}
