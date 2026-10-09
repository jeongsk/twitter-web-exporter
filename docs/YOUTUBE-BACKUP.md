# YouTube 좋아요 영상 → Obsidian 자동 백업

## 적용 범위

Chrome 빌드 `1.4.3-chrome.10`부터 지원한다. X·Threads 기능과 기존 저장 파일 이름은 그대로 유지한다.
대상은 YouTube의 「좋아요 표시한 동영상」 재생목록(`https://www.youtube.com/playlist?list=LL`)이다.
화면에 로드된 영상 카드에서 메타데이터만 읽는다. YouTube Data API나 내부 API는 호출하지 않는다.

## 사용 방법

1. `chrome://extensions`에서 Twitter Web Exporter를 새로고침한다. 권한 변경 확인이 나오면 YouTube 접근 범위를 검토한다.
2. 이 Chrome 프로필에서 YouTube에 로그인한다. 좋아요 목록은 로그인한 본인에게만 보인다.
3. 이미 열려 있는 YouTube 탭과 백업 설정 탭을 새로고침한다.
4. Obsidian 자동 백업 설정에서 기존 API 연결을 확인한다. 저장된 API 키·폴더는 재사용한다.
5. `자동 백업 사용`과 `YouTube 좋아요 영상도 자동 백업`을 켜고 `백업 설정 적용`을 누른다.
6. 확장 프로그램 팝업의 `YouTube 좋아요 열기` 또는 위 주소로 목록을 열고 천천히 스크롤한다.
   「3. 자동 수집」 주기를 켜 두면 직접 열지 않아도 주기마다 목록을 수집한다.

업데이트만으로 YouTube 자동 백업을 임의 활성화하지 않는다. 새 체크박스 기본값은 꺼짐이다.

## 저장되는 자료

영상 하나당 노트 하나를 만든다. 본문에는 다음만 들어간다.

- Obsidian이 플레이어로 표시하는 영상 임베드 `![](<https://www.youtube.com/watch?v=…>)`와 원문 링크
- 제목, 채널 이름(채널 링크가 확인되면 링크로. 여러 채널의 공동 작업 영상은 링크 없이 이름만), 길이(표시된 경우)
- 영상 ID로 만든 썸네일 주소(`i.ytimg.com/vi/<ID>/hqdefault.jpg`)

frontmatter에는 `source_url`, `source_id`(영상 ID), `source_platform: youtube`, `source_key`, `author`(채널),
`channel_url`, `duration`, `thumbnail`, `ingested`, `sha256`, `tags: [youtube, clippings]`,
`backup_kind: youtube-liked`를 기록한다. 제목·채널 이름은 Markdown·Obsidian 임베드 문법이 실행되지 않도록 이스케이프한다.

본문 해시에는 수집 날짜·목록 순서 같은 변하는 값을 넣지 않는다. 같은 영상을 다시 수집해도
중복 저장하지 않고, 제목·채널·길이가 바뀐 경우에만 `revisions/`에 변경본을 저장하며 최초 파일은 보존한다.

## 파일 구조

설정한 백업 폴더 아래 `youtube/`에 분리한다. 기본 예시는 다음과 같다.

```text
raw/articles/twitter-web-exporter/
  x-<X 게시물 ID>.md
  threads/...
  youtube/
    youtube-<영상 ID>.md
    revisions/youtube-<영상 ID>-<본문 SHA256>.md
```

영상 ID는 영문 대소문자·숫자·`-`·`_` 11자라 그대로 파일 이름에 쓴다.
대소문자만 다른 두 ID가 macOS 같은 대소문자 비구분 파일시스템에서 만날 확률은 매우 낮다.
만나더라도 기존 파일의 `source_key`가 달라 덮어쓰지 않고 `revisions/`에 따로 저장한다.

## 주기 자동 수집

YouTube 백업이 켜져 있을 때만 「3. 자동 수집」이 X 북마크·Threads 저장 목록 다음에
좋아요 재생목록을 비활성 탭으로 열고 스크롤한다. 이전에 저장한 영상이 나오면 멈추고 탭을 닫는다.
좋아요 목록은 최근에 좋아요한 영상이 위에 오므로 새 영상만 확인하고 끝난다.
수집 중에 그 탭을 직접 열어 보면 스크롤을 멈추고 탭을 남겨 둔다.
결과는 설정 페이지에 「YouTube 새 항목 n개 (중단 이유)」로 표시한다.

## 수집 한계

- 메타데이터만 저장한다. 영상·음성 파일, 자막, 설명, 댓글은 저장하지 않는다.
- 좋아요를 누른 날짜는 YouTube가 목록에 표시하지 않아 기록하지 않는다. `ingested`는 볼트에 저장한 날짜다.
- 화면에 로드된 카드만 읽는다. 비활성 탭에서는 목록 끝의 「더 불러오기」 항목이 화면에 보이지 않아 YouTube가 다음 100개를 요청하지 않는다. 그래서 주기 수집 중에만 MAIN world 스크립트(`youtube-page.ts`)가 YouTube 자신의 continuation 명령을 `ytd-app.resolveCommand`로 실행한다. 요청과 렌더링은 YouTube가 직접 하고, 다음 명령은 그 응답(`onResponseReceivedActions`)에서 읽는다. 확장 프로그램이 YouTube API를 직접 호출하지는 않는다. 2026-10-09 실제 페이지의 비활성 탭에서 좋아요 100개를 넘어 목록 끝까지 불러오는 것을 확인했다.
- `resolveCommand`는 공개 API가 아니다. YouTube가 이를 없애면 예전처럼 최근 100개까지만 수집된다. 이때는 목록을 직접 열어 끝까지 스크롤하면 저장된다.
- 한 번 실행할 때 3분, 스크롤 30번까지만 진행한다. 한 번에 약 3,000개까지 불러올 수 있으며, 그보다 많으면 다음 실행에서 이어지지 않으므로 직접 스크롤한다.
- YouTube DOM 구조에 의존한다. YouTube 화면이 바뀌면 일부 항목이나 길이·채널 정보가 빠질 수 있다.
- 삭제·비공개 처리된 영상은 목록에서 숨겨지거나 제목을 읽을 수 없어 저장하지 않을 수 있다.
- 썸네일·영상 링크는 YouTube 서버에 있다. 원본이 삭제되면 임베드와 썸네일이 열리지 않는다.
- 한 번에 100개씩 대기열에 넣으며, 공통 대기열 5,000개 한도를 X·Threads와 공유한다.

API 키는 기존 trusted extension storage만 사용한다. YouTube 콘텐츠 스크립트에는 키 조회·설정 변경 권한이 없다.
볼트의 Git·클라우드 동기화 제외 규칙은 변경하지 않았다. `youtube/` 하위 폴더도 비공개 범위를 확인해야 한다.

실행 코드: `src/youtube/`, `src/extension/youtube-content.ts`, `src/extension/youtube-page.ts`.
테스트: `tests/youtube-backup.spec.ts`, `tests/youtube.spec.ts`, `tests/youtube-auto-collect.spec.ts`.
