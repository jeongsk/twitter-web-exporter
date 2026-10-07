import { test, expect } from '@playwright/test';
import {
  AUTO_EMPTY_STEPS,
  AUTO_IDLE_STEPS,
  AUTO_KNOWN_LIMIT,
  AUTO_MAX_STEPS,
  autoStep,
  bookmarkIds,
  knownFromJobs,
  mergeKnown,
  normalizeInterval,
  type AutoSession,
} from '../src/backup/auto-collect';
import { threadsStorageId } from '../src/threads/model';
import { fixture } from './fixture';

const session = (): AutoSession => ({
  platform: 'x',
  tabId: 1,
  startedAt: 0,
  known: [],
  seen: [],
  fresh: 0,
  idle: 0,
  steps: 0,
});

test('bookmark ids come from timeline entries in response order', () => {
  const page = fixture('1001');
  const entries = page.data.bookmark_timeline_v2.timeline.instructions[0]!.entries;
  entries.push({ ...entries[0]!, entryId: 'tweet-1002' });
  entries.push({ ...entries[0]!, entryId: 'cursor-bottom-123' });
  expect(bookmarkIds(JSON.stringify(page))).toEqual(['1001', '1002']);
});

test('auto step stops at the first previously saved id', () => {
  const first = autoStep(session(), ['3', '2'], new Set());
  expect(first.stop).toBeUndefined();
  expect(first.session.fresh).toBe(2);
  const second = autoStep(first.session, ['3', '2', '1', '0'], new Set(['0']));
  expect(second.stop).toBe('known');
  expect(second.session.fresh).toBe(3);
  expect(second.session.seen).toEqual(['3', '2', '1', '0']);
});

test('auto step stops when scrolling yields nothing new or the limit is reached', () => {
  let state = autoStep(session(), ['1'], new Set()).session;
  for (let i = 1; i < AUTO_IDLE_STEPS; i++) {
    const step = autoStep(state, ['1'], new Set());
    expect(step.stop).toBeUndefined();
    state = step.session;
  }
  expect(autoStep(state, ['1'], new Set()).stop).toBe('exhausted');
  let busy = session();
  let stop;
  for (let i = 0; i < AUTO_MAX_STEPS && !stop; i++)
    ({ session: busy, stop } = autoStep(busy, [`${i}`], new Set()));
  expect(stop).toBe('limit');
  expect(busy.fresh).toBe(AUTO_MAX_STEPS);
});

test('a slow first load is waited for, but a page without any item ends', () => {
  let state = session();
  for (let i = 1; i < AUTO_EMPTY_STEPS; i++) {
    const step = autoStep(state, [], new Set());
    expect(step.stop).toBeUndefined();
    state = step.session;
  }
  expect(autoStep(state, ['1'], new Set()).stop).toBeUndefined();
  expect(autoStep(state, [], new Set()).stop).toBe('empty');
});

test('known ids come only from bookmark and Threads saved jobs', () => {
  const jobs = [
    { key: 'dest:1001:aaaa', modules: ['BookmarksModule'] },
    // Saved from the home timeline under the "all posts" scope: may be bookmarked later.
    { key: 'dest:1002:aaaa', modules: ['HomeTimelineModule'] },
    { key: `dest:threads:${threadsStorageId('Case_A1')}:bbbb`, modules: ['ThreadsSavedModule'] },
    { key: 'dest:not-a-tweet:cccc', modules: ['BookmarksModule'] },
  ];
  expect(knownFromJobs(jobs, 'x')).toEqual(['1001']);
  expect(knownFromJobs(jobs, 'threads')).toEqual(['Case_A1']);
  const many = Array.from({ length: AUTO_KNOWN_LIMIT }, (_, i) => `${i}`);
  const merged = mergeKnown(many, ['new', '0']);
  expect(merged).toHaveLength(AUTO_KNOWN_LIMIT);
  expect(merged.slice(0, 3)).toEqual(['new', '0', '1']);
});

test('collection interval accepts only offered choices', () => {
  expect(normalizeInterval(6)).toBe(6);
  expect(normalizeInterval(0)).toBe(0);
  expect(normalizeInterval(2)).toBe(3);
  expect(normalizeInterval('3')).toBe(3);
  expect(normalizeInterval(undefined)).toBe(3);
});
