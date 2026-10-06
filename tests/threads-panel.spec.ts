import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { browserPath } from './browser';
import { card, threadsHtml } from './threads-fixture';

const savedUrl = 'https://www.threads.com/saved';
const call = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((msg) => chrome.runtime.sendMessage(msg), message);
async function fixture(
  run: (context: BrowserContext, page: Page, popup: Page, tab: number) => Promise<void>,
) {
  const profile = await mkdtemp(join(tmpdir(), 'twe-threads-panel-'));
  const extension = resolve('dist/chrome');
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'ko-KR',
    viewport: { width: 1280, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  try {
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'chrome-extension:') return route.continue();
      if (url.origin !== 'https://www.threads.com') return route.abort();
      const content =
        url.pathname === '/saved'
          ? card('Root', '테스트 북마크 본문', { image: 'media-one' }) +
            card('Second', '찾을 글', { author: 'another.writer' })
          : url.pathname.includes('/post/Root')
            ? card('Root', '테스트 북마크 본문') + card('Reply', '연결된 댓글', { parent: 'Root' })
            : card('NotSaved', '홈·프로필 게시물은 수집하지 않음');
      return route.fulfill({
        contentType: 'text/html',
        body: threadsHtml(content),
        headers: {
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
        },
      });
    });
    const management = await context.newPage();
    await management.goto('chrome://extensions/');
    const item = management.locator('extensions-item').filter({ hasText: 'Twitter Web Exporter' });
    await expect(item).toBeVisible();
    const id = await item.getAttribute('id');
    await management.close();
    const page = await context.newPage();
    await page.goto('https://www.threads.com/');
    await expect(page.getByRole('heading', { name: 'Web Exporter', exact: true })).toBeVisible();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const tab = await popup.evaluate(async () => {
      for (const candidate of await chrome.tabs.query({})) {
        if (candidate.id === undefined) continue;
        try {
          const state = await chrome.tabs.sendMessage(candidate.id, { type: 'TWE_STATUS' });
          if (state?.source === 'threads') return candidate.id;
        } catch {
          /* Non-Threads tabs intentionally have no receiver. */
        }
      }
      throw new Error('Threads test tab missing');
    });
    await run(context, page, popup, tab);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

test('Threads shows Web Exporter on every route, preserves close state, and excludes its own UI from capture', async () => {
  await fixture(async (_context, page, popup, tab) => {
    const panel = page.locator('#twe-threads-panel');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 0');
    await page.goto(savedUrl);
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 2');
    await expect(panel).toHaveCSS('position', 'fixed');
    await expect(panel).toHaveCSS('width', '320px');
    await expect(panel).toHaveCSS('left', '32px');
    await page.getByRole('button', { name: '제어판 닫기', exact: true }).click();
    await expect(panel).toBeHidden();
    await page.evaluate(
      (html) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html),
      card('Later', '늦게 로드된 글'),
    );
    await expect
      .poll(async () =>
        popup.evaluate(
          async (id) => (await chrome.tabs.sendMessage(id, { type: 'TWE_STATUS' })).counts.tweets,
          tab,
        ),
      )
      .toBe(3);
    await expect(panel).toBeHidden();
    await page.reload();
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await expect(panel).toBeHidden();
    await popup.evaluate(
      async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'toggle-panel' }),
      tab,
    );
    await expect(panel).toBeVisible();
    await page.getByRole('button', { name: 'Threads 저장 게시물', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Threads 저장 게시물', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('tbody tr')).toHaveCount(3);
    await dialog.getByRole('searchbox').fill('another.writer');
    await expect(dialog.locator('tbody tr')).toHaveCount(1);
    await expect(dialog.locator('tbody')).toContainText('찾을 글');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.evaluate(
      (html) => document.querySelector('#twe-root')!.insertAdjacentHTML('beforeend', html),
      card('PanelOnly', '제어판 안의 데이터는 다시 수집하면 안 됩니다.'),
    );
    await page.getByRole('button', { name: '다시 수집', exact: true }).click();
    await expect(page.getByRole('button', { name: '다시 수집', exact: true })).toBeEnabled();
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 3');
    await page.evaluate(() => document.querySelector('#twe-root')!.remove());
    await expect(panel).toBeVisible();
    await expect(page.locator('#twe-root')).toHaveCount(1);
    await page.goto('https://www.threads.com/@writer.one/post/Root');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-module="threads-replies"]')).toContainText('수집됨: 1');
    await page.getByRole('button', { name: '댓글·대댓글', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '댓글·대댓글', exact: true })).toContainText(
      '연결된 댓글',
    );
    await page.keyboard.press('Escape');
    await panel.screenshot({
      path: 'test-results/threads-web-exporter-panel.png',
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 700 });
    await expect(panel).toBeInViewport();
    const box = await panel.boundingBox();
    expect(box!.width + box!.x).toBeLessThanOrEqual(390);
    await page.goto('https://www.threads.com/@writer.one');
    await expect(panel).toBeVisible();
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 3');
  });
});

