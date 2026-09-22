import Dexie, { type Table } from 'dexie';
export interface BackupJob {
  key: string;
  target: string;
  id: string;
  hash: string;
  markdown?: string;
  state: 'pending' | 'done';
  modules: string[];
  due: number;
  attempts: number;
  error: string;
  path?: string;
  completedAt?: number;
  createdAt: number;
}
export class BackupDatabase extends Dexie {
  jobs!: Table<BackupJob, string>;
  constructor() {
    super('twitter-web-exporter-vault-backup');
    this.version(1).stores({ jobs: 'key,state,due,target,[target+state]' });
  }
}
