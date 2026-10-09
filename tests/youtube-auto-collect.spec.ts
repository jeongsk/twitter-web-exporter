import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserPath } from './browser';
import { extensionFixture } from './extension-fixture';

const API_KEY = 'synthetic-youtube-auto-collect-key';
const folder = 'raw/articles/twitter-web-exporter';
const lockup = (id: string) => `<yt-lockup-view-model><div>
  <a href="/watch?v=${id}&amp;list=LL&amp;index=1"><badge-shape>1:00</badge-shape></a>
  <h3 title="Video ${id}"><a href="/watch?v=${id}&amp;list=LL">Video ${id}</a></h3>
  <yt-content-metadata-view-model><div><span><a href="/@fixture">Fixture Channel</a></span></div></yt-content-metadata-view-model>
</div></yt-lockup-view-model>`;
const continuation = (token: string) => ({
  continuationItemViewModel: {
    trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
    continuationCommand: { innertubeCommand: { continuationCommand: { token } } },
  },
});
/** Pages after the first, by continuation token. The last one has no further continuation. */
const pages: Record<string, { ids: string[]; next?: string }> = {
  p1: { ids: ['YtAuto00003', 'YtAuto00004'], next: 'p2' },
  p2: { ids: ['YtAuto00005'] },
};
// Like a hidden tab: scrolling never loads more. Only ytd-app.resolveCommand fetches the next
// page (through window.fetch, as YouTube does) and appends its rows.
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ytd-app><ytd-browse page-subtype="playlist"><div id="contents">
${lockup('YtAuto00001')}${lockup('YtAuto00002')}
<yt-continuation-item-view-model></yt-continuation-item-view-model></div></ytd-browse></ytd-app>
<script nonce="fixture">
window.ytInitialData = { contents: [{ lockups: 2 }, ${JSON.stringify(continuation('p1'))}] };
document.querySelector('ytd-app').resolveCommand = (command) => {
  fetch('/youtubei/v1/browse?prettyPrint=false', {
    method: 'POST',
    body: JSON.stringify({ continuation: command.continuationCommand.token }),
  })
    .then((r) => r.json())
    .then((body) => document.querySelector('yt-continuation-item-view-model')
      .insertAdjacentHTML('beforebegin', body.rows));
  return true;
};
</script></body></html>`;
const call = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((m) => chrome.runtime.sendMessage(m), message);

test('periodic YouTube collection loads past the first page in a tab that never scroll-loads', async () => {
  test.setTimeout(180000);
  const files = new Map<string, string>();
  const tokens: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          service: 'Obsidian Local REST API',
          authenticated: true,
          versions: { self: 'test' },
        }),
      );
      return;
    }
    const path = decodeURIComponent(req.url ?? '');
    if (req.method === 'GET') {
      if (!files.has(path)) res.writeHead(404).end();
      else res.end(files.get(path));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    files.set(path, body);
    res.writeHead(204).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const apiEndpoint = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'twe-youtube-auto-'));
  const extension = await extensionFixture(profile);
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'ko-KR',
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--host-resolver-rules=MAP x.com 127.0.0.1:9, MAP www.youtube.com 127.0.0.1:9',
    ],
  });
  context.setDefaultTimeout(10000);
  // The first navigation of an extension-opened tab bypasses interception; reload it.
  context.on('page', (page) => {
    void page
      .waitForURL(/^chrome-error:/, { timeout: 15000 })
      .then(() => page.reload())
      .catch(() => {});
  });
  try {
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === apiEndpoint || url.protocol === 'chrome-extension:')
        return route.continue();
      if (url.origin === 'https://www.youtube.com' && url.pathname === '/playlist')
        return route.fulfill({
          contentType: 'text/html',
          body: html,
          headers: {
            'Content-Security-Policy':
              "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; style-src 'unsafe-inline'",
          },
        });
      if (url.origin === 'https://www.youtube.com' && url.pathname === '/youtubei/v1/browse') {
        const token = String(JSON.parse(request.postData() ?? '{}').continuation);
        tokens.push(token);
        const page = pages[token] ?? { ids: [] };
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            rows: page.ids.map(lockup).join(''),
            onResponseReceivedActions: [
              {
                appendContinuationItemsAction: {
                  continuationItems: [
                    ...page.ids.map((id) => ({ lockupViewModel: { contentId: id } })),
                    ...(page.next ? [continuation(page.next)] : []),
                  ],
                },
              },
            ],
          }),
        });
      }
      if (url.origin === 'https://x.com' && url.pathname === '/i/bookmarks')
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' });
      return route.abort();
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/backup.html`);
    await settings.locator('#endpoint').fill(apiEndpoint);
    await settings.locator('#api-key').fill(API_KEY);
    await settings.locator('#privacy').check();
    await settings.getByRole('button', { name: '연결 확인 · 저장', exact: true }).click();
    await expect(settings.locator('#connection-state')).toContainText('연결 설정 저장됨');
    await settings.locator('#enabled').check();
    await settings.locator('#youtube-enabled').check();
    await settings.getByRole('button', { name: '백업 설정 적용', exact: true }).click();
    await expect(settings.locator('#counts')).toContainText('자동 백업 켜짐');

    await settings.getByRole('button', { name: '지금 수집', exact: true }).click();
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).autoCollect.lastRun, {
        timeout: 120000,
      })
      .toMatchObject({ youtube: { fresh: 5, reason: 'exhausted' } });
    // Each continuation was requested once, in order, and the list ended after the last one.
    expect(tokens).toEqual(['p1', 'p2']);
    for (const n of [1, 2, 3, 4, 5])
      await expect
        .poll(() => files.has(`/vault/${folder}/youtube/youtube-YtAuto0000${n}.md`))
        .toBe(true);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(profile, { recursive: true, force: true });
  }
});
