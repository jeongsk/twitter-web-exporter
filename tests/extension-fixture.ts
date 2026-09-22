import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Copy the built extension into a disposable test profile. Headless Chromium cannot
 * click its native host-permission prompt. Only the MOCK loopback server is granted
 * in this throwaway copy; neither dist/chrome nor the user's Chrome profile changes.
 * Production optional permissions are verified separately in unit.spec.ts.
 */
export async function extensionFixture(profile: string) {
  const destination = join(profile, 'fixture-extension');
  await cp(resolve('dist/chrome'), destination, { recursive: true });
  const manifestPath = join(destination, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return destination;
}
