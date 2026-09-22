import {
  ObsidianRestClient,
  normalizeEndpoint,
  normalizeFolder,
  validateApiKey,
  permissionOrigin,
  apiDestination,
  type ApiSettings,
} from './rest';
import type { BackupConfig } from './types';

/** Called only after the worker verifies the sender is its own settings page. */
export async function saveApiSettings(
  message: Record<string, unknown>,
  previous: ApiSettings | null,
  current: BackupConfig,
) {
  const endpoint = normalizeEndpoint(message.endpoint);
  const folder = normalizeFolder(message.folder);
  const input = message.apiKey;
  const saved = previous?.endpoint === endpoint ? previous.apiKey : '';
  const apiKey = validateApiKey(input || saved);
  if (message.privacyAcknowledged !== true)
    throw new Error('볼트 동기화·공개 범위를 확인하고 동의 체크박스를 선택하세요.');
  const permitted = await chrome.permissions.contains({ origins: [permissionOrigin(endpoint)] });
  if (!permitted) throw new Error('로컬 API 접근 권한을 허용하세요.');
  const api = { endpoint, folder, apiKey };
  const connected = await new ObsidianRestClient(api).connect();
  const destinationId = await apiDestination(api);
  const config = {
    ...current,
    destinationId,
    enabled: current.destinationId === destinationId && current.enabled,
  };
  await chrome.storage.local.set({
    vaultBackupConfig: config,
    vaultBackupApi: api,
    backupPluginVersion: connected.pluginVersion,
    lastBackupError: '',
  });
}
