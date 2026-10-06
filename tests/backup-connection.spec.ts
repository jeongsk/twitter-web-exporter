import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extensionFixture } from './extension-fixture';
import { browserPath } from './browser';

const key = 'synthetic-connection-regression-key';
async function connectionPage(run: (page: Page, endpoint: string) => Promise<void>) {
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/') {
      writes++;
      res.writeHead(405).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        service: 'Obsidian Local REST API',
        authenticated: req.headers.authorization === `Bearer ${key}`,
        versions: { self: '5.2.0' },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address missing');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'twe-connection-'));
  const extension = await extensionFixture(profile);
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'ko-KR',
    viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(10000);
  try {
    const management = await context.newPage();
    await management.goto('chrome://extensions/');
    const item = management.locator('extensions-item').filter({ hasText: 'Twitter Web Exporter' });
    await expect(item).toBeVisible();
    const id = await item.getAttribute('id');
    await management.close();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/backup.html`);
    await expect(page.locator('#connection-state')).toContainText('아직 연결되지');
    await page.clock.install();
    await run(page, endpoint);
    expect(writes).toBe(0);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  }
}
async function fill(page: Page, endpoint: string) {
  await page.locator('#endpoint').fill(endpoint);
  await page.locator('#api-key').fill(key);
  await page.locator('#privacy').check();
}

test('connection errors stay next to the button across polling; auth failure can be retried', async () => {
  await connectionPage(async (page, endpoint) => {
    const button = page.locator('#connect');
    const error = page.locator('#connection-error');
    await page.locator('#endpoint').fill(endpoint);
    await button.click();
    await expect(error).toContainText('API 키를 입력');
    await expect(error).toBeInViewport();
    await page.locator('#api-key').fill(key);
    await button.click();
    await expect(error).toContainText('체크박스를 선택');
    await page.clock.fastForward(21000);
    await expect(error).toBeVisible();
    await expect(error).toContainText('체크박스를 선택');
    await expect(page.locator('#connection-state')).toContainText('실패');
    await page.locator('#privacy').check();
    await page.evaluate(() => {
      chrome.permissions.request = async () => false;
    });
    await button.click();
    await expect(error).toHaveAttribute('data-code', 'PERMISSION_DENIED');
    await expect(error).toBeInViewport();
    await page.reload();
    await expect(page.locator('#connection-state')).toContainText('아직 연결되지');
    await fill(page, endpoint);
    await page.locator('#api-key').fill('synthetic-wrong-api-key');
    await button.click();
    await expect(error).toHaveAttribute('data-code', 'AUTH');
    await expect(error).toContainText('API 키 인증에 실패');
    await page.clock.fastForward(21000);
    await expect(error).toBeVisible();
    await expect(error).toBeInViewport();
    await page
      .locator('section')
      .first()
      .screenshot({ path: 'test-results/obsidian-connection-error.png' });
    await page.locator('#api-key').fill(key);
    await button.click();
    await expect(page.locator('#connection-state')).toContainText('연결 확인 완료');
    await expect(error).toBeHidden();
    await expect(page.locator('#api-key')).toHaveValue('');
    await page.clock.fastForward(21000);
    await expect(page.locator('#connection-state')).toContainText('연결 확인 완료');
    expect(await page.locator('#api-status-link').getAttribute('href')).toBe(endpoint + '/');
    expect(await page.locator('body').innerText()).not.toContain(key);
  });
});

test('permission and worker timeouts are visible and release the connection button', async () => {
  await connectionPage(async (page, endpoint) => {
    await fill(page, endpoint);
    await page.evaluate(() => {
      chrome.permissions.request = () => new Promise<boolean>(() => {});
    });
    await page.locator('#connect').click();
    await expect(page.locator('#connect')).toBeDisabled();
    await expect(page.locator('#connection-state')).toContainText('권한');
    await page.clock.fastForward(21000);
    await expect(page.locator('#connection-error')).toHaveAttribute(
      'data-code',
      'PERMISSION_TIMEOUT',
    );
    await expect(page.locator('#connect')).toBeEnabled();
    await page.reload();
    await expect(page.locator('#connection-state')).toContainText('아직 연결되지');
    await fill(page, endpoint);
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: { type?: string }) =>
        message.type === 'TWE_BACKUP_API_SAVE'
          ? new Promise(() => {})
          : original(message)) as typeof chrome.runtime.sendMessage;
    });
    await page.locator('#connect').click();
    await expect(page.locator('#connection-state')).toContainText('API 키를 확인');
    await page.clock.fastForward(16000);
    await expect(page.locator('#connection-error')).toHaveAttribute('data-code', 'WORKER_TIMEOUT');
    await expect(page.locator('#connection-error')).toBeInViewport();
    await expect(page.locator('#connect')).toBeEnabled();
    await page.clock.fastForward(21000);
    await expect(page.locator('#connection-error')).toContainText('설정 탭을 닫았다 다시');
  });
});
