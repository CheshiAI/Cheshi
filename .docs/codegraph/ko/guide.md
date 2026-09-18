# CodeGraph 사용 가이드

Cheshi는 `codegraph/`의 Bun/TypeScript 엔진을 직접 사용합니다. CodeGraph는
Workspace의 소스를 Tree-sitter로 분석해 로컬 SQLite 그래프를 만들며, Cheshi의
Viewer와 Electron 앱은 이 데이터베이스를 읽기 전용으로 엽니다.

## 기본 원칙

- 패키지 설치와 명령 실행에는 Bun을 사용합니다.
- CodeGraph 데이터는 소스 저장소가 아니라 Cheshi 사용자 데이터 디렉터리에
  저장합니다. 프로젝트 루트에 `.codegraph/`를 만들지 않습니다.
- Viewer가 열려 있는 동안 같은 인덱스에 `sync`나 `index`를 실행하지 않습니다.
- 앱에서 Workspace를 열 때 인덱스가 없으면 최초 인덱싱을 자동 실행합니다.
  목록에 등록만 할 때는 생성하지 않으며, 기존 인덱스는 재사용합니다.
- CLI나 엔진에서 인덱스를 생성하는 것만으로는 Workspaces 목록에 등록되지
  않습니다. 목록에는 앱에서 직접 열거나 추가·생성한 프로젝트가 표시됩니다.
- Bun 테스트는 실제 앱의 저장 경로를 상속하지 않습니다. 엔진 테스트는 임시
  프로젝트 안에, CLI 테스트는 테스트 실행별 임시 앱 데이터 폴더에 저장합니다.
  변경분 동기화와 전체 재생성은 별도의 `sync`, `index` 요청으로 실행합니다.
- 전체 재생성보다 `sync`를 우선합니다. `uninit`은 인덱스를 삭제하므로 삭제가
  명시적으로 필요한 경우에만 사용합니다.

## 중앙 저장 구조

macOS 기본 저장 루트는 다음과 같습니다.

```text
~/Library/Application Support/Cheshi/
├── workspaces.json
└── workspaces/
    └── <workspace-name>-<path-hash>/
        ├── workspace.json
        └── codegraph/
            └── codegraph.db
```

`workspaces.json`은 Workspace 원본 경로와 중앙 저장 경로를 관리합니다. 같은 실제
경로는 항상 같은 Workspace ID를 사용합니다. 다른 경로에 이름이 같은 프로젝트가
있어도 경로 해시가 달라 충돌하지 않습니다.

기본 위치를 바꿔야 할 때는 절대 경로만 허용하는 `CHESHI_USER_DATA_DIR` 또는
`CODEGRAPH_DATA_ROOT`를 사용합니다. 일반적인 개발과 배포에서는 `.env.product`의
`APP_DATA_DIRECTORY` 값을 기준으로 계산되는 기본 위치를 사용합니다.

## 설치와 CLI

저장소 의존성을 설치하고 CLI 목록을 확인합니다.

```sh
cd /absolute/path/to/cheshi
bun install
bun run cheshi-cli --help
bun run cheshi-cli codegraph --help
```

Cheshi 밖에서도 `cheshi-cli` 명령을 직접 사용하려면 저장소 루트를 Bun 전역 링크로
등록합니다. 전역 CLI와 개발용 `bun run cheshi-cli ...` 진입점은 모두 Cheshi 중앙
저장 위치를 사용합니다.

```sh
bun link
cheshi-cli --version
cheshi-cli codegraph version
```

링크 제거:

```sh
bun unlink
```

## 초기화, 상태, 동기화

새 Workspace의 최초 인덱스 생성:

```sh
cheshi-cli codegraph init /absolute/path/to/workspace
```

이 명령의 인수는 분석할 소스 Workspace이며 데이터베이스 저장 위치가 아닙니다.
예를 들어 `/absolute/path/to/your/project`를 전달해도 데이터베이스는 저장소
안이 아니라 위 중앙 저장 구조의 `codegraph/codegraph.db`에 생성됩니다.

상태 확인:

```sh
cheshi-cli codegraph status /absolute/path/to/workspace --json
```

정상 완료 상태의 핵심 값은 `initialized: true`, `index.state: "complete"`,
`index.pendingRefs: 0`입니다. 파일 변경분만 반영할 때는 다음을 사용합니다.

```sh
cheshi-cli codegraph sync --quiet /absolute/path/to/workspace
```

전체 인덱스를 다시 생성해야 할 때만 `index`를 사용합니다.

```sh
cheshi-cli codegraph index /absolute/path/to/workspace
```

이전 작업이 비정상 종료되어 일반 인덱싱이 실패한다면 정확도는 유지하면서 초기화
경로만 보수적으로 바꿀 수 있습니다.

```sh
CODEGRAPH_NO_FAST_INIT=1 cheshi-cli codegraph index --quiet /absolute/path/to/workspace
```

잠금 오류는 먼저 실행 중인 Viewer, MCP, daemon을 종료한 뒤 확인합니다. 실제
writer가 없는 stale lock으로 확인된 경우에만 다음 명령을 사용합니다.

