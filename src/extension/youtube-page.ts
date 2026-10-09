import { YOUTUBE_CHANNEL, lastContinuation } from '@/youtube/continuation';
import { isYoutubeLikes } from '@/youtube/model';

/**
 * MAIN world, Liked videos only. Hidden tabs never render the "load more" item, so YouTube never
 * asks for the next page. On request from youtube-content, hand YouTube its own continuation
 * command; YouTube makes the request and renders the rows. No extension APIs, no own API calls.
 */
const marker = '__TWE_YOUTUBE_PAGE_V1__';
if (!Object.prototype.hasOwnProperty.call(window, marker)) {
  Object.defineProperty(window, marker, { value: true });
  install();
}

function install() {
  /** undefined: not loaded past the first page yet, so read the page data. null: list ended. */
  let next: object | null | undefined;
  /** The command in flight; asked again if no response arrives within PENDING_LIMIT. */
  let issued: object | null = null;
  let pendingSince = 0;
  const PENDING_LIMIT = 20000;

  // Appended pages do not update the page data; the next command is only in each response.
  const original = window.fetch;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const result = original.apply(this, args);
    const input = args[0];
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : '';
    if (/\/youtubei\/v1\/browse(?:\?|$)/.test(url) && isYoutubeLikes(location.href))
      void result
        .then((response) => (response.ok ? response.clone().json() : null))
        .then((body: { onResponseReceivedActions?: unknown } | null) => {
          if (!body?.onResponseReceivedActions) return;
          next = lastContinuation(body.onResponseReceivedActions);
          issued = null;
          pendingSince = 0;
        })
        .catch(() => {});
    return result;
  } as typeof fetch;

  const reset = () => {
    next = undefined;
    issued = null;
    pendingSince = 0;
  };
  addEventListener('yt-navigate-finish', reset);
  addEventListener('popstate', reset);

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as { channel?: unknown; type?: unknown } | null;
    if (event.source !== window || data?.channel !== YOUTUBE_CHANNEL || data.type !== 'more')
      return;
    if (!isYoutubeLikes(location.href)) return;
    if (pendingSince && Date.now() - pendingSince < PENDING_LIMIT) return;
    try {
      const browse = document.querySelector('ytd-browse:not([hidden])') as
        (Element & { data?: unknown }) | null;
      const command = issued
        ? issued
        : next === undefined
          ? lastContinuation(browse?.data ?? (window as { ytInitialData?: unknown }).ytInitialData)
          : next;
      const app = document.querySelector('ytd-app') as
        | (Element & { resolveCommand?: (command: object, element?: Element | null) => unknown })
        | null;
      // Private API; when it is gone the regular scroll is all that remains.
      if (!command || typeof app?.resolveCommand !== 'function') return;
      // A command is used once. The response, if it arrives, brings the next one.
      issued = command;
      next = null;
      pendingSince = Date.now();
      app.resolveCommand(
        command,
        document.querySelector(
          'ytd-browse:not([hidden]) yt-continuation-item-view-model, ytd-browse:not([hidden]) ytd-continuation-item-renderer',
        ),
      );
    } catch {
      pendingSince = 0;
    }
  });
}
