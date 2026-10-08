import Dexie, { type Table } from 'dexie';
import type { BackupRecord } from './types';
import type { ThreadsPost } from '@/threads/model';
export interface BackupJob {
  key: string;
  target: string;
  id: string;
  hash: string;
  kind?: 'thread';
  platform?: 'threads' | 'youtube';
  replyCount?: number;
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
export interface ThreadItem {
  key: string;
  thread: string;
  record: BackupRecord;
  limited?: boolean;
}
export interface ThreadsItem {
  key: string;
  thread: string;
  post: ThreadsPost;
  limited: boolean;
}
export class BackupDatabase extends Dexie {
  jobs!: Table<BackupJob, string>;
  threadItems!: Table<ThreadItem, string>;
  threadsItems!: Table<ThreadsItem, string>;
  constructor() {
    super('twitter-web-exporter-vault-backup');
    this.version(1).stores({ jobs: 'key,state,due,target,[target+state]' });
    this.version(2).stores({ threadItems: 'key,thread' });
    this.version(3).stores({ threadsItems: 'key,thread' });
  }
}
