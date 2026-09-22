import { fingerprint } from './format';
import type { BackupJob } from './queue';

export type ApiSettings = { endpoint: string; apiKey: string; folder: string };
export const DEFAULT_ENDPOINT = 'https://127.0.0.1:27124';
export const DEFAULT_FOLDER = 'raw/articles/twitter-web-exporter';
const MAX_RESPONSE_BYTES = 750 * 1024;

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
        throw new Error(
          'Obsidian API에 연결할 수 없습니다. 앱 실행·포트·로컬 접근 권한·HTTPS 인증서를 확인하세요.',
        );
      }
      if ([401, 403].includes(response.status))
        throw new Error('Obsidian API 인증에 실패했습니다. API 키와 플러그인 설정을 확인하세요.');
      if (response.status === 404 && method === 'GET') return null;
      if (!response.ok) throw new Error(`Obsidian API 요청 실패 (HTTP ${response.status}).`);
      // Never include the response body in logs/errors: an endpoint could reflect the API key.
      return await responseText(response);
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
    let data: { service?: string; authenticated?: boolean; versions?: { self?: string } };
    try {
      data = JSON.parse(raw ?? '');
    } catch {
      throw new Error('Obsidian Local REST API 상태 응답이 아닙니다.');
    }
    if (data.authenticated !== true || !data.service?.startsWith('Obsidian Local REST API'))
      throw new Error('Obsidian API 인증 상태를 확인하지 못했습니다.');
    return {
      ok: true as const,
      endpoint: this.settings.endpoint,
      folder: this.settings.folder,
      pluginVersion: data.versions?.self ?? '',
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
      front.includes(`source_id: "${job.id}"`) &&
      (await fingerprint(existing.slice(boundary + 5))) === job.hash
    );
  }
  async write(job: BackupJob) {
    if (
      !/^\d{1,30}$/.test(job.id) ||
      !/^[a-f0-9]{64}$/.test(job.hash) ||
      typeof job.markdown !== 'string' ||
      job.markdown.length > 600 * 1024 ||
      !(await this.matches(job.markdown, job))
    )
      throw new Error('백업 작업의 ID 또는 체크섬이 올바르지 않습니다.');
    if (job.target !== (await apiDestination(this.settings)))
      throw new Error('백업 저장 위치가 변경되었습니다.');
    const base = `${this.settings.folder}/x-${job.id}.md`;
    const old = await this.request(this.fileUrl(base));
    if (old !== null && (await this.matches(old, job)))
      return { path: base, result: 'existing' as const };
    const path =
      old === null ? base : `${this.settings.folder}/revisions/x-${job.id}-${job.hash}.md`;
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