```sh
cheshi-cli codegraph unlock /absolute/path/to/workspace
```

## 조회와 분석

심볼 검색:

```sh
cheshi-cli codegraph query "CodeGraphService" \
  --path /absolute/path/to/workspace --limit 5 --json
```

관련 소스와 호출 경로를 한 번에 탐색:

```sh
cheshi-cli codegraph explore \
  "How does the Viewer service start?" \
  --path /absolute/path/to/workspace --max-files 5
```

주요 조회 명령:

```sh
cheshi-cli codegraph node "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph files --path /absolute/path/to/workspace
cheshi-cli codegraph callers "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph callees "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph impact "CodeGraphService" --path /absolute/path/to/workspace
cheshi-cli codegraph affected --path /absolute/path/to/workspace path/to/changed-file.ts
```

명령별 정확한 옵션은 `cheshi-cli codegraph help <command>`로 확인합니다.

## CLI 명령 범위

| 명령 | 용도 |
| --- | --- |
| `init [path]` | Workspace 초기화와 최초 인덱스 생성 |
| `uninit [path]` | 중앙 저장소의 해당 Workspace CodeGraph 인덱스 삭제. `--force`는 확인 생략 |
| `index [path]` | 전체 인덱스 재생성 |
| `sync [path]` | 마지막 인덱스 이후 변경분 반영 |
| `status [path]` | 상태와 통계 조회 |
| `query <search>` | 심볼 검색 |
| `explore <query...>` | 관련 소스와 호출 경로 통합 탐색 |
| `node [symbol\|file]` | 심볼 또는 파일 상세 조회 |
| `files [path]` | 인덱스 파일 트리 조회 |
| `callers <symbol>` | 호출자 조회 |
| `callees <symbol>` | 피호출자 조회 |
| `impact <symbol>` | 변경 영향 범위 분석 |
| `affected [files...]` | 변경 파일에 영향받는 테스트 탐색 |
| `daemon` / `daemons` | 백그라운드 daemon 관리 |
| `unlock [path]` | 확인된 stale lock 제거 |
| `install` / `uninstall` | 에이전트 MCP 설정 연결 및 해제 |
| `version` | 현재 엔진 버전 출력 |

## Codex MCP 연결

Cheshi 데스크톱은 모든 채팅 계정에 앱 전용 `cheshi_codegraph` MCP 서버를
자동으로 연결합니다. 배포 앱에 포함된 CLI(개발 중에는 현재 체크아웃의 CLI),
선택한 Workspace, Viewer와 동일한 데이터 루트를 사용합니다.
사용자 지정 `--user-data-dir` 경로도 적용됩니다. MCP는 인덱스를 읽기 전용으로
열고, 인덱싱은 앱에서 관리합니다.

선택한 계정의 실제 MCP 설정을 조회해 기존 `codegraph` 서버가 있으면 앱의
app-server 프로세스에서만 비활성화하여 중복 연결을 막습니다. 다른 MCP 서버와
계정 설정 파일은 변경하지 않습니다. 데스크톱 채팅에는 전역 CodeGraph MCP
설치가 필요하지 않습니다.

Cheshi 밖에서 독립적으로 Codex CLI를 사용할 때는 아래와 같이 설정합니다.

전역 링크로 `cheshi-cli` 실행 파일을 등록한 뒤 Codex에 MCP 설정을 설치합니다.
이 명령은 사용자 홈의 Codex 설정을 변경하므로 반드시 사용자의 명시적 요청을 받고
실행합니다.

```sh
cheshi-cli codegraph install --target codex --location global --yes
```

설치되는 `[mcp_servers.codegraph]` 설정에는 같은 중앙 저장 루트를 가리키는
`CODEGRAPH_DATA_ROOT` 환경 변수도 포함됩니다. 따라서 CLI, Cheshi Viewer, Codex
MCP가 동일한 Workspace 인덱스를 엽니다. MCP 실행 명령도
`cheshi-cli codegraph serve --mcp`로 기록됩니다.

설치 후 Codex를 재시작합니다. MCP가 제공하는 주요 도구는 관련 심볼의 실제 소스와
호출 경로를 함께 반환하는 `codegraph_explore`, 심볼·파일 상세를 읽는
`codegraph_node`입니다.

## 읽기 전용 Viewer

Renderer를 빌드하고 독립 Viewer를 실행할 수 있습니다.

```sh
bun run viewer:build
bun run codegraph:server:cli /absolute/path/to/indexed/workspace
```

기본 주소는 `http://127.0.0.1:4317`입니다. 포트와 추가 프로젝트:

```sh
bun run codegraph:server:cli /absolute/path/to/workspace --port 48733
bun run codegraph:server:cli /absolute/path/to/workspace \
  --project /absolute/path/to/another-indexed-workspace
```

Viewer는 프로젝트 선택, 심볼 검색, 디렉터리·언어·종류별 그룹, 탐색 깊이와 노드
한도, edge 필터, Mermaid 관계 그래프, pan/zoom/fit, 노드 선택, caller/callee,
소스 상세와 파일 열기를 제공합니다.

