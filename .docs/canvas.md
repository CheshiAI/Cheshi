# Canvas와 OpenPencil 원본 편집기

Cheshi Canvas는 OpenPencil 원본 Vue 애플리케이션의 편집 화면을 로컬로 번들해
React 화면 안에 표시한다. 별도의 Docker, Spring Boot, 디자인 서버를 설치하지 않는다.
배포 앱에는 편집기 코드, CanvasKit WASM, 워커, 기본 글꼴이 포함된다.

현재는 한 사람이 로컬에서 사용하는 구성이다. 사용자 아바타, Share, 공유방 참여와
음성 통화 UI를 제외하고 공동 편집 공급자를 초기화하지 않는다. 빌드에서 P2P 전송을
로컬 거부 어댑터로 대체하므로 MQTT·STUN·TURN 서비스에 연결하지 않는다.
원본 저장소는 보존하고 Cheshi의 어댑터와 빌드 변환에서 처리한다.

기존의 일부 SDK 기능만 연결한 화면 대신 원본 메뉴, 레이어, 속성, 도구,
컴포넌트, 자동 배치와 디자인 검사를 사용한다.
[기능·사용법·검증 범위](canvas-features.md)를 함께 확인한다.

## 구조

```text
vendor/
  open-pencil/                         내려받은 원본 트리, Git 제외
  open-pencil.version.json             버전·커밋·압축 파일·트리 체크섬
scripts/
  prepare-open-pencil.mts              원본 준비와 체크섬 검증
  open-pencil-source.mts               다운로드·검증 구현
desktop/
  frontend/
    open-pencil/
      editor.vite.config.ts           원본 소스 전용 빌드
      source-adaptations.ts            눈금자·표시 배경·로컬 이미지 경로 변환
      editor/
        main.ts                       Vue 초기화·로컬 글꼴·CanvasKit
        Workspace.vue                 원본 탭·단축키·문서 드롭
        EditorWorkspace.vue           원본 도구와 Cheshi 오른쪽 슬라이드 패널
        CanvasHistoryPanel.vue        공통 React 이력 패널의 Vue 연결
        host.ts                       부모 React 화면과 메시지 교환
        save.ts                       원본 저장 동작을 Cheshi IPC에 연결
        theme.css                     편집기 안의 Cheshi 표시 규칙
    public/open-pencil/               생성된 번들, Git 제외
    src/features/canvas/
      CanvasView.tsx                  안정적인 React 진입점
      integration/OriginalCanvasEditor.tsx  파일 경로·IPC·오류 토스트
      integration/sdk/                공통 알림과 이전 SDK 회귀 검사 지원 코드
  lib/canvas/
    canvas-documents.mts              워크스페이스 파일 읽기·원자적 저장
    canvas-session.mts                선택한 Canvas 폴더와 마지막 문서 경로
    canvas-ipc.mts                    발신자를 확인하는 Electron IPC
    canvas-preload.cts                샌드박스 preload API
  shared/canvas.ts                    네이티브/렌더러 연결 타입
  test/original-canvas-runtime.test.ts 원본 번들의 격리 Electron 검사
```

