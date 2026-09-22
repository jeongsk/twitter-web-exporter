# Obsidian Local REST API 자동 백업

## 현재 상태 — 2026-09-22

Chrome 빌드 `1.4.3-chrome.3`에 구현했다. 실행 초안이 아니라 `src/backup/`과
`src/extension/background.ts`가 실제 Chrome 번들에 포함된다. 기존 한국어 UI와 UserScript 빌드도 유지한다.
`~/wiki`에 Local REST API with MCP 5.2.0이 설치·활성화되어 있음을 확인했다.
HTTPS는 27124, HTTP는 비활성화된 상태였다. 실제 API 키는 브라우저 설정에 자동 입력하지 않았다.
로컬 HTTPS 상태 확인은 curl의 인증서 신뢰 오류로 종료되었다. 인증서 검증을 우회하지 않았다.
실제 볼트에 노트를 쓰거나 자동 백업을 켜지는 않았다. 아래 연결 절차를 마쳐야 실제로 동작한다.

## 연결

1. `chrome://extensions`에서 Twitter Web Exporter를 새로고침하고 X 탭도 새로고침한다.
2. 툴바 팝업의 **Obsidian 자동 백업**을 누른다. X 제어판의 설정에서도 열 수 있다.
3. Obsidian 플러그인 설정의 인증서 안내에 따라 로컬 CA를 신뢰한다. 인증서 검증은 끄지 않는다.
4. 주소 `https://127.0.0.1:27124`와 플러그인의 API 키를 확장 프로그램 설정에 입력한다.
5. 저장 폴더 `raw/articles/twitter-web-exporter`의 Git·클라우드·공개 범위를 확인한다.
6. 동의 체크 → **연결 확인 · 저장** → **자동 백업 사용** → **백업 설정 적용**.

API 키는 채팅·코드·문서·노트에 적지 않는다. 키를 다시 입력하지 않으면 저장된 값을 사용한다.
연결할 주소를 바꾸는 경우에는 키를 다시 입력해야 한다. 목적지·키 변경 시 백업은 일시 정지된다.
HTTP를 사용하는 경우는 플러그인에서 직접 활성화했을 때뿐이다. 확장 프로그램이 자동 활성화하지 않는다.

## 저장되는 자료

기본은 북마크다. 옵션으로 수집한 전체 게시물 범위를 선택할 수 있다.
본문·작성자·게시 시각·출처 URL·인용/재게시 원문·외부 링크·미디어 URL을 Markdown으로 만든다.
`source_url`, `source_id`, `published`, `ingested`, `sha256` 등의 YAML 속성을 포함한다.

```text
raw/articles/twitter-web-exporter/
  x-<게시물 ID>.md
  revisions/x-<게시물 ID>-<내용 SHA256>.md
```

동일 ID·같은 내용은 건너뛴다. 카운터(좋아요·조회수)는 해시에 넣지 않는다.
기존 파일을 읽어 다른 내용이면 변경본으로 분리한다. 저장 후 다시 읽어 체크섬을 검증한다.
일반적인 기존 파일·수동 편집은 보존하지만, API의 PUT은 생성 전용이 아니다.
다른 프로그램이 GET과 PUT 사이에 같은 경로를 쓰는 경쟁 조건까지 원자적으로 보호하지는 않는다.
이 폴더는 다른 자동 작성 도구와 공유하지 않는 것이 좋다.

## 큐와 재시도

