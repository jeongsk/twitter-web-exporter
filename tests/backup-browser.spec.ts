import { detailResponse, threadTweet } from './thread-fixture';
import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extensionFixture } from './extension-fixture';
import { tmpdir } from 'node:os';
import { browserPath } from './browser';
import { endpoint, fixture } from './fixture';

const API_KEY = 'synthetic-backup-browser-test-key';
const folder = 'raw/articles/twitter-web-exporter';
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><main>Fixture</main>
<script nonce="fixture">window.__META_DATA__={userId:'42',userHash:'synthetic'};
window.webpackChunk_twitter_responsive_web=[];
fetch('${endpoint}?id=1001').then(r=>r.json());</script></body></html>`;
async function call(page: Page, request: Record<string, unknown>) {
  return page.evaluate(async (message) => chrome.runtime.sendMessage(message), request);
}

test('automatic vault backup: durable queue, restart, dedup, revisions, offline retry and secret isolation', async () => {
  test.setTimeout(90000);
  const files = new Map<string, string>();
  let offline = false;
  let authenticatedRequests = 0;
  const server = createServer(async (req, res) => {
    if (offline) {
      res.writeHead(503).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401).end();
      return;
    }
    authenticatedRequests++;
    if (req.url === '/') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          service: 'Obsidian Local REST API',
          authenticated: true,
          versions: { self: '5.2.0' },
        }),
      );
      return;
    }
    const path = decodeURIComponent(req.url ?? '');
    if (!path.startsWith('/vault/' + folder + '/')) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'GET') {
      if (!files.has(path)) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', 'text/markdown');
      res.end(files.get(path));
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      files.set(path, body);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const apiEndpoint = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'twe-backup-test-'));
  const extension = await extensionFixture(profile);
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'ko-KR',
    viewport: { width: 1200, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  try {
    console.log('BACKUP TEST: browser launched');
    const management = await context.newPage();
    await management.goto('chrome://extensions/');
    const item = management.locator('extensions-item').filter({ hasText: 'Twitter Web Exporter' });
    await expect(item).toBeVisible();
    const extensionId = await item.getAttribute('id');
    console.log(
      'EXTENSION ERRORS',
      await management.evaluate(async (id) => {
        const api = (
          chrome as unknown as {
            developerPrivate: {
              getExtensionInfo: (
                id: string,
              ) => Promise<{ runtimeErrors: unknown; manifestErrors: unknown }>;
            };
          }
        ).developerPrivate;
        const result = await api.getExtensionInfo(id!);
        return { runtimeErrors: result.runtimeErrors, manifestErrors: result.manifestErrors };
      }, extensionId),
    );
    await management.close();
    console.log('BACKUP TEST: extension registered');
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === apiEndpoint || url.protocol === 'chrome-extension:')
        return route.continue();
      if (url.origin === 'https://x.com' && url.pathname === '/i/bookmarks')
        return route.fulfill({
          contentType: 'text/html',
          body: html,
          headers: {
            'Content-Security-Policy':
              "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; style-src 'unsafe-inline'; img-src data: blob:",
          },
        });
      if (url.origin === 'https://x.com' && url.pathname.endsWith('/TweetDetail')) {
        const tweets =
          url.searchParams.get('stage') === 'late'
            ? [
                threadTweet('1020', '1010'),
                threadTweet('1011', '1001'),
                threadTweet('9000', '8999', '8999'),
              ]
            : [threadTweet('1010', '1001')];
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(detailResponse(tweets)),
        });
      }
      if (url.origin === 'https://x.com' && url.pathname.includes('/i/api/graphql/')) {
        const data = fixture(url.searchParams.get('id') ?? '1001');
        const entry = data.data.bookmark_timeline_v2.timeline.instructions[0]!.entries[0]!;
        if (url.searchParams.get('revision'))
          entry.content.itemContent.tweet_results.result.legacy.full_text = '수정된 한글 본문';
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      }
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#twe-root')).toHaveCount(1);
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/backup.html`);
    await expect(
      settings.getByRole('heading', { name: 'Obsidian 자동 백업', exact: true }),
    ).toBeVisible();
    console.log('BACKUP TEST: settings opened');
    const initial = await call(settings, { type: 'TWE_BACKUP_STATUS' });
    expect(initial.config.enabled).toBe(false);
    expect(files.size).toBe(0);
    await settings.locator('#endpoint').fill(apiEndpoint);
    await settings.locator('#api-key').fill(API_KEY);
    await settings.locator('#privacy').check();
    await settings.getByRole('button', { name: '연결 확인 · 저장', exact: true }).click();
    try {
      await expect(settings.locator('#connection-state')).toContainText('연결 설정 저장됨');
    } catch (error) {
      console.log('CONNECTION ERROR', await settings.locator('#error').textContent());
      throw error;
    }
    await expect(settings.locator('#api-key')).toHaveValue('');
    expect(JSON.stringify(await call(settings, { type: 'TWE_BACKUP_STATUS' }))).not.toContain(
      API_KEY,
    );
    await settings.locator('#enabled').check();
    await settings.getByRole('button', { name: '백업 설정 적용', exact: true }).click();
    await expect.poll(() => files.has(`/vault/${folder}/x-1001.md`)).toBe(true);
    expect(files.get(`/vault/${folder}/x-1001.md`)).toContain('> 한글 확장 프로그램 테스트 1001');
    await page.evaluate((api) => fetch(api + '?id=1001'), endpoint);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).done)
      .toBe(1);
    expect(files.size).toBe(1);
    await page.evaluate((api) => fetch(api + '?id=1001&revision=1'), endpoint);
    await expect
      .poll(() => [...files.keys()].some((p) => p.includes('/revisions/x-1001-')))
      .toBe(true);
    expect(files.get(`/vault/${folder}/x-1001.md`)).not.toContain('수정된');
    offline = true;
    await page.evaluate((api) => fetch(api + '?id=1002'), endpoint);
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).failed)
      .toBe(1);
    await page.close();
    // Restart the real MV3 worker. Its durable queue must survive, independent of X tabs.
    const browserCdp = await context.newCDPSession(settings);
    await browserCdp.send('ServiceWorker.enable');
    await browserCdp.send('ServiceWorker.stopAllWorkers');
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).pending)
      .toBe(1);
    offline = false;
    expect((await call(settings, { type: 'TWE_BACKUP_RETRY' })).ok).toBe(true);
    await expect.poll(() => files.has(`/vault/${folder}/x-1002.md`)).toBe(true);
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).pending)
      .toBe(0);
    expect(authenticatedRequests).toBeGreaterThan(0);
    // Isolated content contexts have no access to the API key or privileged config changes.
    const privacyPage = await context.newPage();
    const privacyCdp = await context.newCDPSession(privacyPage);
    const contexts: {
      id: number;
      name: string;
      origin?: string;
      auxData?: { isDefault?: boolean };
    }[] = [];
    privacyCdp.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
    await privacyCdp.send('Runtime.enable');
    await privacyPage.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded' });
    await expect(privacyPage.locator('#twe-root')).toHaveCount(1);
    const isolated = contexts.find(
      (c) =>
        c.name.includes(extensionId!) ||
        c.origin === `chrome-extension://${extensionId}` ||
        c.name === 'Twitter Web Exporter',
    );
    expect(isolated).toBeDefined();
    const privacyResult = await privacyCdp.send('Runtime.evaluate', {
      contextId: isolated!.id,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{let denied=false;try{await chrome.storage.local.get('vaultBackupApi')}catch{denied=true}
      const reply=await chrome.runtime.sendMessage({type:'TWE_BACKUP_CONFIG_SET',enabled:false,scope:'tweets'});
      return {denied,canModify:reply?.ok===true};})()`,
    });
    expect(privacyResult.result.value).toEqual({ denied: true, canModify: false });
    await settings.reload();
    await expect(settings.locator('#counts')).toContainText('자동 백업 켜짐');
    await settings.screenshot({
      path: 'test-results/obsidian-backup-settings.png',
      fullPage: true,
    });
    // Turning off backup is preserved; new captures must not be queued.
    await settings.locator('#enabled').uncheck();
    await settings.getByRole('button', { name: '백업 설정 적용', exact: true }).click();
    await expect(settings.locator('#counts')).toContainText('자동 백업 꺼짐');
    await privacyPage.evaluate((api) => fetch(api + '?id=9999'), endpoint);
    expect(files.has(`/vault/${folder}/x-9999.md`)).toBe(false);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  }
});