## Electron 앱

개발 실행은 현재 저장소에 완료된 인덱스가 있으면 해당 Workspace를 복원합니다.
복원할 인덱스가 없으면 시작 화면 다음에 Workspaces 목록만 표시합니다.

```sh
bun run desktop:dev
```

완료된 인덱스가 있는 다른 Workspace를 선택해 실행:

```sh
CHESHI_WORKSPACE=/absolute/path/to/indexed/workspace bun run desktop:dev
```

개발 모드는 Vite HMR과 Electron/Viewer 재시작 감시를 함께 사용합니다. 배포용 앱은
Renderer, 현재 플랫폼용 Viewer host, `cheshi-cli`, 인덱싱 worker와 Tree-sitter
리소스를 만든 뒤 Forge로 패키징합니다. 패키지 내부 CLI는 macOS 기준
`Cheshi.app/Contents/Resources/runtime/<platform>-<architecture>/cheshi-cli`에
포함되며, 추후 앱의 CLI 설치 버튼도 이 실행 파일을 사용자 PATH에 연결하면 됩니다.

```sh
bun run desktop:package
```

배포 앱은 현재 실행 디렉터리를 Workspace로 사용하지 않습니다. 중앙 목록에서
완료된 인덱스와 실제 폴더가 있는 최근 Workspace를 복원하며, 복원할 항목이 없으면
Workspaces 전용 창을 엽니다. 파일시스템 루트(`/`)는 자동 복원 대상에서 제외합니다.
복원할 프로젝트가 있어도 먼저 CLI 설치와 Codex 로그인 상태를 확인하고,
미설치 또는 미로그인 상태이면 Workspaces의 안내 화면으로 이동합니다.
Workspaces 목록만 열려 있을 때는 프로젝트 등록, 인덱싱, 파일 감시, 터미널,
Codex 대화 서비스를 시작하지 않습니다. 사용자가 폴더를 열거나 클론한 뒤에 시작합니다.
Workspaces 전용 창은 숨긴 상태에서 CLI 설치와 Codex 로그인 상태를 확인합니다.
확인이 끝나고 설치 안내, 로그인 화면 또는 프로젝트 목록이 렌더링되면 시작 화면을
닫고 준비된 창을 표시합니다. CLI 설치가 확인된 경우에만 계정 확인 전용 앱서버를
시작하며, 로그인 버튼으로 브라우저 인증을 진행합니다. 목록 창을 닫으면 해당
로그인 서버도 종료합니다.

Electron은 중앙 저장소에 현재 Workspace의 `codegraph/codegraph.db`가 있을 때만
Viewer child process를 시작하고, stdout의 `{ "type": "ready", "url": "..." }`
준비 메시지를 기다립니다. 앱 종료 시 Viewer도 종료합니다. 인덱스가 없으면 앱은
Workspace를 등록하고 최초 인덱싱을 마친 뒤 Viewer를 연결해 창을 엽니다.
같은 Workspace를 여러 창에서 열어도 최초 인덱싱은 한 번만 실행합니다.
최초 인덱싱 중에는 중앙 저장소에 `codegraph.db.initializing` 표시를 유지하며,
실패한 경우 불완전한 DB를 조회하지 않고 Workspace만 열어 오류를 알립니다.
다시 열면 미완료 최초 인덱싱을 재시도합니다. 기존 완료 인덱스는 자동 재생성하지
않습니다.

## 개발 진단 도구

CodeGraph 내부 진단 도구는 `codegraph/src/devtools/`의 TypeScript 소스이며
`codegraph:typecheck`에 포함됩니다. 파일 경로를 직접 실행하지 말고 Workspace
명령을 사용합니다.

```sh
bun run --cwd codegraph dump:graph -- /absolute/path/to/indexed/workspace
bun run --cwd codegraph extraction:verify -- /absolute/path/to/indexed/workspace typescript
bun run --cwd codegraph grammar:check -- typescript /absolute/path/to/valid-sample.ts
bun run --cwd codegraph grammar:dump-ast -- typescript /absolute/path/to/sample.ts --depth=4
```

네이티브 kernel과 WASM 추출 결과를 실제 저장소에서 비교하려면 먼저 kernel을
빌드한 뒤 parity 도구를 실행합니다.

```sh
bun run --cwd codegraph build:kernel
bun run --cwd codegraph kernel:parity -- /absolute/path/to/workspace --lang typescript,tsx
```

`dump:graph`와 `extraction:verify`는 Cheshi 중앙 저장 위치의 기존 인덱스를 읽으며
저장소 내부 `.codegraph/`를 만들지 않습니다.

## 검증

```sh
bun run typecheck
bun run codegraph:server:test
bun run codegraph:test
bun run desktop:package
```

Qodana는 이 검증 흐름에 포함하지 않습니다. 대용량 분석 도구 다운로드와 실행은
사용자가 별도로 수행합니다.
