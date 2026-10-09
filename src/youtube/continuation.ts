/** postMessage channel between youtube-content (ISOLATED) and youtube-page (MAIN). */
export const YOUTUBE_CHANNEL = '__TWE_YOUTUBE_V1__';

/**
 * The last "load more" command in a browse response or page data: the lockup layout's
 * continuationItemViewModel, or the classic continuationItemRenderer. null when the list ends.
 */
export function lastContinuation(data: unknown): object | null {
  let found: object | null = null;
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    const record = node as Record<string, unknown>;
    const model = record.continuationItemViewModel as
      { continuationCommand?: { innertubeCommand?: unknown } } | undefined;
    const renderer = record.continuationItemRenderer as
      { continuationEndpoint?: unknown } | undefined;
    const command = model?.continuationCommand?.innertubeCommand ?? renderer?.continuationEndpoint;
    if (command && typeof command === 'object') found = command;
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  walk(data, 0);
  return found;
}
