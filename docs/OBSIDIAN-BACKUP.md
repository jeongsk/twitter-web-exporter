# Obsidian Local REST API 자동 백업

## 현재 상태 — 2026-09-23

Chrome 빌드 `1.4.3-chrome.5`에 북마크 원문·댓글·대댓글 묶음 백업을 추가했다.
이전 chrome.4의 연결 오류 표시 개선도 유지한다.
연결 버튼 바로 아래에 오류를 유지하며, 3초 상태 갱신이나 이전의 15초 표시 제한으로 지우지 않는다.
권한 확인, API 인증 확인, 성공·실패를 단계별로 표시한다. 권한 대기는 20초,
설정 페이지의 서비스 워커 응답 대기는 15초, API 요청은 10초로 제한한다.

실제 `~/wiki`에 설치된 Local REST API with MCP 5.2.0을 읽기 전용으로 점검했다.
기본 신뢰 저장소에서는 HTTPS 인증서 오류가 발생했고, 별도 Chromium에서도
`net::ERR_CERT_AUTHORITY_INVALID`가 재현되었다. 플러그인의 CA를 해당 검사에만 명시한
Python TLS 검증에서는 HTTP 200 및 `authenticated: true`를 확인했다.
볼트에 저장된 API 키는 이 검사에서만 메모리로 사용했고 출력·소스·배포 ZIP에 포함하지 않았다.

신뢰 등록에 사용할 공개 CA 인증서는 `~/Downloads/obsidian-local-rest-api-ca.crt`에 저장했다.
인증서명은 `Obsidian Local REST API CA`다. 시스템/로그인 키체인의 신뢰 설정을
변경하지 않았으며 HTTP 서버도 켜지 않았다. 실제 볼트 파일 쓰기·자동 백업 활성화는 하지 않았다.
사용자 Chrome에서 해당 CA 신뢰 등록 및 연결 확인이 남아 있다.

## 연결

1. `chrome://extensions`에서 Twitter Web Exporter를 새로고침하고 X 탭도 새로고침한다.
2. 툴바 팝업의 **Obsidian 자동 백업**을 누른다. X 제어판의 설정에서도 열 수 있다.
3. Obsidian 플러그인 설정의 인증서 안내에 따라 로컬 CA를 신뢰한다. 현재 Mac에는 공개 CA를 `~/Downloads/obsidian-local-rest-api-ca.crt`로 추출했다. 키체인에서 해당 CA를 신뢰 등록한 다음 Chrome을 다시 시작한다. 인증서 검증은 끄지 않는다.
4. 주소 `https://127.0.0.1:27124`와 플러그인의 API 키를 확장 프로그램 설정에 입력한다.
5. 저장 폴더 `raw/articles/twitter-web-exporter`의 Git·클라우드·공개 범위를 확인한다.
6. 동의 체크 → **연결 확인 · 저장** → **자동 백업 사용** → **백업 설정 적용**.

API 키는 채팅·코드·문서·노트에 적지 않는다. 키를 다시 입력하지 않으면 저장된 값을 사용한다.
연결할 주소를 바꾸는 경우에는 키를 다시 입력해야 한다. 목적지·키 변경 시 백업은 일시 정지된다.
HTTP를 사용하는 경우는 플러그인에서 직접 활성화했을 때뿐이다. 확장 프로그램이 자동 활성화하지 않는다.

## 북마크 댓글 묶음

북마크는 원문과 연결된 댓글·대댓글을 한 Markdown 스냅샷으로 보관한다.
북마크 원문에서 댓글을 불러오면 북마크 전용 백업 모드에서도 자동으로 함께 처리한다.
추가 댓글은 원문 및 기존 댓글과 함께 revisions/의 새 스냅샷에 들어간다. 기존 raw 파일은 보존한다.
전체 댓글 자동 조회는 하지 않으며, 수집 개수와 미완료 상태를 파일에 명시한다.
상세 동작·제한·검증은 [BOOKMARK-THREADS.md](BOOKMARK-THREADS.md)를 참고한다.

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

## 주기 자동 수집 — 2026-10-07

- 설정 페이지 「3. 자동 수집」에서 주기(끄기·1·3·6·12·24시간, 기본 3시간)를 고르고 「지금 수집」으로 즉시 실행할 수 있다.
- 주기마다 `chrome.alarms`(`twe-auto-collect`)가 `https://x.com/i/bookmarks`, `https://www.threads.com/saved`, `https://www.youtube.com/playlist?list=LL`(YouTube 좋아요)을 차례로 비활성 탭으로 연다.
- Threads·YouTube 목록은 각 백업 체크박스가 켜져 있을 때만 연다(chrome.10부터). 꺼진 목록을 열면 그 id가 「이미 본 항목」으로 기록되어, 나중에 백업을 켰을 때 첫 수집이 곧바로 멈추기 때문이다. 결과에는 「실행 안 함」으로 표시한다.
- 탭의 content script가 2.5초 간격으로 항목 id를 worker에 보고하고 페이지 끝으로 스크롤한다. X는 `Bookmarks` 응답의 `tweet-<id>` 항목을, Threads는 화면의 게시물 코드를, YouTube는 11자 영상 ID를 쓴다.
- 다음 중 하나가 되면 멈추고, 저장 중인 요청을 위해 4초 기다린 뒤 탭을 닫는다.
  - 이전 실행에서 본 id나 백업 대기열에 있던 id가 나옴(탭을 열기 직전 스냅샷 기준)
  - 첫 id가 나온 뒤 연속 3회 새 id 없음
  - 30회 스크롤
  - 3분 초과(watchdog alarm)