원본은 [커밋 5decf629](https://github.com/open-pencil/open-pencil/tree/5decf629f07e88b9b59d8110109860865848d149)
(0.16.0)에 고정한다. 원본의 파일 구조·잠금 파일·라이선스를 보존한다.
원본 디렉터리에 별도 Git 저장소나 `node_modules`를 만들지 않는다.
Cheshi에서 필요한 의존성은 프런트엔드 패키지와 루트 Bun 잠금 파일로 관리한다.

Git에는 버전 고정 파일과 Cheshi 어댑터를 기록한다. 원본 소스와 생성 번들은
기록하지 않는다. `bun install`은 원본 준비를 실행하고, 개발/빌드 명령은
원본 체크섬 확인과 편집기 번들을 먼저 실행한다.

```sh
bun run open-pencil:prepare
bun run open-pencil:build
bun run desktop:dev
bun run viewer:build
```

처음 개발 환경을 준비할 때 Bun, 시스템 `tar`, HTTPS 다운로드가 필요하다.
압축 파일과 추출한 트리의 SHA-256을 검증한 뒤 설치하며, 실패한 임시 설치는 정리한다.
일치하는 로컬 트리는 오프라인에서 재사용한다. 수정되거나 불완전한 원본 트리는
덮어쓰지 않고 오류로 중단한다. 배포 앱 사용자에게는 이 준비 과정이 없다.

트리 체크섬은 정렬한 POSIX 경로, NUL, 파일 SHA-256, LF를 연결해 계산한다.
업스트림 버전 변경 시 두 체크섬과 `source-adaptations.ts`의 변환 지점을 함께 검토한다.
예상한 원본 코드가 없으면 빌드가 실패한다. 벤더 파일을 직접 고치지 않는다.
원본 압축 파일의 Git LFS 포인터 9개는 업스트림 전용 테스트 자료이며,
Cheshi 검사는 이를 사용하지 않는다.

## 연결과 저장

React 화면은 같은 출처의 `open-pencil/index.html` iframe을 연다.
`cheshi:open-pencil:v1` 메시지의 출처와 창을 확인한 뒤 명령/결과를 교환한다.
네이티브 파일 접근 권한은 React 쪽의 기존 `cheshiDesktop.canvas` API에 있다.
원본 편집기의 Tauri 서버나 별도 MCP 서버는 실행하지 않는다.

속성 패널은 **Design / Lint**만 제공한다. 수동 Design JSX·HTML/CSS 입력과
React·Vue 코드 출력을 제공하던 Code 탭은 빌드에서 제외한다. 원본의 레이어 편집,
Design JSX 렌더링과 파일 내보내기 API는 유지한다. 이 API를 Cheshi 에이전트 도구에
연결하는 작업은 별도이며, Code 화면을 제거해도 자동 연결되지는 않는다.

- 열린 문서가 없으면 Explorer와 같은 공통 CANVAS 헤더·배경·중앙 안내를 표시한다.
  원본 Recent/Storage 홈, 검색, Open/New design 영역과 빈 문서 탭은 표시하지 않는다.
  헤더의 **New canvas** 아이콘으로 문서를 만들거나 왼쪽 파일 목록에서 연다.
  문서 탭의 **+**는 새 캔버스를 바로 만들며, 마지막 탭을 닫으면 안내 화면으로 돌아간다.
  열린 문서가 없을 때 왼쪽 저장 아이콘은 비활성화한다.
- EXPLORER 왼쪽 **CANVAS** 헤더의 **+**로 워크스페이스 안의 Canvas 폴더를 선택한다.
  파일 목록으로 열고, 헤더 저장 아이콘이나 **⌘S / Ctrl+S**, 원본 **File → Save / Save As**로 저장한다.
- 이름 없는 문서를 저장하면 파일 이름만 묻고 선택한 Canvas 폴더 안에 `.fig`로 저장한다.
  폴더를 아직 선택하지 않았다면 폴더 선택부터 진행하며 취소하면 파일을 만들지 않는다.
- 파일 목록의 우클릭 **Rename** 또는 F2로 파일 이름을 바꾼다. 열린 탭의 경로와
  이력도 연결하고 미저장 편집 내용을 유지한다. 같은 이름의 파일은 덮어쓰지 않는다.
- 탭을 닫을 때 원본의 미저장 변경 확인을 사용한다. Cheshi도 미저장 탭이 있으면
  창 닫기와 앱 업데이트를 보호한다.
- 파일 변경 버전을 비교해 외부 변경을 덮어쓰지 않는다. 새 이름으로 저장할 때
  이미 존재하는 파일을 임의로 덮어쓰지 않는다.
- 저장 성공 후 원본의 저장 버전과 복구 기록을 갱신한다.
- 네이티브 파일 오류는 Cheshi 공통 토스트에 표시한다. 도구 모음 위에 오류 행을
  삽입해 캔버스 높이를 바꾸지 않는다.

파일 경로는 주 워크스페이스 기준이며 상위 폴더가 먼저 존재해야 한다.
최대 64 MiB이고, 심볼릭 링크·워크스페이스 밖 경로·Git 메타데이터 접근은 거부한다.
저장은 원자적으로 처리한다. 연결된 다른 저장소를 통한 파일 접근은 별도 확장 대상이다.

선택한 Canvas 폴더와 마지막으로 성공적으로 열거나 저장한 경로는 워크스페이스 데이터 디렉터리의
`canvas-session.json`에 기록한다. 개발서버 포트와 무관하게 다음 시작 때 재사용한다.
Explorer에서 지정한 파일 요청이 우선한다. 새 탭 생성은 마지막 저장 파일을 삭제하거나
기록에서 지우지 않는다. 실패한 읽기/저장은 성공한 경로를 바꾸지 않는다.

원본의 IndexedDB 복구 기능도 포함한다. 복구 기록은 브라우저 출처/프로필에
속하므로 개발서버 포트가 달라지는 경우까지 네이티브 경로 복원과 동일하게 취급하면 안 된다.
재시작 시 모든 탭, 선택, 확대율, 이동 위치를 복원하는 기능을 보장하지 않는다.

## 워크스페이스 파일과 버전 이력

왼쪽 공통 사이드바의 CANVAS 탭에서 선택한 루트 폴더 아래의 `.fig` 파일을 관리한다.
헤더에는 저장·새로고침·폴더 선택 아이콘을 배치한다. 폴더명과 루트 기준 파일 경로를
간결하게 표시하고 실제 경로는 툴팁으로 제공한다. 기존 경로 입력·Open/Save/New 블록과
이력 저장 경로 설명은 표시하지 않는다. 폴더 선택을 취소하면 기존 루트가 유지된다. 목록은
심볼릭 링크, Git 메타데이터, 의존성·빌드·벤더 폴더를 제외하며, 최대 50,000개
항목을 탐색하고 1,000개 캔버스를 표시한다. 제한 시 더 좁은 폴더를 선택할 수 있다.

파일 목록은 Explorer의 공통 행·들여쓰기 안내선·선택/호버 색상과 경로 툴팁을
재사용한다. 행은 전체 너비에 34px 높이이며 글자 10px, 파일 아이콘은 Explorer와
같은 15px이다. 목록 하단 구분선과 카드식 바깥 여백은 두지 않는다.

네이티브 `CanvasLibrary`는 바이너리 전체를 버전별로 보존한다. 이력은 저장소 밖
워크스페이스 데이터 디렉터리의 `canvas-history/`에 저장된다. Git 커밋과 별개인
로컬 이력이며, 앱 데이터 삭제나 다른 컴퓨터 이동까지 보호하는 원격 백업은 아니다.
앱의 Rename은 기존 버전의 식별자와 날짜를 새 경로에 보존한다. 외부 도구로 이름을
바꾼 파일까지 자동 추적하지는 않는다.

- 앱 시작·열기·저장·파일 변경 감지 시 스냅샷을 남긴다. 연속으로 같은 내용은
  SHA-256으로 비교해 중복을 만들지 않는다.
- 저장 직전 원본을 먼저 보존하고, 새 데이터와 저장 저널을 준비한 뒤 원본을
  원자적으로 바꾼다. 앱이 중단된 경우 다음 접근 시 실제 파일 해시로 저널을 복구한다.
- 복원 전 현재 디스크 내용을 보존하고 복원 결과를 새 버전으로 추가한다.
  이후 버전도 유지한다. 예상 파일 버전이 바뀌었으면 복원을 거부한다.
- 오른쪽 레일의 **Version history**에서 시간·설명과 파일에 포함된 `thumbnail.png` 미리보기를 확인한다.
  미리보기가 없거나 1px 대체 이미지만 있는 파일에는 없음을 표시한다. 미리보기는 편집 문서를 변경하지 않는다.
  버전 목록은 남은 공간에서 스크롤되고, 선택한 버전의 미리보기·설명·복원 버튼은
  패널 하단의 저장 안내 위에 고정된다. 낮은 화면에서는 상세 내용만 내부 스크롤되며 복원 버튼을 유지한다.
- 미저장 캔버스가 있으면 UI 복원을 막는다. 복원된 파일은 별도 탭에서 먼저 읽은
  뒤 기존 저장된 탭을 교체하므로 읽기 오류로 기존 편집 탭을 없애지 않는다.
- 이력 패널에는 저장 시 기록된다는 짧은 안내만 둔다. 공통 React 이력 UI를 Vue
  어댑터로 연결하고 기존 오른쪽 패널과 SESSION의 슬라이드 스타일을 재사용한다.

`cheshiDesktop.canvas.checkpoint({ path, description })`는 에이전트 작업 경계용이다.
에이전트 연동 시 작업 전에 체크포인트를 호출하고, 작업 후
`save({ path, expectedRevision, data, description })`로 기록한다. 직접 파일을 쓰는
도구는 전후 체크포인트를 호출할 수 있다. 파일 감지는 켜진 앱에서 관측된 변경을
보존하며, 감지 사이의 연속 덮어쓰기나 앱이 꺼진 동안의 모든 중간 상태는 보장하지
않는다. 아직 이 API를 에이전트 도구 호출에 자동 주입하지 않는다.

## 표시 규칙

기존 Cheshi의 파일 헤더, 오른쪽 레일과 슬라이드 패널을 유지한다.
원본 속성/레이어 컨트롤을 패널 안에 배치하며, 패널은 캔버스 위에 펼쳐져
캔버스 크기나 문서 위치를 바꾸지 않는다. 원본의 도구 모음은 하단에 표시한다.
패널이 열리면 하단 도구 모음만 남은 표시 영역에 맞추며, Escape로 닫으면
레일 버튼으로 포커스를 돌려준다.

슬라이드 동작은 SESSION의 `SlidingSidePanel.module.css`를 Vue에서도 직접 가져와
사용한다. 너비 전환과 동작 줄이기 설정은 공통 스타일이 담당하며, Canvas 전용
이동·투명도 애니메이션은 두지 않는다. 닫히는 동안 마지막 패널 내용을 유지하고,
닫힌 패널은 `inert`와 `aria-hidden`으로 입력 및 접근성 탐색에서 제외한다.

왼쪽 기본 탐색 레일의 첫 항목은 Canvas다. 메뉴 줄의 Toggle UI 버튼은 제거하고,
Toolbar 설정 버튼은 오른쪽 레일로 이동했다. 오른쪽 레일은 릴레이션 그래프와 같은
공통 원형 버튼 스타일을 재사용한다. 버튼은 22×22px, 아이콘은 11×11px이며
공통 간격·색상 토큰을 사용한다.

Toolbar 설정은 별도 팝업 없이 기존 오른쪽 패널 안에 표시한다. 레일의 톱니바퀴,
도구 모음 우클릭 메뉴와 Cmd/Ctrl+,가 같은 패널을 연다. X·Escape·톱니바퀴 재클릭으로
닫으며, 다른 레일 항목을 누르면 해당 패널로 전환한다. 설정 목록은 패널 안에서
스크롤하고 도구 표시·순서·그룹·기본값 복원은 원본 컨트롤을 재사용한다.

워크스페이스 맨 위 헤더는 22px 추가 버튼 주위에 상하좌우 8px을 확보한다.
아래 구분선 1px을 포함한 높이는 39px이다. Canvas 문서 탭과 메뉴 줄은 기존 42px,
하단 상태바는 기존 높이를 유지한다.

Canvas 편집기 UI는 메뉴·설정 패널·속성 패널을 포함해 10px로 표시한다.
눈금자는 16px, 숫자는 보조 표시용 9px, 배경은 `rgba(41, 52, 61, 0.4)`다.
프레임·컴포넌트 이름과 측정값 같은 캔버스 UI 표시는 10px로 맞춘다.
디자인 문서 안의 텍스트 레이어는 저장된 글꼴 크기를 유지한다.
캔버스 뒤에는 어두운 점무늬를 표시한다. 투명한 편집 표면과 글자 대비만 바꾸며
문서의 프레임 색상이나 파일에 저장되는 페이지 색을 수정하지 않는다.
원본 Vue 컨트롤은 iframe 내부 원본 스타일에 Cheshi 표시 규칙을 적용한다.
문서 이름 입력칸과 오른쪽 레일 버튼은 공유 CSS 모듈을 사용하고,
바깥 헤더·대화상자·오류는 Cheshi 공유 React 컨트롤을 사용한다.

## 빌드와 검사

`viewer:build`는 원본 번들을 먼저 만들고 주 렌더러 `dist/open-pencil/`에 포함한다.
원본 라이선스, 의존성 고지와 글꼴 라이선스를 배포 파일에 포함한다.
네이티브 서비스는 기존 패키징 허용 목록을 사용한다.
개발 중 원본 코드나 어댑터를 바꾸면 `open-pencil:build` 후 저장된 문서 상태에서
Canvas를 다시 연다. 주 Vite는 새 해시의 자산을 감시하되 원본 HTML 재생성으로
문서를 강제 새로고침하지 않는다.

```sh
bun run viewer:typecheck
bun run desktop:typecheck
bun run codegraph:server:typecheck
bun run viewer:build
bun run desktop:test:canvas
bun run open-pencil:test
```

`desktop:test:canvas`에는 네이티브 파일/세션/충돌/경로 검사, 이전 SDK 회귀 검사,
패키징·preload, 닫기·패널 전환·분할 유지와 원본 Electron 실행 검사가 있다.
명령이 preload와 원본 편집기를 먼저 빌드한다. 사용자 프로필·문서 대신 임시 프로필을
사용하고 외부 HTTP/WS를 차단한다. 실제 개발앱 입력 검사는 별도다.

`viewer:typecheck`는 React 검사와 `open-pencil:typecheck`를 함께 실행한다.
후자는 Cheshi의 `open-pencil/editor` TypeScript와 Vue 템플릿을 엄격하게 검사한다.
고정된 외부 원본은 실행 빌드와 같은 어댑터 변환을 거친 의존성 선언으로 준비하며,
외부 원본 전체의 타입 오류를 검사하는 명령은 아니다. 선언 캐시는
`node_modules/.cache/cheshi-open-pencil/types`에 두고 버전·변환·컴파일러 변경 시 재생성한다.
렌더러 테스트는 파일마다 전역 환경을 분리해 모의 IPC와 DOM이 다른 검사에 남지 않게 한다.

이전 SDK 런타임 검사만 Vite 변환으로 실행하려면 다음 명령을 사용한다.
워커 변환과 사전 번들은 `desktop/test/canvas-sdk.vite.config.ts`에서만 적용한다.
이는 현재 원본 편집기 전체 검사를 대체하지 않는다.

```sh
CHESHI_CANVAS_TEST_DEV=1 node --test desktop/test/canvas-runtime.test.ts
```

## 범위

원본 브라우저 편집기를 가져온 것으로, Figma의 모든 기능/파일과 동일한 결과를
보장하는 것은 아니다. 가져온 복잡한 디자인의 시각적 일치는 별도로 확인해야 한다.
Inter, Noto Naskh Arabic, Nanum Gothic을 로컬로 포함하고 온라인 글꼴은 최초 시작 때
끄며, 원본 설정에서 켤 수 있다. WebGL이 필요하다.

`.fig`는 바이너리다. 에이전트용 JSON/Markdown 투영, CodeGraph 코드 연결, WBS,
마일스톤과 SDD 자동화, Milo는 이번 편집기 통합에 포함하지 않는다.
AI 공급자·실시간 공유·외부 저장소의 실제 연결 조건과 검증 한계는
[기능 문서](canvas-features.md#외부-연결)를 참고한다.
