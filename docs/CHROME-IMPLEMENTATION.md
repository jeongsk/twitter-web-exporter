# Chrome 확장 프로그램 전환 기록

## 목표

기존 UserScript 수집·DB·내보내기 기능을 재사용하는 Manifest V3 확장 프로그램.
원래 `bun run build` / `pnpm build` UserScript 빌드는 보존한다.

## 결정

- `page.js`: document_start / MAIN에서 XHR와 fetch 응답만 관찰한다. 추가 X API 요청, 인증 토큰·쿠키 수집은 하지 않는다.
- `content.js`: document_start / ISOLATED에서 메시지 검증과 초기 응답 버퍼링을 한다.
- `app.js`: 격리된 content script의 동적 import로 로드하는 번들. Preact UI·기존 19개 모듈·Dexie를 재사용한다.
- `popup.html`: Chrome 툴바의 한국어 제어 메뉴. activeTab만 명시적 권한으로 사용한다.
- 실행 라이브러리와 CSS는 패키지에 포함한다. 원격 실행 코드는 사용하지 않는다.
- 저장소는 기존과 동일한 사이트 origin의 IndexedDB/localStorage다. extension-private 저장소가 아니며, 같은 origin에서 기존 자료를 재사용한다. origin 간 자동 이동은 하지 않는다.
- 페이지 메시지는 신뢰하지 않는다. 소스·origin·형식·크기·허용 API를 검사한다. 페이지가 메시지를 위조할 수 있다는 한계는 남으며, 이 경로는 privileged API 실행 권한을 제공하지 않는다.
- 원본 소스의 MIT 저작권 고지를 보존한다. 스토어 제출/게시, 사용자 Chrome 프로필 변경, 실계정 데이터 수집은 이 작업에 포함하지 않는다.

## 구현 체크리스트

- [x] 플랫폼 어댑터 / MAIN-ISOLATED 브리지
- [x] MV3 manifest / 자체 포함 번들 / 한국어 팝업
- [x] 기존 빌드 및 DB 이름·스키마 유지 (실사용 DB를 열어보는 검증은 하지 않음)
- [x] HTML 출력 안전성, 다운로드 간격과 HTTP 오류 처리 보강
- [x] 타입 검사 / 린트 / 단위·브라우저 통합 검증
- [x] 설치용 폴더·ZIP / 설치·제약 문서

## 상속되는 제약

수동 스크롤 기반 수집, 대상 계정·검색어별 수집 구분 부족, DM 비정상 안내,
대용량 ZIP 메모리 사용, X 응답 구조 변경에 대한 후속 대응 필요.

## 검증 결과 — 2026-09-22

| 검증                                               | 결과                         |
| -------------------------------------------------- | ---------------------------- |
| `pnpm typecheck`                                   | 통과                         |
| `pnpm lint`                                        | 통과                         |
| `pnpm build:chrome`                                | 통과, `dist/chrome` 생성     |
| Playwright 단위 테스트                             | 6개 통과                     |
| Playwright 실제 Chromium 확장 프로그램 통합 테스트 | 1개 통과                     |
| 기존 `pnpm build`                                  | 통과, `dist/userscript` 생성 |
| `pnpm package:chrome` 및 `unzip -t`                | 통과                         |

브라우저 통합 검증: Manifest V3 실제 로드, strict CSP의 모의 X 페이지, 초기 fetch 응답,
XHR/fetch 응답 수집, ID 중복 제거, 실패 응답·미지원 API 제외, 새로고침 후 DB 지속,
격리된 bridge 전역, 확장 팝업 페이지에서의 상태 조회·제어판 토글·설정 열기,
JSON/CSV/HTML 파일 다운로드, 계정 ID 변경 감지 시 수집 중단을 확인했다.

페이지와 HTTP 응답은 모의 데이터다. 실계정의 최신 X API 전체 호환성,
모든 모듈의 응답 유형, 실제 동영상/대용량 ZIP 다운로드, 기존 사용자의 백업 복원은 미검증이다.
툴바 메뉴는 popup 페이지와 메시징 경로로 검증했으며 개인 Chrome 프로필에 설치하지 않았다.

## 테스트 중 수정한 문제

- Vite 라이브러리 번들의 `process.env.NODE_ENV` 미치환으로 발생한 테이블 오류를 production 치환으로 수정.
- UserScript 빌드가 Chrome 산출물을 지우지 않도록 `dist/userscript`와 `dist/chrome` 분리.
- DOM 준비 이전에 생성된 handshake 응답으로 계정 DB를 선택하지 않도록 DOM-ready 응답을 구분.
- 테스트에서는 문서 로드 완료 대신 DOMContentLoaded를 기다리고 모든 네트워크를 모의 응답으로 제한.

## 산출물 및 재현

- 설치 폴더: `dist/chrome`
- 배포 ZIP: `release/twitter-web-exporter-chrome-1.4.3.zip`
- 사용자 안내: `docs/CHROME-EXTENSION.md`
- 테스트 소스: `tests/chrome.spec.ts`, `tests/unit.spec.ts`, `tests/fixture.ts`
- 전체 검사: `pnpm check:chrome`
- Bun 잠금 파일도 `bun install --lockfile-only --ignore-scripts`로 새 개발 의존성에 맞춰 갱신했다.
- Git 커밋/푸시, Chrome 웹 스토어 업로드, 사용자 브라우저 설정 변경은 수행하지 않았다.

## 한국어 추가 — 2026-09-22 / 1.4.3-chrome.2