test('Threads toolbar opens settings; theme, language, pagination and backup shortcut work', async () => {
  await fixture(async (context, page, popup, tab) => {
    await page.goto(savedUrl);
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 2');
    await popup.evaluate(
      async (id) => chrome.tabs.sendMessage(id, { type: 'TWE_COMMAND', action: 'open-settings' }),
      tab,
    );
    let settings = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByLabel('테마', { exact: true }).selectOption('dark');
    await expect(page.locator('.twe-threads-ui')).toHaveAttribute('data-theme', 'dark');
    await settings.getByLabel('언어', { exact: true }).selectOption('en');
    settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('.twe-threads-ui')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('Bookmarks');
    const many = Array.from({ length: 28 }, (_, i) => card(`Page${i}`, `페이지 항목 ${i}`)).join(
      '',
    );
    await page.evaluate(
      (html) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html),
      many,
    );
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('Captured: 30');
    await page.getByRole('button', { name: 'Threads saved posts', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Threads saved posts', exact: true });
    await expect(dialog.locator('tbody tr')).toHaveCount(25);
    await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(dialog.locator('tbody tr')).toHaveCount(5);
    await dialog.getByRole('searchbox').fill('찾을 글');
    await expect(dialog.locator('tbody tr')).toHaveCount(1);
    await expect(dialog.getByRole('status')).toContainText('1 of 1');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByLabel('Language', { exact: true }).selectOption('ko');
    settings = page.getByRole('dialog', { name: '설정', exact: true });
    await settings.getByLabel('테마', { exact: true }).selectOption('system');
    const opened = context.waitForEvent('page');
    await settings.getByRole('button', { name: 'Obsidian 자동 백업', exact: true }).click();
    const backup = await opened;
    await expect(
      backup.getByRole('heading', { name: 'Obsidian 자동 백업', exact: true }),
    ).toBeVisible();
    expect((await call(backup, { type: 'TWE_BACKUP_STATUS' })).config.enabled).toBe(false);
    const names = await page.evaluate(async () =>
      (await indexedDB.databases()).map((db) => db.name),
    );
    expect(names).toContain('twitter-web-exporter-threads-source');
    expect(names).not.toContain('twitter-web-exporter');
  });
});

test('Threads panel exposes backup errors and toolbar settings without enabling backup', async () => {
  await fixture(async (context, page, popup, tab) => {
    await page.goto(savedUrl);
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 2');
    const cdp = await context.newCDPSession(page);
    const contexts: { id: number; name: string }[] = [];
    cdp.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
    await cdp.send('Runtime.enable');
    const isolated = contexts.find((item) => item.name === 'Twitter Web Exporter');
    expect(isolated).toBeDefined();
    await cdp.send('Runtime.evaluate', {
      contextId: isolated!.id,
      expression: `(() => { const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = message => message.type === 'TWE_BACKUP_CONFIG_GET'
          ? Promise.resolve({ok:false,error:'모의 백업 연결 오류: 다시 시도하세요.'}) : original(message);
      })()`,
    });
    await page.getByRole('button', { name: '다시 수집', exact: true }).click();
    await expect(page.getByTestId('threads-error')).toContainText('모의 백업 연결 오류');
    await expect(page.getByTestId('threads-error')).toBeInViewport();
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 2');
    // A tab opened as popup.html is not a native action popup. Stub only active-tab lookup;
    // the actual popup buttons and extension-to-content commands still execute unmodified.
    await popup.addInitScript(
      ({ tab, savedUrl }) => {
        const original = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = ((query: chrome.tabs.QueryInfo) =>
          query.active
            ? Promise.resolve([{ id: tab, url: savedUrl }])
            : original(query)) as typeof chrome.tabs.query;
      },
      { tab, savedUrl },
    );
    await popup.reload();
    await expect(popup.locator('#settings')).toBeEnabled();
    await popup.locator('#settings').click();
    await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('threads-error')).toBeVisible();
  });
});
