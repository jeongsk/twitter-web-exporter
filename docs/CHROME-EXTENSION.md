# Chrome 확장 프로그램 설치 및 개발

## 설치

1. Chrome 주소창에서 `chrome://extensions`를 연다.
2. 오른쪽 위 **개발자 모드**를 켠다.
3. **압축해제된 확장 프로그램을 로드합니다**를 선택한다.
4. `/Users/anpigon/workspace/projects/twitter-web-exporter/dist/chrome` 폴더를 선택한다.
5. 기존 Tampermonkey/Violentmonkey의 Twitter Web Exporter 스크립트는 비활성화한다.
6. 이미 열린 X 탭을 새로고침한다. 확장 프로그램을 툴바에 고정하면 편리하다.

확장 프로그램 팝업에서 제어판 열기/닫기, 설정, 북마크 열기를 사용할 수 있다.
제어판에서는 수집된 데이터를 확인하고 JSON/CSV/HTML 또는 미디어로 내보낸다.
ZIP은 배포용이다. 다른 컴퓨터에서는 먼저 압축을 풀고 내부의 manifest.json이 있는 폴더를 로드한다.
Chrome 웹 스토어에 게시한 제품이 아니며 스토어 승인도 받지 않았다.

## 한국어 사용

설정 화면의 **Language → Korean - 한국어**를 선택한다.
설정·제어판·테이블·내보내기 화면의 한국어 문구 151개를 포함한다.
한국어 브라우저에서 처음 사용하면 자동으로 한국어를 선택하며, 기존에 선택한 언어는 유지한다.
선택한 언어는 페이지를 새로고침해도 유지된다. JSON/CSV의 필드 키는 호환성을 위해 변경하지 않는다.

이전 빌드를 설치했다면 `chrome://extensions`에서 Twitter Web Exporter의 새로고침 버튼을 누르고,
X 탭도 새로고침한 뒤 언어를 선택한다. 확장 프로그램을 삭제하거나 DB를 비울 필요는 없다.
한국어 추가 빌드는 `1.4.3-chrome.2`이며 설치 폴더는 기존 `dist/chrome` 그대로다.

## 개발 명령

```bash
cd /Users/anpigon/workspace/projects/twitter-web-exporter
pnpm install
pnpm build:chrome      # dist/chrome
pnpm test              # Chrome 빌드 + 단위·통합 테스트
pnpm check:chrome      # 타입 검사 + 린트 + 빌드 + 테스트
pnpm package:chrome    # release/twitter-web-exporter-chrome-1.4.3.zip
pnpm build             # 기존 UserScript, dist/userscript
```

코드 변경 후 `pnpm build:chrome`을 실행하고 chrome://extensions에서 확장 프로그램 새로고침,
그다음 X 탭 새로고침을 수행한다. 개발 서버에 의존하지 않는 프로덕션 번들이다.

## 데이터와 권한

- 사이트 접근은 HTTPS의 x.com, twitter.com, mobile.x.com에 한정된다.
- 명시적 API 권한은 activeTab, storage, alarms다. 로컬 API 접근 권한은 백업 설정에서 사용자가 별도로 허용한다.
- 쿠키·비밀번호·요청 헤더·요청 본문을 읽거나 전송하지 않는다. 지원 API 응답에서 데이터를 추출한다.
- 수집 내용은 외부 서버로 업로드하지 않는다. 실행 라이브러리는 확장 프로그램에 포함된다.
- IndexedDB와 localStorage는 **X 사이트 origin의 저장소**다. Chrome 확장 프로그램 전용 비공개 DB가 아니다.
- 기존 스크립트가 같은 브라우저 프로필·같은 origin에 저장한 DB를 재사용한다.
- x.com과 twitter.com의 저장소는 별개다. 필요한 경우 기존 도구에서 Export DB 후 새 origin에서 Import DB 한다.
- 사이트 데이터 삭제는 수집 DB를 삭제할 수 있으므로 정기적으로 Export DB로 백업한다.
- 테이블의 Clear는 해당 모듈의 수집 연결만 지운다. 설정의 Clear DB는 전체 데이터 삭제다.

## 현재 범위와 제약

수동 스크롤로 화면에 로드된 데이터만 수집한다. 계정·검색어별 원본 출처 분리,
통계 변경 이력 저장, AI 요약, 자동 스크롤은 추가하지 않았다. 게시물의 Markdown/Obsidian 자동 백업은 docs/OBSIDIAN-BACKUP.md를 참고한다.
DM 모듈의 기존 비정상 상태와 사람·리스트 검색 결과의 미구현 상태도 유지된다.
많은 미디어는 ZIP의 메모리 사용량 때문에 URL 목록/aria2 입력 파일로 내보내는 편이 낫다.
HTML은 스타일이 자체 포함되지만 미디어는 외부 URL이다. 미디어 파일은 별도 내보내기를 사용한다.

로그인 계정이 바뀌는 것이 감지되면 데이터 혼합 방지를 위해 수집을 멈추고 팝업에 새로고침을 안내한다.
계정별 DB 설정을 바꾸면 페이지가 새로고침된다. 계정 ID를 페이지가 제공하지 않는 경우 자동 식별에는 한계가 있다.
페이지 → 확장 프로그램 메시지는 크기·형식·출처·허용 API를 검증하지만, 페이지 자체가 보내는 데이터의 진위를 보장하지는 않는다.

## 검증 방법

테스트는 새로운 임시 Chromium 프로필에서 실행하며 개인 Chrome 프로필을 열지 않는다.
X 페이지와 응답을 모의 데이터로 대체하여 수집·중복 제거·DB 지속성·팝업 메시징·파일 내보내기를 확인한다.
이 검증은 실제 X 계정의 최신 API 호환성을 보장하지 않는다. 실계정 검증은 설치 후 별도로 필요하다.
브라우저가 없는 환경에서는 `pnpm exec playwright install chromium`을 먼저 실행한다.
`TWE_CHROMIUM_EXECUTABLE` 환경 변수로 테스트 브라우저 실행 파일을 지정할 수 있다.

## Obsidian 자동 백업

툴바 팝업의 **Obsidian 자동 백업**에서 설정한다. Local REST API 플러그인, HTTPS 인증서 신뢰, API 키 입력이 필요하다.
전체 설정·제약·검증 결과는 [OBSIDIAN-BACKUP.md](OBSIDIAN-BACKUP.md)에 있다.