- `src/i18n/locales/ko/common.json` 60개, `exporter.json` 91개: 총 151개 문구 번역.
- `LANGUAGES_CONFIG`에 `Korean - 한국어` 등록. 한국어 지역 코드 `ko-KR` 자동 감지.
- 설정의 시스템 테마 표시와 DB 분석 안내 문구를 번역하고 언어 선택기에 접근성 이름 추가.
- 명시적으로 선택한 기존 언어와 수집 DB는 유지. 한국어 선택 후 새로고침해도 유지됨.
- JSON/CSV 필드 키는 변경하지 않고, HTML 열 제목은 선택한 언어로 내보냄.
- `pnpm check:chrome`: 타입 검사·린트·Chrome 빌드 및 전체 12개 테스트 통과.
- Chromium 테스트에서 영어 → 한국어 전환, 설정 저장, 테이블·내보내기·미디어 UI와 HTML 한국어 헤더 검증.
- 별도 임시 Chromium 프로필에서 한국어 브라우저 최초 실행 자동 감지 검증.
- `pnpm build`와 `pnpm package:chrome` 통과, ZIP 무결성 및 `git diff --check` 통과.
- 스크린샷: `test-results/chrome-settings-ko.png` (모의 X 페이지, 애니메이션 종료 후 촬영).
- 산출물 경로는 기존 `dist/chrome`과 `release/twitter-web-exporter-chrome-1.4.3.zip` 유지.
- 사용자 Chrome 프로필이나 실계정 DB는 열거나 변경하지 않음. 적용 시 확장 프로그램과 X 탭 새로고침 필요.

## Local REST API 자동 백업 — chrome.3

- Chrome worker/전용 설정 페이지, 영속 작업 큐, 게시물 Markdown 변환 및 기존 수집 데이터 재처리를 추가했다.
- storage/alarms 권한과 loopback optional host 권한을 추가했다. API 키는 TRUSTED_CONTEXTS에만 저장한다.
- 기존 한국어 UI·UserScript 호환 빌드를 유지했다. 전체 검사 19개 테스트 통과.
- 테스트 중 native fetch의 receiver 바인딩 문제를 수정하여 실제 worker HTTP 요청을 검증했다.
- 실제 ~/wiki 플러그인 5.2.0 설치 확인. 인증서 신뢰·실제 API 키 입력·실제 볼트 쓰기는 사용자 연결 단계로 남겨두었다.
- 자세한 내용: `OBSIDIAN-BACKUP.md`를 참고한다.

## Obsidian 연결 오류 수정 — 2026-09-23 / chrome.4

- 연결 오류를 버튼 바로 아래 고정 표시; 상태 polling으로 오류가 사라지는 문제 수정.
- 권한/워커 응답 제한시간, 연결 진행 상태, API 키 인증 실패 안내 보강.
- 별도 Chromium에서 실제 localhost TLS 오류(`ERR_CERT_AUTHORITY_INVALID`) 확인.
- 해당 볼트의 CA를 검사에만 명시해 실제 API 인증 성공 확인. 인증서 신뢰 설정·볼트 데이터는 변경하지 않음.
- 공개 CA만 Downloads에 추출; API 키·개인 키는 내보내지 않음.
- 타입 검사, 린트, 기존 기능 포함 23개 테스트, Chrome/UserScript 빌드, ZIP 검사 통과.

## 북마크 댓글 묶음 — 2026-09-23

chrome.5에서 원문·댓글·대댓글을 한 스냅샷으로 저장한다.
부모 ID로 연결하며 추가 수집분은 전체 묶음의 변경본으로 보관한다.
기존 raw 파일·기존 API 설정은 변경하지 않는다.
사이트 DB v4, 확장 백업 DB v2를 사용한다. 이전 스키마를 보존한다.
타입·린트·31개 테스트·두 빌드·ZIP 무결성 검사가 통과했다.
수집 범위와 구현 세부 사항은 BOOKMARK-THREADS.md에 기록했다.

## Threads 저장 게시물 지원 — 2026-09-23

Chrome `1.4.3-chrome.6`에 Threads /saved 자동 백업을 추가했다.
별도 Threads 체크박스를 켜면 기존 Obsidian 연결을 재사용해 `threads/`에 분리 저장한다.
전체 39개 테스트 및 두 빌드·배포 ZIP 검증 통과. 사용 범위·제약은 `docs/THREADS-BACKUP.md` 참고.
실사용 Threads 계정과 볼트 파일에는 접근하거나 쓰지 않았다.

## Threads Web Exporter 제어판 — 1.4.3-chrome.7

- Threads 미니 위젯을 기존 Preact 모듈 행·DaisyUI 테마·실행 로그를 재사용하는 제어판으로 교체.
- Threads 원본 캐시에서 북마크/댓글 목록·검색·페이지 이동을 제공하고 X 전용 모듈은 실행하지 않음.
- 제어판 숨김 상태 유지, 고양이 버튼·툴바 복구, 테마/언어 설정, 오류 표시와 Obsidian 설정 연결.
- Threads content script에도 패키지의 app.css를 주입하며 수집기가 #twe-root를 무시하도록 변경.
- 댓글 인덱스의 빈 문자열 제외 조회는 `.above('')`로 처리. 빈 댓글 DB에서의 조회 멈춤을 회귀 검사.
- 검색 입력에 포커스가 있어도 Escape로 닫히도록 native dialog의 키 입력 처리 보강.
- 전체 42개 테스트, 타입·린트, Chrome/UserScript 빌드 및 배포 ZIP 검사 통과.
- Git 커밋·푸시, 사용자 Chrome/볼트 변경은 하지 않음.
