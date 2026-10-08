import { test, expect, chromium, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { endpoint, fixture } from './fixture';

function browserPath(): string | undefined {
  if (process.env.TWE_CHROMIUM_EXECUTABLE) return process.env.TWE_CHROMIUM_EXECUTABLE;
  if (process.platform !== 'darwin') return undefined;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const entries = readdirSync(cache)
    .filter((s) => /^chromium-\d+$/.test(s))
    .sort()
    .reverse();
  for (const entry of entries) {
    const file = join(
      cache,
      entry,
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    );
    if (existsSync(file)) return file;
  }
  return undefined;
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Local X Fixture</title></head><body><main>Synthetic test page</main>
<script nonce="fixture">window.__META_DATA__={userId:'42',userHash:'synthetic'};
window.webpackChunk_twitter_responsive_web=[];
fetch('${endpoint}?id=1001').then(r=>r.json()).then(r=>window.__testResponse=r);
</script></body></html>`;

async function countTweets(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((done, reject) => {
        const request = indexedDB.open('twitter-web-exporter');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('tweets')) {
            db.close();
            done(0);
            return;
          }
          const count = db.transaction('tweets').objectStore('tweets').count();
          count.onsuccess = () => {
            done(count.result);
            db.close();
          };
          count.onerror = () => reject(count.error);
        };
      }),
  );
}

test('Chrome MV3 capture, persistence, popup messaging and exports', async () => {
  test.setTimeout(60000);
  const profile = await mkdtemp(join(tmpdir(), 'twe-chrome-test-'));
  const extension = resolve('dist/chrome');
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'en-US',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
  try {
    console.log('STEP browser launched');
    // No requests reach the real X service; all test data are synthetic.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.origin === 'https://x.com' && url.pathname === '/i/bookmarks') {
        return route.fulfill({
          contentType: 'text/html',
          body: html,
          headers: {
            'Content-Security-Policy':
              "default-src 'none'; script-src 'nonce-fixture'; connect-src 'self'; img-src data: blob:; style-src 'self' 'unsafe-inline'",
          },
        });
      }
      if (url.origin === 'https://x.com' && url.pathname.includes('/i/api/graphql/')) {
        return route.fulfill({
          status: Number(url.searchParams.get('status') ?? 200),
          contentType: 'application/json',
          body: JSON.stringify(fixture(url.searchParams.get('id') ?? '1001')),
        });
      }
      return route.abort();
    });
    const management = await context.newPage();
    await management.goto('chrome://extensions/');
    const item = management.locator('extensions-item').filter({ hasText: 'Twitter Web Exporter' });
    await expect(item).toBeVisible();
    console.log('STEP extension registered');
    const extensionId = await item.getAttribute('id');
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    await management.close();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('[twitter-web-exporter]'))
        errors.push(msg.text());
    });
    console.log('STEP open fixture');
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded' });
    console.log('STEP fixture loaded');
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await expect.poll(() => countTweets(page)).toBe(1);
    console.log('STEP first capture verified');
    expect(await page.evaluate(() => window.__TWE_CHROME_BRIDGE__)).toBeUndefined();
    await page.evaluate(async (api) => {
      await new Promise<void>((done) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', api + '?id=1002');
        xhr.onload = () => done();
        xhr.send();
      });
      await fetch(api + '?id=1002');
      await fetch(api + '?id=9999&status=429');
      await fetch(api.replace('Bookmarks', 'UnsupportedOperation') + '?id=9998');
    }, endpoint);
    await expect.poll(() => countTweets(page)).toBe(2);
    console.log('STEP duplicate capture verified');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await expect.poll(() => countTweets(page)).toBe(2);
    console.log('STEP persistence verified');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const tabId = await popup.evaluate(async () => {
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id === undefined) continue;
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'TWE_STATUS' });
          if (response?.ready) return tab.id;
        } catch {
          /* Tabs without this content script are expected. */
        }
      }
      throw new Error('Synthetic X tab not found');
    });
    console.log('STEP status message verified');
    const result = await popup.evaluate(
      async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'toggle-panel' }),
      tabId,
    );
    expect(result).toEqual({ ok: true });
    await expect(page.locator('#twe-root > section')).toHaveClass(/translate-x-\[-500px\]/);
    await popup.evaluate(
      async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'toggle-panel' }),
      tabId,
    );
    await expect(page.locator('#twe-root > section')).toHaveClass(/transform-none/);
    await popup.close();
    console.log('STEP toolbar commands verified');
    const module = page
      .locator('#twe-root .module-panel')
      .filter({ has: page.getByText('Bookmarks', { exact: true }) });
    await module.locator('button').first().click();
    const tableModal = page
      .locator('dialog[open]')
      .filter({ has: page.getByRole('heading', { name: 'Bookmarks', exact: true }) });
    await expect(tableModal).toBeVisible();
    await tableModal.getByRole('button', { name: 'Export Data', exact: true }).click();
    const exportModal = page
      .locator('dialog[open]')
      .filter({ has: page.getByRole('heading', { name: 'Bookmarks Data', exact: true }) })
      .last();
    for (const kind of ['JSON', 'CSV', 'HTML']) {
      await exportModal.locator('select').selectOption(kind);
      console.log('STEP export', kind);
      const pending = page.waitForEvent('download');
      await exportModal.getByRole('button', { name: 'Start Export', exact: true }).click();
      const download = await pending;
      const file = await download.path();
      const text = readFileSync(file!, 'utf8');
      expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${kind.toLowerCase()}$`));
      if (kind === 'JSON')
        expect(
          JSON.parse(text)
            .map((r: { id: string }) => r.id)
            .sort(),
        ).toEqual(['1001', '1002']);
      if (kind === 'CSV') expect(text).toContain('full_text');
      if (kind === 'HTML') expect(text).not.toContain('cdn.jsdelivr.net');
    }
    await page.screenshot({ path: 'test-results/chrome-extension.png', fullPage: true });
    await exportModal.getByRole('button', { name: 'Cancel', exact: true }).click();
    const settingsPopup = await context.newPage();
    await settingsPopup.goto(`chrome-extension://${extensionId}/popup.html`);
    await settingsPopup.evaluate(
      async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'open-settings' }),
      tabId,
    );
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await verifyKoreanUI(page, settingsPopup, tabId);
    await page.evaluate(async (api) => {
      window.__META_DATA__.userId = '43';
      await fetch(api + '?id=1003');
    }, endpoint);
    await expect
      .poll(async () =>
        settingsPopup.evaluate(async (id) => {
          const state = await chrome.tabs.sendMessage(id, { type: 'TWE_STATUS' });
          return state.error;
        }, tabId),
      )
      .toContain('로그인 계정이 변경');
    expect(await countTweets(page)).toBe(2);
    await settingsPopup.close();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function verifyKoreanUI(page: Page, popup: Page, tabId: number) {
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ko');
  await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '언어', exact: true })).toHaveValue('ko');
  await expect(page.locator('select option[value="system"]')).toHaveText('시스템 설정');
  await expect(page.getByText('계정별 DB 사용', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '가져오기', exact: true })).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#twe-root')).toHaveCount(1);
  await expect.poll(() => countTweets(page)).toBe(2);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('twitter-web-exporter')!).language),
  ).toBe('ko');
  // After a reload the menu handlers register a moment after the panel renders; until then the
  // tab answers "not ready" instead of opening settings.
  await expect
    .poll(() =>
      popup.evaluate(
        async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'open-settings' }),
        tabId,
      ),
    )
    .toMatchObject({ ok: true });
  await expect(page.getByRole('combobox', { name: '언어', exact: true })).toHaveValue('ko');
  await page.screenshot({
    path: 'test-results/chrome-settings-ko.png',
    fullPage: true,
    animations: 'disabled',
  });
  await popup.evaluate(
    async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'open-settings' }),
    tabId,
  );
  await page
    .locator('#twe-root .module-panel')
    .filter({ has: page.getByText('북마크', { exact: true }) })
    .locator('button')
    .first()
    .click();
  await expect(page.getByRole('columnheader', { name: '내용', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '데이터 내보내기', exact: true }).click();
  const modal = page
    .locator('dialog[open]')
    .filter({ has: page.getByRole('heading', { name: '북마크 데이터', exact: true }) })
    .last();
  await expect(modal.getByText('모든 메타데이터 포함:', { exact: true })).toBeVisible();
  await modal.locator('select').selectOption('HTML');
  const pending = page.waitForEvent('download');
  await modal.getByRole('button', { name: '내보내기 시작', exact: true }).click();
  const downloaded = await pending;
  const text = readFileSync((await downloaded.path())!, 'utf8');
  expect(text).toContain('<th>내용</th>');
  expect(text).toContain('<th>작성일</th>');
  expect(downloaded.suggestedFilename()).toContain('북마크');
  await modal.getByRole('button', { name: '취소', exact: true }).click();
  await page.getByRole('button', { name: '미디어 내보내기', exact: true }).click();
  const media = page
    .locator('dialog[open]')
    .filter({ has: page.getByRole('heading', { name: '북마크 미디어', exact: true }) })
    .last();
  await expect(media.getByRole('button', { name: 'URL 복사', exact: true })).toBeVisible();
  await expect(media.getByText('다운로드 간격 (ms):', { exact: true })).toBeVisible();
  await media.getByRole('button', { name: '취소', exact: true }).click();
  console.log('STEP Korean settings, persistence, table, export and media UI verified');
}
test('Korean browser language is detected on first run', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'twe-korean-test-'));
  const extension = resolve('dist/chrome');
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'ko-KR',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.origin === 'https://x.com' && url.pathname === '/i/bookmarks')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (url.origin === 'https://x.com' && url.pathname === new URL(endpoint).pathname)
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(fixture('1001')),
        });
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto('https://x.com/i/bookmarks', { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('#twe-root .module-panel').getByText('북마크', { exact: true }),
    ).toBeVisible();
    await expect.poll(() => countTweets(page)).toBe(1);
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('twitter-web-exporter')!).language),
    ).toBe('ko');
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
