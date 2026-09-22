import '../main';
import { db } from '@/core/database';
import { getBridge } from './state';

const bridge = getBridge();
bridge.getCounts = () => db.count();
bridge.ready = true;

import { getBackupConfig, notifyTweetsCaptured } from '@/backup/client';
import { BACKUP_MODULES, acceptsModule } from '@/backup/types';
let replaying: Promise<void> | undefined;
async function replayExisting() {
  const cfg = await getBackupConfig();
  if (!cfg.enabled || bridge.error) return;
  bridge.backupError = '';
  for (const name of BACKUP_MODULES.filter((name) => acceptsModule(cfg.scope, name))) {
    for (let offset = 0; !bridge.error; offset += 100) {
      const current = await getBackupConfig();
      if (!current.enabled || current.destinationId !== cfg.destinationId) return;
      const page = await db.extGetBackupTweets(name, offset);
      await notifyTweetsCaptured(name, page.tweets);
      if (page.count < 100) break;
    }
  }
}
bridge.backupReplay = () => {
  if (!replaying)
    replaying = replayExisting().finally(() => {
      replaying = undefined;
    });
  return replaying;
};
void bridge.backupReplay().catch((error) => {
  bridge.backupError = error instanceof Error ? error.message : '기존 데이터 백업 실패';
});
