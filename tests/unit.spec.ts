import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHANNEL, isCaptureUrl, isCapturePacket, isXPage } from '../src/extension/protocol';
import { csvExporter, jsonExporter } from '../src/utils/exporter';
import { compareSortIndex } from '../src/utils/api';

const url = 'https://x.com/i/api/graphql/test/Bookmarks';
test('capture scope is restricted to supported HTTPS X responses', () => {
  expect(isXPage('https://x.com/i/bookmarks')).toBe(true);
  expect(isXPage('https://example.com/')).toBe(false);
  expect(isCaptureUrl(url)).toBe(true);
  expect(isCaptureUrl('https://x.com/i/api/graphql/test/UnsupportedOperation')).toBe(false);
  const packet = {
    channel: CHANNEL,
    type: 'response',
    method: 'GET',
    url,
    status: 200,
    responseText: '{}',
    accountId: '42',
  };
  expect(isCapturePacket(packet)).toBe(true);
  expect(isCapturePacket({ ...packet, status: 429 })).toBe(false);
  expect(isCapturePacket({ ...packet, responseText: null })).toBe(false);
});

test('exporters preserve Unicode and large string IDs', async () => {
  const rows = [{ id: '9007199254740993', text: '한글 본문', empty: null }];
  expect(JSON.parse(await jsonExporter(rows))).toEqual(rows);
  expect(await csvExporter(rows)).toContain('한글 본문');
  expect(compareSortIndex('9007199254740993', '9007199254740992')).toBe(-1);
});

test('Manifest V3 package is self-contained with narrow permissions', () => {
  const dir = resolve('dist/chrome');
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['activeTab', 'storage', 'alarms']);
  expect(manifest.optional_host_permissions).toEqual([
    'https://127.0.0.1/*',
    'https://localhost/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ]);
  expect(manifest.background.service_worker).toBe('background.js');
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts.map((s: { world: string }) => s.world)).toEqual([
    'ISOLATED',
    'MAIN',
  ]);
  for (const s of manifest.content_scripts) {
    expect(s.run_at).toBe('document_start');
    expect(s.matches).not.toContain('<all_urls>');
    for (const file of [...s.js, ...(s.css ?? [])])
      expect(existsSync(resolve(dir, file))).toBe(true);
  }
  expect(existsSync(resolve(dir, 'app.js'))).toBe(true);
  expect(existsSync(resolve(dir, 'THIRD_PARTY_NOTICES.txt'))).toBe(true);
  const app = readFileSync(resolve(dir, 'app.js'), 'utf8');
  expect(app).not.toContain('GM_registerMenuCommand');
  expect(app).not.toContain('cdn.jsdelivr.net');
});

test('lookalike hosts and non-HTTPS URLs are excluded', () => {
  expect(isXPage('https://x.com.example.org/')).toBe(false);
  expect(isXPage('http://x.com/')).toBe(false);
  expect(isXPage('https://mobile.x.com/')).toBe(true);
  expect(isCaptureUrl('https://x.com/settings/account')).toBe(false);
});

test('bridge rejects oversized payloads and invalid account identities', () => {
  const packet = {
    channel: CHANNEL,
    type: 'response',
    method: 'GET',
    url,
    status: 200,
    responseText: '{}',
    accountId: '42',
  };
  expect(isCapturePacket({ ...packet, accountId: {} })).toBe(false);
  expect(isCapturePacket({ ...packet, status: 200.5 })).toBe(false);
  expect(isCapturePacket({ ...packet, responseText: 'x'.repeat(8 * 1024 * 1024 + 1) })).toBe(false);
});

test('browser bundle has no unresolved Node environment references', () => {
  const app = readFileSync(resolve('dist/chrome/app.js'), 'utf8');
  expect(app).not.toContain('process.env.NODE_ENV');
});
