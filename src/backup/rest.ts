import { MAX_THREAD_BYTES } from './types';
import { BackupConnectionError } from './connection-errors';
import { fingerprint } from './format';
import type { BackupJob } from './queue';

export type ApiSettings = { endpoint: string; apiKey: string; folder: string };
export const DEFAULT_ENDPOINT = 'https://127.0.0.1:27124';
export const DEFAULT_FOLDER = 'raw/articles/twitter-web-exporter';
const MAX_RESPONSE_BYTES = MAX_THREAD_BYTES + 64 * 1024;

/** Restrict credentials to literal loopback hosts, explicit ports, and no redirects. */
export function normalizeEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/?$/.test(value))
    throw new Error('API 주소는 http(s)://127.0.0.1:포트 또는 localhost:포트 형식이어야 합니다.');
  const url = new URL(value);
  if (Number(url.port) < 1024 || Number(url.port) > 65535)
    throw new Error('API 포트는 1024~65535 범위여야 합니다.');
  return url.origin;
}
export function normalizeFolder(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 400 ||
    !value.split('/').every((part) => /^[a-z0-9][a-z0-9_-]{0,79}$/.test(part))
  )
    throw new Error(
      '저장 폴더는 영문 소문자·숫자·하이픈·밑줄로 구성된 볼트 내부 상대 경로여야 합니다.',
    );
  return value;
}
export function validateApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 1024 ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    throw new Error('Local REST API 설정에 표시된 API 키를 입력하세요.');
  return value;
}
export function permissionOrigin(endpoint: string): string {
  const url = new URL(normalizeEndpoint(endpoint));
  return `${url.protocol}//${url.hostname}/*`;
}
export async function apiDestination(settings: ApiSettings): Promise<string> {
  // Keys are generated separately per vault. A rotated key is an explicit new destination.
  return fingerprint(JSON.stringify([settings.endpoint, settings.folder, settings.apiKey]));
}

