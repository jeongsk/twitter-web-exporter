import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserPath } from './browser';
import { extensionFixture } from './extension-fixture';
import { endpoint, fixture } from './fixture';
import { detailResponse, threadTweet } from './thread-fixture';

test('bookmarks-only backup includes existing and later nested comments in complete snapshots', async () => {
  test.setTimeout(60000);
  const files = new Map<string, string>();
  const folder = 'raw/articles/twitter-web-exporter';
  const token = 'synthetic-thread-fixture-token';
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
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
    const path = decodeURIComponent(req.url!);
    if (!path.startsWith(`/vault/${folder}/`)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      files.set(path, body);
      res.writeHead(204).end();
      return;
    }
    if (!files.has(path)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.end(files.get(path));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  const apiEndpoint = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'twe-thread-'));
  const extension = await extensionFixture(profile);
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  try {
    const admin = await context.newPage();
    await admin.goto('chrome://extensions/');
    const item = admin.locator('extensions-item').filter({ hasText: 'Twitter Web Exporter' });
    await expect(item).toBeVisible();
    const extensionId = await item.getAttribute('id');
    await admin.close();
    let replies = [threadTweet('1010', '1001')];
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:' || url.origin === apiEndpoint)
        return route.continue();
      if (url.origin !== 'https://x.com') return route.abort();
      if (url.pathname.endsWith('/Bookmarks'))
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(fixture('1001')),
        });
      if (url.pathname.endsWith('/TweetDetail'))
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(detailResponse(replies)),
        });
      if (url.pathname === '/i/bookmarks')
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body><script>window.__META_DATA__={userId:'42',userHash:'test'};
        window.webpackChunk_twitter_responsive_web=[];fetch('${endpoint}');</script></body></html>`,
        });
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await page.evaluate((api) => fetch(api.replace('Bookmarks', 'TweetDetail')), endpoint);
    const panel = page
      .locator('.module-panel')
      .filter({ has: page.getByText('TweetDetail', { exact: true }) });
    await expect(panel).toContainText('Captured: 1');
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/backup.html`);
    await expect(settings.locator('#connection-state')).toContainText('아직 연결되지');
    await settings.locator('#endpoint').fill(apiEndpoint);
    await settings.locator('#api-key').fill(token);
    await settings.locator('#privacy').check();
    await settings.locator('#connect').click();
    await expect(settings.locator('#connection-state')).toContainText('연결 설정 저장됨');
    await settings.locator('#enabled').check();
    await settings.locator('#apply').click();
    const base = `/vault/${folder}/x-1001.md`;
    await expect.poll(() => files.get(base)).toContain('댓글 본문 1010');
    expect(files.get(base)).toContain('replies_captured: 1');
    expect(files.get(base)).toContain('한글 확장 프로그램 테스트 1001');
    expect(files.size).toBe(1);
    replies = [
      threadTweet('1020', '1010'),
      threadTweet('1011', '1001'),
      threadTweet('9000', '8999', '8999'),
    ];
    await page.evaluate((api) => fetch(api.replace('Bookmarks', 'TweetDetail')), endpoint);
    await expect
      .poll(() => [...files.values()].some((text) => text.includes('replies_captured: 3')))
      .toBe(true);
    const bundle = [...files.values()].find((text) => text.includes('replies_captured: 3'))!;
    for (const id of ['1010', '1011', '1020']) expect(bundle).toContain(`댓글 본문 ${id}`);
    expect(bundle).toContain('한글 확장 프로그램 테스트 1001');
    expect(bundle).toContain('답글 깊이: 2');
    expect(bundle).toContain('replies_complete: false');
    expect([...files.values()].join('')).not.toContain('댓글 본문 9000');
    expect(files.get(base)).toContain('replies_captured: 1');
    expect(files.has(`/vault/${folder}/x-1010.md`)).toBe(false);
    expect(files.has(`/vault/${folder}/x-1020.md`)).toBe(false);
    const count = files.size;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await settings.reload();
    await expect(settings.locator('#counts')).toContainText('대기 0');
    expect(files.size).toBe(count);
    await settings.screenshot({ path: 'test-results/thread-backup-settings.png', fullPage: true });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  }
});
