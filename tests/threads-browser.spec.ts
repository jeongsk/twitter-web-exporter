import { test, expect, chromium, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserPath } from './browser';
import { extensionFixture } from './extension-fixture';
import { card, threadsHtml } from './threads-fixture';
import { threadsStorageId } from '../src/threads/model';

const KEY = 'synthetic-threads-browser-key';
const folder = 'raw/articles/twitter-web-exporter';
const savedUrl = 'https://www.threads.com/saved';
const filePath = (code: string) => `/vault/${folder}/threads/threads-${threadsStorageId(code)}.md`;
const call = (page: Page, msg: Record<string, unknown>) =>
  page.evaluate((message) => chrome.runtime.sendMessage(message), msg);

test('Threads saved posts: opt-in, DOM isolation, dynamic capture, replies, persistence and retry', async () => {
  test.setTimeout(90000);
  const files = new Map<string, string>();
  let offline = false,
    writes = 0;
  const server = createServer(async (req, res) => {
    if (offline) {
      res.writeHead(503).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) {
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
      if (!files.has(path)) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', 'text/markdown');
      res.end(files.get(path));
      return;
    }
    if (req.method === 'PUT') {
      let text = '';
      for await (const chunk of req) text += chunk.toString();
      writes++;
      files.set(path, text);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'twe-threads-test-'));
  const extension = await extensionFixture(profile);
  const executablePath = browserPath();
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: executablePath ? undefined : 'chromium',
    headless: true,
    locale: 'ko-KR',
    viewport: { width: 1300, height: 950 },
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
    const saved =
      card('Case_A1', '좋아요', { image: 'own-one', more: true, quote: 'QuoteNotSaved' }) +
      card('case_a1', '좋아요', { image: 'own-two', author: 'writer.two', semantic: false }) +
      card('PhotoOnly', '', { image: 'photo-only' });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === endpoint || url.protocol === 'chrome-extension:') return route.continue();
      if (url.origin === 'https://www.threads.com') {
        const content =
          url.pathname === '/saved'
            ? saved
            : url.pathname.includes('/post/Case_A1')
              ? card('Case_A1', '좋아요. 원문에서 더 보기를 펼친 전체 내용입니다.', {
                  image: 'own-one',
                }) +
                card('ReplyOne', '첫 번째 댓글', { author: 'reply.user', parent: 'Case_A1' }) +
                card('ReplyTwo', '두 번째 대댓글', { author: 'reply.other', parent: 'ReplyOne' }) +
                card('Unrelated', '명시적 연결이 없는 추천 게시물')
              : card('HomeOnly', '홈 피드는 수집하지 않음');
        return route.fulfill({ contentType: 'text/html', body: threadsHtml(content) });
      }
      return route.abort();
    });
    let page = await context.newPage();
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 3');
    expect(writes).toBe(0);
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/backup.html`);
    await expect(options.locator('#connection-state')).toContainText('아직 연결되지');
    await options.locator('#endpoint').fill(endpoint);
    await options.locator('#api-key').fill(KEY);
    await options.locator('#privacy').check();
    await options.locator('#connect').click();
    await expect(options.locator('#connection-state')).toContainText('연결 확인 완료');
    await options.locator('#enabled').check();
    await options.locator('#apply').click();
    await expect(options.locator('#counts')).toContainText('자동 백업 켜짐');
    await expect
      .poll(async () => (await call(options, { type: 'TWE_BACKUP_STATUS' })).config.threadsEnabled)
      .toBe(false);
    expect(writes).toBe(0);
    await options.locator('#threads-enabled').check();
    await options.locator('#apply').click();
    await expect.poll(() => files.size).toBe(3);
    const first = files.get(filePath('Case_A1'))!;
    expect(first).toContain('> 좋아요');
    expect(first).toContain('own-one.jpg');
    expect(first).not.toContain('own-two.jpg');
    expect(first).not.toContain('avatar-');
    expect(first).not.toContain('인용 안의 다른 게시물');
    expect(first).not.toContain('Sidebar');
    expect(files.get(filePath('case_a1'))).toContain('own-two.jpg');
    expect(files.get(filePath('PhotoOnly'))).toContain('photo-only.jpg');
    await page.evaluate(
      (html) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html),
      card('Dynamic', '동적으로 로드된 글'),
    );
    await expect.poll(() => files.has(filePath('Dynamic'))).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-module="threads-saved"]')).toContainText('수집됨: 4');
    await expect
      .poll(async () => (await call(options, { type: 'TWE_BACKUP_STATUS' })).pending)
      .toBe(0);
    expect(writes).toBe(4);
    await page.goto('https://www.threads.com/@writer.one/post/Case_A1', {
      waitUntil: 'domcontentloaded',
    });
    await expect
      .poll(() =>
        [...files.entries()].some(
          ([path, text]) => path.includes('/revisions/') && text.includes('두 번째 대댓글'),
        ),
      )
      .toBe(true);
    const bundled = [...files.entries()].find(
      ([path, text]) => path.includes('/revisions/') && text.includes('두 번째 대댓글'),
    )![1];
    expect(bundled).toContain('전체 내용입니다.');
    expect(bundled).toContain('첫 번째 댓글');
    expect(bundled).not.toContain('명시적 연결이 없는 추천');
    expect(bundled).toContain('replies_captured: 2');
    expect(files.get(filePath('Case_A1'))).toBe(first);
    await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
    expect(files.has(filePath('HomeOnly'))).toBe(false);
    await page.evaluate(
      (html) => {
        history.pushState({}, '', '/saved');
        document.querySelector('main')!.innerHTML = html;
      },
      card('SpaSaved', 'SPA 이동 후 저장 글'),
    );
    await expect.poll(() => files.has(filePath('SpaSaved'))).toBe(true);
    offline = true;
    await page.evaluate(
      (html) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html),
      card('Offline', '연결 복구 뒤 저장할 글'),
    );
    await expect
      .poll(async () => (await call(options, { type: 'TWE_BACKUP_STATUS' })).failed)
      .toBe(1);
    await page.close();
    const cdp = await context.newCDPSession(options);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await expect
      .poll(async () => (await call(options, { type: 'TWE_BACKUP_STATUS' })).pending)
      .toBe(1);
    offline = false;
    await call(options, { type: 'TWE_BACKUP_RETRY' });
    await expect.poll(() => files.has(filePath('Offline'))).toBe(true);
    await expect
      .poll(async () => (await call(options, { type: 'TWE_BACKUP_STATUS' })).pending)
      .toBe(0);
    expect(JSON.stringify(await call(options, { type: 'TWE_BACKUP_STATUS' }))).not.toContain(KEY);
    page = await context.newPage();
    const privacy = await context.newCDPSession(page);
    const contexts: { id: number; origin: string }[] = [];
    privacy.on('Runtime.executionContextCreated', (event) => contexts.push(event.context));
    await privacy.send('Runtime.enable');
    await page.goto(savedUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#twe-threads-panel')).toContainText('북마크');
    const isolated = contexts.find((item) => item.origin === `chrome-extension://${id}`)!;
    expect(isolated).toBeDefined();
    const result = await privacy.send('Runtime.evaluate', {
      contextId: isolated.id,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async()=>{let denied=false;try{await chrome.storage.local.get('vaultBackupApi')}catch{denied=true}
      const config=await chrome.runtime.sendMessage({type:'TWE_BACKUP_CONFIG_SET',enabled:false,scope:'tweets'});
      const x=await chrome.runtime.sendMessage({type:'TWE_BACKUP_ENQUEUE',module:'BookmarksModule',records:[]});
      return {denied,canChange:config?.ok===true,canSendX:x?.ok===true};})()`,
    });
    expect(result.result.value).toEqual({ denied: true, canChange: false, canSendX: false });
    await options.reload();
    await expect(options.locator('#threads-enabled')).toBeChecked();
    await options.screenshot({ path: 'test-results/threads-backup-settings.png', fullPage: true });
    await options.locator('#threads-enabled').uncheck();
    await options.locator('#apply').click();
    await expect
      .poll(async () => (await call(options, { type: 'TWE_BACKUP_STATUS' })).config.threadsEnabled)
      .toBe(false);
    await page.evaluate(
      (html) => document.querySelector('main')!.insertAdjacentHTML('beforeend', html),
      card('Paused', 'Threads만 백업 정지'),
    );
    await expect(page.locator('#twe-threads-panel')).toContainText('Threads 저장 게시물 포함');
    expect(files.has(filePath('Paused'))).toBe(false);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