async function responseText(response: Response): Promise<string> {
  if (Number(response.headers.get('Content-Length') ?? 0) > MAX_RESPONSE_BYTES)
    throw new Error('API 응답이 허용 크기를 초과했습니다.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '',
    size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error('API 응답이 허용 크기를 초과했습니다.');
      }
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class ObsidianRestClient {
  private settings: ApiSettings;
  constructor(
    settings: ApiSettings,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.settings = {
      endpoint: normalizeEndpoint(settings.endpoint),
      folder: normalizeFolder(settings.folder),
      apiKey: validateApiKey(settings.apiKey),
    };
  }
  private async request(path: string, method: 'GET' | 'PUT' = 'GET', body?: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.settings.endpoint + path, {
          method,
          body,
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            Authorization: `Bearer ${this.settings.apiKey}`,
            Accept: path === '/' ? 'application/json' : 'text/markdown',
            ...(body === undefined ? {} : { 'Content-Type': 'text/markdown; charset=utf-8' }),
          },
        });
      } catch {
        if (controller.signal.aborted)
          throw new BackupConnectionError(
            'Obsidian API 응답 시간이 10초를 초과했습니다. Obsidian 실행 상태와 API 주소·포트를 확인한 뒤 다시 시도하세요.',
            'TIMEOUT',
          );
        // Fetch deliberately hides TLS details. Do not label every network failure a certificate error.
        const secure = this.settings.endpoint.startsWith('https:');
        throw new BackupConnectionError(
          secure
            ? 'HTTPS 연결에 실패했습니다. Obsidian이 실행 중인지와 API 주소·포트를 확인하세요. 아래 「API 상태 페이지 열기」에서 인증서 오류가 표시되면 Local REST API의 CA 인증서를 신뢰 등록해야 합니다.'
            : '로컬 API에 연결할 수 없습니다. Obsidian이 실행 중인지와 API 주소·포트를 확인하세요. HTTP는 플러그인에서 직접 활성화한 경우에만 사용할 수 있습니다.',
          secure ? 'TLS_OR_NETWORK' : 'NETWORK',
        );
      }
      if ([401, 403].includes(response.status))
        throw new BackupConnectionError(
          'Obsidian API 인증에 실패했습니다. 대상 볼트의 Local REST API 설정에서 API 키를 다시 복사해 입력하세요.',
          'AUTH',
        );
      if (response.status === 404 && method === 'GET') return null;
      if (!response.ok)
        throw new BackupConnectionError(
          `Obsidian API 요청 실패 (HTTP ${response.status}). 플러그인 상태를 확인한 뒤 다시 시도하세요.`,
          'HTTP',
        );
      // Never include the response body in logs/errors: an endpoint could reflect the API key.
      try {
        return await responseText(response);
      } catch {
        throw new BackupConnectionError(
          controller.signal.aborted
            ? 'Obsidian API 응답 읽기가 10초를 초과했습니다. 앱 상태를 확인한 뒤 다시 시도하세요.'
            : 'Obsidian API 응답을 읽지 못했습니다. 연결이 중단되었거나 응답 크기가 너무 큽니다.',
          controller.signal.aborted ? 'TIMEOUT' : 'RESPONSE',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  private fileUrl(path: string): string {
    // All paths are generated inside this class, never forwarded from X/content messages.
    return '/vault/' + path.split('/').map(encodeURIComponent).join('/');
  }
  async connect() {
    const raw = await this.request('/');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw ?? '');
    } catch {
      throw new BackupConnectionError(
        'Obsidian Local REST API 상태 응답이 아닙니다. API 주소·포트를 확인하세요.',
        'RESPONSE',
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new BackupConnectionError(
        'Obsidian Local REST API 상태 응답이 아닙니다. API 주소·포트를 확인하세요.',
        'RESPONSE',
      );
    const data = parsed as {
      service?: unknown;
      authenticated?: unknown;
      versions?: { self?: unknown };
    };
    if (typeof data.service !== 'string' || !data.service.startsWith('Obsidian Local REST API'))
      throw new BackupConnectionError(
        '연결된 서버가 Obsidian Local REST API가 아닙니다. API 주소·포트를 확인하세요.',
        'RESPONSE',
      );
    if (data.authenticated !== true)
      throw new BackupConnectionError(
        '서버에는 연결했지만 API 키 인증에 실패했습니다. 대상 볼트의 Local REST API 설정에서 키를 다시 복사해 입력하세요.',
        'AUTH',
      );
    return {
      ok: true as const,
      endpoint: this.settings.endpoint,
      folder: this.settings.folder,
      pluginVersion: typeof data.versions?.self === 'string' ? data.versions.self : '',
      destinationId: await apiDestination(this.settings),
    };
  }
  private async matches(existing: string, job: BackupJob) {
    if (!existing.startsWith('---\n')) return false;
    const boundary = existing.indexOf('\n---\n', 4);
    if (boundary < 0) return false;
    const front = existing.slice(4, boundary).split('\n');
    return (
      front.includes('generator: "twitter-web-exporter"') &&
      (job.platform === 'threads'
        ? front.includes('source_platform: "threads"') &&
          front.includes(`source_key: "threads-${job.id}"`)
        : job.platform === 'youtube'
          ? front.includes('source_platform: "youtube"') &&
            front.includes(`source_key: "youtube-${job.id}"`)
          : front.includes(`source_id: "${job.id}"`)) &&
      (await fingerprint(
        existing.slice(boundary + 5),
        job.kind === 'thread' ? MAX_THREAD_BYTES : 512 * 1024,
      )) === job.hash
    );
  }
  async write(job: BackupJob) {
    if (
      !(job.platform === 'threads'
        ? /^(?:[0-9a-f]{2}){1,32}$/.test(job.id)
        : job.platform === 'youtube'
          ? /^[\w-]{11}$/.test(job.id)
          : /^\d{1,30}$/.test(job.id)) ||
      !/^[a-f0-9]{64}$/.test(job.hash) ||
      typeof job.markdown !== 'string' ||
      new TextEncoder().encode(job.markdown).length >
        (job.kind === 'thread' ? MAX_THREAD_BYTES : 600 * 1024) ||
      !(await this.matches(job.markdown, job))
    )
      throw new Error('백업 작업의 ID 또는 체크섬이 올바르지 않습니다.');
    if (job.target !== (await apiDestination(this.settings)))
      throw new Error('백업 저장 위치가 변경되었습니다.');
    // Threads/YouTube ids are [A-Za-z0-9_-] only, so they are safe path segments as-is.
    const prefix = job.platform ?? 'x';
    const folder = job.platform ? `${this.settings.folder}/${job.platform}` : this.settings.folder;
    const base = `${folder}/${prefix}-${job.id}.md`;
    const old = await this.request(this.fileUrl(base));
    if (old !== null && (await this.matches(old, job)))
      return { path: base, result: 'existing' as const };
    const path = old === null ? base : `${folder}/revisions/${prefix}-${job.id}-${job.hash}.md`;
    if (old !== null) {
      const revision = await this.request(this.fileUrl(path));
      if (revision !== null) {
        if (await this.matches(revision, job)) return { path, result: 'existing' as const };
        throw new Error(
          '변경본 경로에 다른 내용의 파일이 있습니다. 기존 파일을 보존하고 백업을 중단했습니다.',
        );
      }
    }
    // The documented API has no create-only PUT. GET guards existing files; the single worker
    // serializes this client's writes. Concurrent writes by OTHER clients are not atomic.
    await this.request(this.fileUrl(path), 'PUT', job.markdown);
    const written = await this.request(this.fileUrl(path));
    if (written === null || !(await this.matches(written, job)))
      throw new Error('파일 저장 후 체크섬을 확인하지 못했습니다. 대기열에서 재시도합니다.');
    return { path, result: old === null ? ('created' as const) : ('revision' as const) };
  }
}