- 첫 로딩이 느릴 수 있어 첫 id는 8회(약 20초)까지 기다린다. 그때까지 id가 없으면 로그인되지 않은 것으로 보고 「항목을 찾지 못함」으로 종료한다. 결과는 설정 페이지에 「새 항목 n개 (중단 이유)」로 표시한다.

### Obsidian 연결 끊김

- Obsidian이 꺼져 있으면 노트는 기존 대기열에 남아 재시도한다.
- 백업이 켜져 있으면 1분 alarm에서 5분마다 `GET /`로 연결을 확인한다. 네트워크 오류·시간 초과(`NETWORK`, `TLS_OR_NETWORK`, `TIMEOUT`)만 끊김으로 본다. 인증 오류는 해당하지 않는다.
- 끊김이 1시간을 넘으면 Chrome 알림을 한 번 표시한다. 알림을 누르면 설정 페이지가 열린다.
- 다시 연결되면 알림을 지우고, 재시도 대기 중인 노트를 즉시 처리한다.

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

`pnpm check:chrome`: 타입 검사·린트·Chrome 빌드 및 23개 테스트 통과.
연결 오류 위치·상태 갱신 후 오류 유지·권한 거부·잘못된 API 키·권한/워커 무응답 회귀 테스트를 추가했다.
기존 `pnpm build`와 `pnpm package:chrome`, ZIP 무결성 검사도 통과했다.
백업 통합 테스트는 새 임시 Chromium 프로필과 로컬 모의 HTTP API를 사용했다.
자동 수집→파일 저장, 중복 제거, 변경본, 실패 후 재시도, X 탭 종료와 서비스 워커 재시작 후 큐 유지,
키 비노출, content script의 저장소 접근 및 설정 변경 거부를 확인했다.
헤드리스 환경의 네이티브 권한 팝업은 클릭할 수 없어, 테스트 사본에만 모의 loopback 접근을 미리 허용했다.
실제 배포 파일은 optional host permission을 유지하며 사용자가 연결 버튼을 눌러 허용해야 한다.
실제 ~/wiki API 키 인증은 CA를 명시한 읽기 전용 TLS 검사에서 검증했다. 실제 볼트 쓰기는 미검증이며 개인 Chrome 프로필은 변경하지 않았다.

구현 위치: `src/backup/`, `src/extension/background.ts`, `src/extension/backup-options.ts`.
설치 폴더: `dist/chrome`. 배포 ZIP: `release/twitter-web-exporter-chrome-1.4.3.zip`.
화면 검증: `test-results/obsidian-backup-settings.png` (모의 API의 테스트 화면).

## 참고

- https://github.com/coddingtonbear/obsidian-local-rest-api
- https://raw.githubusercontent.com/coddingtonbear/obsidian-local-rest-api/main/docs/openapi.yaml
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/reference/api/storage

## 연결 오류 안내

- 「연결 확인에 실패했습니다」와 구체적인 사유는 연결 버튼 바로 아래에 표시된다.
- 키 미입력·동의 미확인·권한 거부도 그 자리에서 안내하고 잘못된 입력에 표시한다.
- HTTP 200이어도 `authenticated: false`이면 API 키 인증 실패로 안내한다.
- 브라우저 fetch는 TLS 오류와 다른 네트워크 오류의 세부 원인을 제공하지 않는다.
  따라서 HTTPS 실패는 인증서 오류로 단정하지 않고 「API 상태 페이지 열기」로 확인하도록 안내한다.
- 연결에 성공한 뒤에만 「연결 확인 완료」로 바꾸며, 저장된 연결 설정과 실시간 연결 상태를 구분한다.
- API 상태 페이지 링크에는 API 키나 다른 인증 정보를 넣지 않는다.

공식 인증서 신뢰 안내: https://support.apple.com/ko-kr/guide/keychain-access/kyca11871/mac

## Threads 저장 게시물 지원 — 2026-09-23

Chrome `1.4.3-chrome.6`에 Threads /saved 자동 백업을 추가했다.
별도 Threads 체크박스를 켜면 기존 Obsidian 연결을 재사용해 `threads/`에 분리 저장한다.
전체 39개 테스트 및 두 빌드·배포 ZIP 검증 통과. 사용 범위·제약은 `docs/THREADS-BACKUP.md` 참고.
실사용 Threads 계정과 볼트 파일에는 접근하거나 쓰지 않았다.

## YouTube 좋아요 영상 지원 — 2026-10-08

Chrome `1.4.3-chrome.10`에 YouTube 좋아요 목록(`playlist?list=LL`) 자동 백업을 추가했다.
`YouTube 좋아요 영상도 자동 백업` 체크박스(기본 꺼짐)를 켜면 기존 Obsidian 연결을 재사용해 `youtube/`에 분리 저장한다.
영상 파일이 아닌 제목·채널·길이·링크 메타데이터만 저장한다. 사용 범위·제약은 `docs/YOUTUBE-BACKUP.md` 참고.
