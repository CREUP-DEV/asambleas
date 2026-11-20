/**
 * The value of the live stream's `channels` parameter (useAssemblyLive):
 * the pushes the page has a handler for, comma-separated, possibly none.
 * The server sends the others to nobody that left them out
 * (server/utils/live/sse.ts, livePushChannels): only the projection draws
 * the Mesa's pointer and the count of a secret vote, and the live view and
 * the projection follow its scroll.
 */
export function liveChannels(options: {
  onScroll?: unknown;
  onPointer?: unknown;
  onTally?: unknown;
}): string {
  const names: string[] = [];
  if (options.onScroll) names.push("scroll");
  if (options.onPointer) names.push("pointer");
  if (options.onTally) names.push("tally");
  return names.join(",");
}
