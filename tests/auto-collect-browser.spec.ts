import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserPath } from './browser';
import { extensionFixture } from './extension-fixture';
import { fixture } from './fixture';
import { card, threadsHtml } from './threads-fixture';

const API_KEY = 'synthetic-auto-collect-test-key';
const folder = 'raw/articles/twitter-web-exporter';
const api = 'https://x.com/i/api/graphql/fixture/Bookmarks';
// Loads the first page on start and the next page on every scroll event, like X's timeline.
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><main>Fixture</main>
<script nonce="fixture">window.__META_DATA__={userId:'42',userHash:'synthetic'};
window.webpackChunk_twitter_responsive_web=[];
let page=0,busy=false;
function next(){if(busy)return;busy=true;fetch('${api}?page='+page++).then(r=>r.json()).finally(()=>{busy=false;});}
next();addEventListener('scroll',next);</script></body></html>`;
const call = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((m) => chrome.runtime.sendMessage(m), message);

function bookmarksPage(ids: string[]) {
  const data = fixture(ids[0] ?? '1');
  const instruction = data.data.bookmark_timeline_v2.timeline.instructions[0]!;
  const template = instruction.entries[0]!;
  instruction.entries = ids.map((id) => {
    const entry = structuredClone(template);
    const tweet = fixture(id).data.bookmark_timeline_v2.timeline.instructions[0]!.entries[0]!;
    return { ...entry, ...tweet };
  });
  return data;
}

test('periodic collection: inactive tabs, scroll until exhausted, stop at known ids, offline alert', async () => {
  test.setTimeout(240000);
  const files = new Map<string, string>();
  let pages: string[][] = [];
  const requested: number[] = [];
  let rejectAuth = false;
  const handler: Parameters<typeof createServer>[1] = async (req, res) => {
    if (rejectAuth || req.headers.authorization !== `Bearer ${API_KEY}`) {
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
  };
  let server: Server = createServer(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const port = address.port;
  const apiEndpoint = `http://127.0.0.1:${port}`;
  const profile = await mkdtemp(join(tmpdir(), 'twe-auto-collect-'));
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
      // Never reach the real sites. See the reload below.
      '--host-resolver-rules=MAP x.com 127.0.0.1:9, MAP www.threads.com 127.0.0.1:9',
    ],
  });
  context.setDefaultTimeout(10000);
  // Request interception does not cover the first navigation of a tab the extension opens.
  // That navigation fails offline; reloading it serves the fixture to the same tab id.
  context.on('page', (page) => {
    void page
      .waitForURL(/^chrome-error:/, { timeout: 15000 })
      .then(() => page.reload())
      .catch(() => {});
  });
  try {
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
              "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; style-src 'unsafe-inline'",
          },
        });
      if (url.origin === 'https://x.com' && url.pathname.endsWith('/Bookmarks')) {
        const index = Number(url.searchParams.get('page'));
        requested.push(index);
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(bookmarksPage(pages[index] ?? [])),
        });
      }
      if (url.origin === 'https://www.threads.com' && url.pathname === '/saved')
        return route.fulfill({
          contentType: 'text/html',
          body: threadsHtml(card('Auto_T1', '자동 수집 Threads 게시물')),
        });
      return route.abort();
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/backup.html`);
    await expect(settings.locator('#auto-interval')).toHaveValue('3');
    await expect(settings.locator('#auto-state')).toContainText('3시간마다 수집');
    await settings.locator('#endpoint').fill(apiEndpoint);
    await settings.locator('#api-key').fill(API_KEY);
    await settings.locator('#privacy').check();
    await settings.getByRole('button', { name: '연결 확인 · 저장', exact: true }).click();
    await expect(settings.locator('#connection-state')).toContainText('연결 설정 저장됨');
    await settings.locator('#enabled').check();
    // Only sources whose backup is on are collected periodically.
    await settings.locator('#threads-enabled').check();
    await settings.getByRole('button', { name: '백업 설정 적용', exact: true }).click();
    await expect(settings.locator('#counts')).toContainText('자동 백업 켜짐');

    // Run 1: nothing known yet, so it scrolls through every page until no new ids appear.
    pages = [['1003', '1002'], ['1001'], []];
    const opened = context.waitForEvent('page');
    await settings.getByRole('button', { name: '지금 수집', exact: true }).click();
    const xTab = await opened;
    await xTab.waitForURL('https://x.com/i/bookmarks');
    // Headless pages always report "visible"; check the tab strip instead.
    expect(
      await settings.evaluate(async () => {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        return active?.id === (await chrome.tabs.getCurrent())?.id;
      }),
    ).toBe(true);
    await expect(settings.locator('#auto-state')).toContainText('수집 중');
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).autoCollect.lastRun, {
        timeout: 90000,
      })
      .toMatchObject({
        x: { fresh: 3, reason: 'exhausted' },
        threads: { fresh: 1, reason: 'exhausted' },
      });
    expect(requested.slice(0, 3)).toEqual([0, 1, 2]);
    // Both collection tabs were closed again.
    expect(context.pages().filter((p) => p.url().startsWith('https://'))).toEqual([]);
    await expect.poll(() => files.has(`/vault/${folder}/x-1001.md`)).toBe(true);
    expect(files.has(`/vault/${folder}/x-1003.md`)).toBe(true);
    await expect(settings.locator('#auto-last')).toContainText(
      'X 새 항목 3개 (더 불러올 항목 없음)',
    );

    // Run 2: a new bookmark on top of saved ones. It must stop without scrolling further.
    pages = [['1004', '1003', '1002'], ['1001'], []];
    requested.length = 0;
    await call(settings, { type: 'TWE_AUTO_COLLECT_NOW' });
    await expect
      .poll(
        async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).autoCollect.lastRun.x,
        { timeout: 90000 },
      )
      .toEqual({ fresh: 1, reason: 'known' });
    expect(requested).toEqual([0]);
    await expect.poll(() => files.has(`/vault/${folder}/x-1004.md`)).toBe(true);

    // Interval change re-arms the alarm.
    await settings.locator('#auto-interval').selectOption('6');
    await expect(settings.locator('#auto-state')).toContainText('6시간마다 수집');
    const status = await call(settings, { type: 'TWE_BACKUP_STATUS' });
    expect(status.autoCollect.intervalHours).toBe(6);
    expect(status.autoCollect.nextRun).toBeGreaterThan(Date.now() + 5.9 * 3600 * 1000);

    // Obsidian closed: notes stay queued; an outage older than one hour raises one alert.
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await settings.evaluate(() =>
      chrome.storage.local.set({ disconnectedSince: Date.now() - 61 * 60 * 1000 }),
    );
    pages = [['1005', '1004'], []];
    await call(settings, { type: 'TWE_AUTO_COLLECT_NOW' });
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).pending, {
        timeout: 60000,
      })
      .toBe(1);
    await expect
      .poll(() => settings.evaluate(async () => Object.keys(await chrome.notifications.getAll())))
      .toEqual(['twe-obsidian-offline']);
    await expect(settings.locator('#offline')).toContainText('Obsidian 연결 끊김');
    expect(files.has(`/vault/${folder}/x-1005.md`)).toBe(false);

    // Obsidian back: the queued note is written and the alert is withdrawn.
    server = createServer(handler);
    await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
    await call(settings, { type: 'TWE_BACKUP_RETRY' });
    await expect.poll(() => files.has(`/vault/${folder}/x-1005.md`)).toBe(true);
    await expect
      .poll(() => settings.evaluate(async () => Object.keys(await chrome.notifications.getAll())))
      .toEqual([]);
    await expect(settings.locator('#offline')).toBeHidden();

    // A server that answers, even with an auth error, is reachable: not an outage.
    await settings.evaluate(() =>
      chrome.storage.local.set({ disconnectedSince: Date.now() - 10 * 60 * 1000 }),
    );
    rejectAuth = true;
    pages = [['1006', '1005'], []];
    await call(settings, { type: 'TWE_AUTO_COLLECT_NOW' });
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).disconnectedSince, {
        timeout: 60000,
      })
      .toBe(0);
    await expect(settings.locator('#offline')).toBeHidden();
    rejectAuth = false;
    await expect
      .poll(async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).autoCollect.running, {
        timeout: 60000,
      })
      .toBe('');

    // The user switches to the collection tab: stop scrolling and leave the tab open.
    pages = [['1008', '1007'], ['1006'], []];
    const viewed = context.waitForEvent('page');
    await call(settings, { type: 'TWE_AUTO_COLLECT_NOW' });
    const userTab = await viewed;
    await userTab.waitForURL('https://x.com/i/bookmarks');
    await userTab.bringToFront();
    await expect
      .poll(
        async () => (await call(settings, { type: 'TWE_BACKUP_STATUS' })).autoCollect.lastRun.x,
        { timeout: 60000 },
      )
      .toMatchObject({ reason: 'interrupted' });
    expect(userTab.isClosed()).toBe(false);

    // A worker restart during the close grace period must not leave the tab behind.
    await settings.bringToFront();
    const orphan = await settings.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      const now = Date.now();
      await chrome.storage.session.set({
        autoCollectRun: {
          startedAt: now,
          updatedAt: now,
          queue: [],
          result: { startedAt: now, finishedAt: 0 },
          closing: tab.id,
        },
      });
      await chrome.alarms.create('twe-auto-collect-watchdog', { when: Date.now() + 100 });
      return tab.id!;
    });
    await expect
      .poll(() =>
        settings.evaluate(
          (id) =>
            chrome.tabs.get(id).then(
              () => true,
              () => false,
            ),
          orphan,
        ),
      )
      .toBe(false);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(profile, { recursive: true, force: true });
  }
});
