import { CHANNEL, MAX_RESPONSE_CHARS, isCaptureUrl, normalizeAccountId } from './protocol';

/** MAIN world: observation only; no extension APIs, UI, credentials, or outgoing API calls. */
const marker = '__TWE_CHROME_OBSERVER_V1__';
if (!Object.prototype.hasOwnProperty.call(window, marker)) {
  Object.defineProperty(window, marker, { value: true });
  installObserver();
}

function installObserver() {
  const post = window.postMessage.bind(window);
  const accountId = () => normalizeAccountId(window.__META_DATA__?.userId);
  const ready = (phase?: string) =>
    post({ channel: CHANNEL, type: 'ready', phase, accountId: accountId() }, location.origin);
  const emit = (method: string, url: string, status: number, responseText: string) => {
    if (
      !isCaptureUrl(url) ||
      status < 200 ||
      status >= 300 ||
      responseText.length > MAX_RESPONSE_CHARS
    )
      return;
    if (method !== 'GET' && method !== 'POST') return;
    // Query parameters can contain search terms and cursors. Existing parsers need only the path.
    const parsed = new URL(url);
    post(
      {
        channel: CHANNEL,
        type: 'response',
        method,
        url: parsed.origin + parsed.pathname,
        status,
        responseText,
        accountId: accountId(),
      },
      location.origin,
    );
  };

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { channel?: string; type?: string; phase?: string } | null;
    if (data?.channel === CHANNEL && data.type === 'hello')
      ready(data.phase === 'dom-ready' ? 'dom-ready' : undefined);
  });

  const metadata = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const attached = new WeakSet<XMLHttpRequest>();
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method: string, input: string | URL) {
    try {
      metadata.set(this, {
        method: method.toUpperCase(),
        url: new URL(String(input), location.href).href,
      });
      if (!attached.has(this)) {
        attached.add(this);
        this.addEventListener('load', () => {
          try {
            const req = metadata.get(this);
            if (!req || !isCaptureUrl(req.url)) return;
            const text =
              this.responseType === 'json'
                ? JSON.stringify(this.response)
                : this.responseType === '' || this.responseType === 'text'
                  ? this.responseText
                  : '';
            if (text) emit(req.method, req.url, this.status, text);
          } catch {
            /* Observation must never break the site's XHR. */
          }
        });
      }
    } catch {
      /* Preserve the original API's validation and exception behavior. */
    }
    // eslint-disable-next-line prefer-rest-params
    Reflect.apply(originalOpen, this, arguments);
  };

  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    // Keep the exact original promise and never consume the page's response body.
    const result = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      if (isCaptureUrl(url)) {
        void result
          .then(async (response) => {
            if (!response.ok) return;
            const clone = response.clone();
            if (!clone.body) return;
            const reader = clone.body.getReader();
            const decoder = new TextDecoder();
            let text = '';
            let bytes = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > MAX_RESPONSE_CHARS) {
                  // Awaiting cancellation of a tee can wait for the page's own reader forever.
                  void reader.cancel().catch(() => {});
                  return;
                }
                text += decoder.decode(chunk.value, { stream: true });
              }
              text += decoder.decode();
              emit(method, url, response.status, text);
            } finally {
              reader.releaseLock();
            }
          })
          .catch(() => {
            /* Network/parse failures belong to the page, not the observer. */
          });
      }
    } catch {
      /* Never change the site's fetch outcome. */
    }
    return result;
  };
  ready();
}