- 자동 백업을 켜면 열려 있는 X 탭의 기존 수집 자료와 이후 새로 수집하는 게시물을 처리한다.
- 대기열은 확장 프로그램 전용 IndexedDB에 저장된다. 원래 X 사이트의 DB와 분리된다.
- 대기열 저장을 확인한 후 응답한다. X 탭을 닫거나 서비스 워커가 재시작되어도 대기 작업은 남는다.
- 연결 실패 시 1분부터 최대 30분 간격으로 지연한다. Chrome의 1분 알람이 처리할 작업을 확인한다.
- Chrome 종료·절전 중에는 동작하지 않는다. Obsidian은 대상 볼트가 열린 상태여야 한다.
- 대기 작업은 최대 5,000개다. 초과하면 화면/로그에 오류를 표시하며 원래 X DB는 그대로 둔다.
- **실패한 백업 재시도**는 지연된 작업을 다시 처리한다.
- **기존 수집 데이터 추가**는 열려 있는 X 탭의 DB를 다시 스캔한다.
- **저장 파일 다시 확인**은 현재 목적지의 완료 기록만 초기화하고 X DB의 자료를 다시 제출한다.
  실제 노트를 삭제하지 않는다. 볼트에서 지운 백업도 원본이 X DB에 남아 있으면 다시 저장할 수 있다.

## 보안과 공개 범위

API 키는 `chrome.storage.local`의 TRUSTED_CONTEXTS 영역에만 보관한다.
별도 암호화는 아니므로 로컬 Chrome 프로필 자체에 접근하는 프로그램까지 방어하지는 않는다.
설정 변경은 확장 프로그램 전용 페이지에서만 허용하고 X 콘텐츠 스크립트의 변경 요청은 거부한다.
주소는 명시적 포트를 가진 127.0.0.1 또는 localhost에만 허용한다. 리다이렉트·쿠키 전송을 하지 않는다.
원문을 Markdown 텍스트로 이스케이프하여 HTML/위키 임베드/실행 코드 블록으로 해석되지 않도록 한다.
이 기능은 X 게시물 수집 응답만 처리한다. 미로드 북마크를 추가 조회하거나 자동 스크롤하지 않는다.
DM·팔로워/팔로잉 목록·미디어 바이너리·전체 DB 덤프는 자동 백업 대상이 아니다.
볼트의 Git 제외 설정이나 Obsidian Sync 설정은 변경하지 않았다. raw/도 Git에 올라갈 수 있으므로 확인한다.

## 구현 및 검증

`../obsidian-clipper/src/utils/obsidian-note-creator.ts`의 경로 지정과
`src/utils/shared.ts`의 YAML 출처 속성 분리를 참고했다. 참고 프로젝트는 변경하지 않았다.
URI/클립보드/Native Messaging 대신 확장 프로그램 서비스 워커가 Local REST API를 호출한다.

`pnpm check:chrome`: 타입 검사·린트·Chrome 빌드 및 19개 테스트 통과.
기존 `pnpm build`와 `pnpm package:chrome`, ZIP 무결성 검사도 통과했다.
백업 통합 테스트는 새 임시 Chromium 프로필과 로컬 모의 HTTP API를 사용했다.
자동 수집→파일 저장, 중복 제거, 변경본, 실패 후 재시도, X 탭 종료와 서비스 워커 재시작 후 큐 유지,
키 비노출, content script의 저장소 접근 및 설정 변경 거부를 확인했다.
헤드리스 환경의 네이티브 권한 팝업은 클릭할 수 없어, 테스트 사본에만 모의 loopback 접근을 미리 허용했다.
실제 배포 파일은 optional host permission을 유지하며 사용자가 연결 버튼을 눌러 허용해야 한다.
실제 ~/wiki API 키 인증과 실제 볼트 쓰기는 아직 미검증이다. 개인 Chrome 프로필도 변경하지 않았다.

구현 위치: `src/backup/`, `src/extension/background.ts`, `src/extension/backup-options.ts`.
설치 폴더: `dist/chrome`. 배포 ZIP: `release/twitter-web-exporter-chrome-1.4.3.zip`.
화면 검증: `test-results/obsidian-backup-settings.png` (모의 API의 테스트 화면).

## 참고

- https://github.com/coddingtonbear/obsidian-local-rest-api
- https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/main/docs/openapi.yaml
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/reference/api/storage
