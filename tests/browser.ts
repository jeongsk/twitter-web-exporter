import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function browserPath(): string | undefined {
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
