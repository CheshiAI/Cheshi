# Codex 전문 에이전트 Docker 실험

Docker 엔진에서 전문 에이전트를 실행하는 워커다. 독립 Compose 실험과
Cheshi의 프로젝트별 등록 에이전트가 같은 워커 소스를 사용한다. Codex
0.159.3의 App Server를 표준 입출력으로 제어하며, Bun 1.3.14로 HTTP 작업
API를 제공한다. 아래 Compose 명령은 독립 검증 에이전트 실험용이다.

## Cheshi 에이전트 간 협업: 첫 단계

Cheshi에서 같은 프로젝트와 Docker 엔진에 배정한 에이전트들을 각각
`Start agent`로 시작하면 중앙 전달 서비스에 등록된다. 기존 워커도 새
프로토콜을 적용하려면 다시 `Start agent`해야 한다. 중앙 서비스는 Cheshi가
실행되는 동안 메시지를 전달하며, 상대 컨테이너를 자동으로 시작하지 않는다.

모델에는 `list_agents`, `ask_agent`, `reply_agent`, `collaboration_status`를
제공한다. 모델이 상대와 질문을 선택하고, `ask_agent`는 로컬 저장 직후
반환하므로 답변을 기다리기 전에 독립 작업을 계속할 수 있다. 모델이 턴을
끝내면 미해결 질문이 있는 작업은 `waiting`이 된다. 실행 슬롯을 반환하므로
다른 질문을 처리할 수 있고, 답변이 도착하면 같은 작업과 네이티브 대화를
재개한다. 답변 대기 중에는 모델을 반복 호출하지 않는다.

각 새 사용자 작업은 별도 네이티브 대화를 사용한다. 질문에 답하는 상담도
별도 대화를 사용하므로 원래 작업을 덮어쓰지 않는다. 이전 작업 기록은
볼륨에 보존하고 마지막 성공 요약을 새 작업에 전달한다. 다른 과거 대화의
전체 내용을 자동으로 검색하는 Jev 연동은 아직 추가하지 않았다.

중앙 기록은 런타임 디렉터리의 `collaboration.json`, 워커의 받은 질문·발신
메시지·수신 확인·대기 상태는 `/agent/state/agent.json`에 저장한다. 저장을
완료한 뒤 수신을 확인하고 동일 ID의 재전달은 중복 처리하지 않는다. 워커의
named volume과 중앙 기록을 유지하면 컨테이너를 재생성해도 대기 중인 질문과
답변 재개가 이어진다. 실행 도중 중단된 작업은 기존처럼 `unknown`으로
격리하고 자동 재실행하지 않는다.

첫 단계의 상담은 읽기 전용이며 명령 실행과 재위임을 허용하지 않는다.
원래 작업의 파일·명령 권한은 기존 설정을 따른다. 작업당 질문은 최대 16개다.
작업 위임은 후속 범위다. 독립 검증·목표 완료 판정·기억 조회·질문 만료와
방에 속한 목표·상담·검증 작업의 `unknown` 복구는 후속 구현에 포함됐다.
상대가 중단되어 있으면 질문을 보관하고,
사용자는 대기 중인 원래 작업을 취소할 수 있다. 취소 뒤 늦게 도착한 답변은
보관하되 해당 작업을 자동 재개하지 않는다.

검증 명령은 저장소 루트에서 실행한다.

```sh
bun test desktop/test/agent-orchestration.test.ts experiments/codex-specialists/src/collaboration.test.ts
bun test desktop/test/agent-orchestration-process.test.ts
CHESHI_ORCHESTRATION_DOCKER_CONTEXT=colima-cheshi bun test desktop/test/agent-orchestration-docker.test.ts
```

Docker 검증은 로컬 `cheshi-specialist:1` 이미지를 기반으로 임시 이미지,
컨테이너 2개, 전용 볼륨을 만들고 정리한다. 실제 워커·HTTP·표준 입출력·
컨테이너 재생성을 사용하며, 모델 응답만 fixture로 대체한다. 기존 프로젝트,
에이전트 볼륨, 계정 인증을 사용하지 않는다. 실제 모델이 자율적으로 적절한
상대를 선택하는 품질이나 Jev 기억 조회까지 검증한 테스트는 아니다.

## 실행

저장소 루트에서 다음을 실행한다.

```sh
cd experiments/codex-specialists
docker compose build
docker compose run --rm --no-deps --entrypoint codex verifier \
  -c 'cli_auth_credentials_store="file"' login --device-auth
docker compose up -d --wait
curl --fail http://127.0.0.1:47831/health
curl --fail http://127.0.0.1:47831/account
```

기기 코드 로그인은 ChatGPT 설정 → 보안에서 먼저 활성화해야 한다.
로그인 명령이 출력하는 링크와 일회용 코드를 사용한다. 인증 정보는 컨테이너
전용 볼륨에 저장된다. 호스트 인증 파일을 복사하거나 저장소에 넣지 않는다.
[공식 인증 안내](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

호스트 포트는 `CHESHI_SPECIALIST_PORT`로 변경할 수 있다. 기본 주소는
`127.0.0.1:47831`이며, 브라우저 Origin 헤더가 있는 요청은 거부한다.
인증 토큰을 사용하는 서비스가 아니므로 로컬 테스트 용도로만 사용한다.

### Colima

Colima의 AppArmor가 활성화된 VM에서는 기본 Compose에 전용 override를
추가한다. 먼저 [AppArmor 설치 절차](security/README.md#colima-apparmor)를
따라 VM에 프로필을 설치한다. 아래 명령은 이미 실행 중인 `cheshi` 프로필과
Homebrew Docker CLI를 사용한다. Docker 기본 context를 변경하지 않는다.

```sh
export DOCKER_HOST="unix://$HOME/.colima/cheshi/docker.sock"
export DOCKER_CONFIG="$HOME/.colima/cheshi/docker-client"
export CHESHI_SPECIALIST_PORT=47832
docker compose -f compose.yaml -f compose.colima.yaml up -d --build --wait
docker compose -f compose.yaml -f compose.colima.yaml exec -T verifier bun src/verify-sandbox.ts
curl --fail http://127.0.0.1:47832/health
```

`docker-client/config.json`에는 Homebrew 플러그인 경로
`{"cliPluginsExtraDirs":["/opt/homebrew/lib/docker/cli-plugins"]}`를 설정한다.
`brew install docker docker-compose docker-buildx`로 설치한 플러그인을 사용한다.
기존 설정이나 자격 증명을 덮어쓰지 말고 전용 클라이언트 디렉터리를 사용한다.
이 환경에서 로그인·재생성·종료할 때에도 두 `-f` 옵션을 함께 사용한다.

엔진을 바꾸면 named volume도 별개다. Colima 전용 볼륨에서는 처음 한 번
로그인하고, 이후 같은 볼륨을 유지하면 인증과 대화 기록을 재사용한다.
로그아웃·인증 만료/철회·볼륨 삭제 시에는 재인증이 필요할 수 있다.

## 작업 요청과 확인

Codex가 `/workspace`의 파일을 직접 읽고 읽기 전용 명령을 실행할 수 있다.
아래 예시는 에이전트의 검증 능력을 확인하기 위해 **의도적으로 오류를 넣은
테스트 함수**를 실행한다. Cheshi 운영 코드에서 발견한 결함이 아니다.

```sh
curl --fail --json '{"id":"manual-shell-review-1","prompt":"검증 전문 에이전트로서 /workspace/failure-rate.ts를 직접 읽고 Bun으로 import하여 (0,0), (1,10), (10,10)을 실행하세요. 결과는 String으로 출력해 NaN과 Infinity를 보존하세요. 이 파일은 의도적으로 오류를 넣은 테스트 fixture입니다. 실제 명령, 출력, 종료 코드와 기대값 비교를 한국어로 보고하세요. 소스는 수정하지 마세요."}' \
  http://127.0.0.1:47831/tasks
curl --fail http://127.0.0.1:47831/tasks/manual-shell-review-1
curl --fail http://127.0.0.1:47831/activity
```

POST는 작업 수락 시 202를 반환한다. 작업 조회의 `status`가 최종 결과다.
같은 ID와 같은 prompt는 기존 작업을 반환하며 중복 실행하지 않는다.
같은 ID에 다른 prompt를 보내거나 실행 중 새 작업을 보내면 409를 반환한다.
작업 ID는 영문자, 숫자, 밑줄, 하이픈을 포함한 1~80자다.

| API | 동작 |
| --- | --- |
| `GET /health` | 프로세스 준비 상태, 역할, 실행 여부, 저장된 대화 ID |
| `GET /account` | 로그인 여부와 계정 유형; 인증 정보와 이메일 제외 |
| `GET /models` | 현재 계정의 사용 가능한 모델과 다음 페이지 커서 |
| `POST /tasks` | `{ "id": "선택 항목", "prompt": "요청" }`로 작업 수락 |
| `GET /tasks/:id` | 작업 상태, 대화/턴 ID, 최종 출력, 오류 |
| `POST /tasks/:id/stop` | 취소 요청; 종료 여부는 작업 상태로 확인 |
| `GET /activity` | 저장된 작업 목록과 대화/모델 정보 |

```sh
curl --fail -X POST http://127.0.0.1:47831/tasks/manual-shell-review-1/stop
docker compose up -d --force-recreate --wait
curl --fail http://127.0.0.1:47831/activity
```

## 지속 상태와 실행 경계

`verifier-space` named volume을 `/agent`에 연결한다.

| 경로 | 용도 |
| --- | --- |
| `/agent/codex` | Codex 인증 및 네이티브 대화 기록 |
| `/agent/state/agent.json` | 대화 ID, 모델, 작업 상태 |
| `/agent/memory/latest.json` | 마지막 성공 작업의 출력 요약, 최대 8,000자 |
| `/agent/artifacts/:id.json` | 작업별 최종 결과 |

작업 시작 시 요약을 참고 자료로 불러오고, 완료 시 저장한다. 컨테이너 재생성 후
첫 작업에서 기존 네이티브 대화를 `thread/resume`으로 복원한다. 요약은 별도의
지식 검색 시스템이 아니며, 장기 기억 품질까지 평가한 실험은 아니다.

프로세스가 작업 도중 종료되거나 실행 결과를 확인하지 못하면 `unknown`으로
기록한다. 이런 작업이 있으면 새 실행을 차단하고 자동 재시도하지 않는다.
방에 속한 작업은 인증된 `POST /tasks/:id/recover`에 `roomId`를 전달해
저장된 네이티브 대화의 정확한 마지막 턴을 확인할 수 있다. 작업 실행 시간에는
제한을 두지 않는다. `/health`의 `execution`은 현재 작업과 최근 모델·도구 활동
시각을 제공하며, 120초 간격의 대화 메타데이터 조회로 실행 엔진 응답을 확인한다.
이 조회는 모델을 호출하지 않는다. 엔진 응답과 실제 작업 진행은 별개이며,
응답 미확인이나 긴 무활동만으로 작업을 중단·재실행·완료 처리하지 않는다.
통신 요청의 응답 제한은 유지하며, 사용자 중단과 실제 연결 종료는 기존대로 처리한다.
복구 자체는 모델을 호출하거나 기존 작업을 다시 실행하지 않는다.

검증 작업의 복구는 실행 종료 확인과 검증 판정을 구분한다. 정상 종료된 턴의
검증 초안이 저장된 파일·명령 근거와 일치하고 현재 파일 해시도 유지된 경우에만
그 판정을 복원한다. 중단·실패·초안 누락·근거 불일치·파일 변경은 `inconclusive`로
전달하며 원래 담당 에이전트가 재검증 여부를 판단한다. 복구 영수증·작업 상태·
발신 결과는 하나의 상태 저장으로 기록하고, 이미 발행한 결과는 변경하지 않는다.
담당 에이전트는 결과를 처리하고 현재 파일을 다시 확인해야 목표를 완료할 수 있다.
검증 작업 상세의 **Inspect execution**에서 이 흐름을 실행한다.
이 기능은 `recoveryProtocol: 3` 워커를 사용하며 기존 1·2 워커는 권한·계정·지침이
동일하고 실행 중인 작업이 없을 때 저장 볼륨을 유지한 채 갱신할 수 있다.

소스는 `fixtures/workspace`만 `/workspace:ro`로 제공한다. 컨테이너의 실행
파일 시스템도 읽기 전용이며, 전용 볼륨과 임시 디렉터리에만 쓰기가 가능하다.
비루트 사용자, capability 제거, `no-new-privileges` 설정을 사용한다.
Codex 작업은 읽기 전용이고 명령의 네트워크 접근은 금지한다. 모델 연결에는
컨테이너 외부 네트워크가 필요하다. 추가 명령/파일/권한 승인은 거부한다.
역할 지침은 `profiles/verifier/AGENTS.md`에 있다.

초기에는 Docker seccomp 제한으로 `bwrap` 네임스페이스 생성이 실패했다.
현재는 [전용 프로필](security/README.md)을 적용해 해결했다. 고정된 Moby
기본 프로필에 `clone`, `unshare`, `mount`, `umount2`, `pivot_root` 예외를
추가했다. `clone`은 새 사용자 네임스페이스 생성으로, `unshare`는 지정한
네임스페이스 플래그로 제한한다. 컨테이너 capability를 추가하지 않았으며,
Codex 내부의 읽기 전용 샌드박스와 네트워크 차단도 유지한다.

실제 모델 작업까지 검증한 환경은 OrbStack의 Docker 29.4.0 arm64와
Colima의 Docker 29.5.2 arm64이며, Codex 버전은 0.159.3이다. Colima에서는
전용 AppArmor 프로필을 함께 사용한다. 다른 호스트나 버전에서는 아래 검사로
동작과 차단 경계를 다시 확인해야 한다.
캐시나 임시 파일 쓰기를 요구하는 프로젝트 테스트는 읽기 전용 정책에
맞는 별도 작업 경로를 설계해야 한다.

## 개발 검증과 종료

2026-10-02 OrbStack에서 확인한 결과:

| 검사 | 결과 |
| --- | --- |
| Bun 회귀 테스트 / TypeScript 검사 | 17개 통과 / 통과 |
| Compose 구성 / 이미지 빌드 / 준비 검사 | 통과 |
| 컨테이너 전용 ChatGPT 로그인 | 성공 |
| 실제 명령 재검증 | 소스 원문 미제공 상태에서 파일 읽기와 Bun 실행 성공; 모두 종료 코드 0 |
| 후속 요청 | 이전 식별자와 검증 우선순위 회상 |
| 컨테이너 강제 재생성 후 요청 | 인증/작업 유지, 동일 대화 ID 복원, 이전 결과 회상 |
| 실행 중 취소 | 네이티브 턴 수락 후 취소, 최종 `interrupted` 확인 |
| `/workspace` 및 `/app` 쓰기 시도 | 모두 `EROFS`로 거부 |
| Codex 내부 `/workspace` 및 `/agent/state` 쓰기 | 모두 `EROFS`로 거부 |
| Codex 내부 네트워크 | 샌드박스 밖에서 접근 가능한 대조 서버에 연결 시 `EPERM` |
| seccomp 예외 필요성 | 추가한 호출 5개를 각각 제거하면 bwrap 기동 실패 |
| Origin 요청 / 잘못된 JSON | 각각 403 / 400 |

실제 모델은 계정 기본 모델인 `gpt-6.1-sol`이었다. 초기 분석/대화 요청 세 번과
취소 한 번에 이어 `live-bwrap-review-20261002` 작업으로 실제 명령을 재검증했다.
네이티브 도구 기록에서 소스 읽기와 Bun 실행의 종료 코드 0을 확인했다.
실행 출력은 `(0,0): NaN`, `(1,10): 0.1111111111111111`, `(10,10): Infinity`다.
이 결과는 의도적으로 잘못 작성한 fixture를 실행한 증거이며, 함수는 수정하지 않았다.

2026-10-02 Colima에서도 `colima-apparmor-review-20261002` 작업으로
파일 읽기와 Bun 실행을 확인했다. 네이티브 도구 기록에서 두 명령의 종료 코드
0과 위의 동일한 출력을 확인했다. 컨테이너를 강제 재생성한 후에도 ChatGPT
인증과 기존 작업이 유지됐으며, `colima-resume-review-20261002` 후속 작업이
같은 대화 ID를 사용해 이전 식별자와 세 실행 결과를 정확히 회상했다.
이는 해당 대화의 복원 검증이며 장기 기억의 일반적인 정확도 평가는 아니다.

저장소 루트의 설치된 Bun/TypeScript 도구로 검사한다.

```sh
bun test experiments/codex-specialists/src
bun run --bun tsc -p experiments/codex-specialists/tsconfig.json --noEmit
git diff --check
```

실험 디렉터리에서 seccomp 생성 결과와 실제 샌드박스를 검사한다.
두 검사는 모델을 호출하지 않는다. 샌드박스 검사는 대조용 파일과 로컬 서버를
잠시 만들고 정리하며, 소스 읽기와 파일 쓰기·네트워크 차단을 확인한다.

```sh
bun security/profile.ts --check
docker compose exec -T verifier bun src/verify-sandbox.ts
```

실험 디렉터리에서 다음을 실행하면 컨테이너만 종료하고 볼륨은 유지한다.

```sh
docker compose down
```

볼륨에는 인증 정보와 작업 내용이 있으므로 Git에 추가하지 않는다.
볼륨을 삭제하면 로그인과 대화/작업 상태도 삭제된다. 위 Compose 단독 실행은
Cheshi의 에이전트 등록·협업 중계와 별도로 동작하며 상시 원격 운영을 포함하지 않는다.

## Cheshi에 등록한 워커의 Jev 기억 조회

Cheshi 런타임으로 시작한 워커는 새 대화에 `history_search`와 `history_read`를
등록한다. 기존 워커는 **Start agent**로 최신 이미지를 적용해야 한다.
Codex 0.159.3의 저장된 대화는 생성 당시 도구 구성을 유지하므로, 업데이트 전에
시작한 작업의 재개에는 새 도구가 추가되지 않는다. 새 작업에서 사용할 수 있다.

검색 범위는 동일 프로젝트·계정에 연결한 해당 에이전트의 워커 저장소로 고정한다.
모델이 계정, 파일 경로, 임의 RPC를 지정해 범위를 넓힐 수 없다. 호스트가 등록된
작업의 네이티브 대화만 인증된 POST 경로로 읽으며, 생성한 요약·협업 재개 문구와
시스템 지침·도구 출력은 검색 대상에서 제외한다. 사용자 입력은 저장한 원본 작업
문구와 대응되는 부분만 반환하고, 출처의 대화·턴·항목 ID는 유지한다. 예전 기록에서
원본 작업 문구와 연결할 수 없는 사용자 입력은 제외되므로 전체 네이티브 로그의
완전한 검색을 의미하지 않는다.

History Recall 설정이 켜져 있을 때만 호스트의 기존 Jev 키를 사용한다. 키는
컨테이너에 전달하지 않는다. 검색은 기존 Jev 평가기·페이지 처리·사용량 계산을
재사용하며, 이 워커 경로는 Jev 실패를 다른 모델로 자동 대체하지 않는다.
`history_read`는 모델을 호출하지 않는다. 검색 결과에는 원문, 출처 ID, 다음 페이지,
증분 사용량과 추정 비용이 포함된다. 알 수 없는 비용은 0으로 표시하지 않는다.

검색 요청은 `/history/exchange`로 비동기 중계하므로 협업 메시지 전달을 막지 않는다.
작업 중단·시간 초과·설정 비활성화 시 검색을 취소하고, 전달 직전에 원문을 재검증한다.
워커와 호스트는 요청·결과를 각자의 비공개 상태 파일에 기록한다. 재시작 시 처리 중인
요청은 결과 불명 오류로 마무리하고 유료 요청을 자동 재실행하지 않는다. 완료 결과는
같은 요청 ID에 한 번 처리하며, 워커 교체로 인증 토큰이 바뀌면 이전 중계 결과를
새 연결에 전달하지 않는다. 목표 판단과 완료 판정은 이 기억 조회와 별도 기능이다.

관련 회귀 검증:

```sh
bun test desktop/test/agent-history.test.ts desktop/test/agent-orchestration.test.ts
bun test desktop/test/agent-orchestration-process.test.ts
bun run desktop:typecheck
bun run codegraph:server:typecheck
node --test desktop/test/config-runtime.test.ts
```

## 지속형 목표의 다음 행동 판단

현재 Cheshi에서 **Start agent**로 워커를 갱신한 뒤 시작하는 새 작업에는
`goal_status`와 `record_decision`이 제공된다. 기존 대화에는 새 도구를 강제로
추가하지 않으며, 기존 작업과 읽기 전용 동료 상담은 종전 동작을 유지한다.

에이전트는 원래 목표에서 완료 조건을 정하고, 매 턴 마지막에 진행 상황·판단 이유와
`continue`, `wait`, `blocked`, `complete` 중 하나를 기록한다. 첫 판단이 확정된 뒤에는
완료 조건의 문구를 바꾸거나 줄일 수 없고, 조건별 충족 여부와 근거만 갱신한다.
판단은 턴이 정상 종료된 뒤에만 적용한다. 판단 없이 응답만 끝내면 목표 완료로
처리하지 않고 `interrupted` 상태로 중단 사유를 남긴다.

- `continue`: 다음 행동을 저장하고 워커의 다음 실행 기회에 같은 대화를 재개한다.
- `wait`: 미해결 동료 질문 또는 검증 요청이 있어야 한다. 모델을 호출하지 않고 결과를 기다린다.
- `blocked`: 부족한 정보·권한·기능을 설명하고 `interrupted`로 중단한다.
- `complete`: 모든 완료 조건에 근거가 있고 처리할 질문이 남지 않아야 완료한다.

판단·진행 상황·완료 조건·턴 수는 `/agent/state/agent.json`의 작업별 `goal`에 저장한다.
계속 작업할 차례 또는 답변 대기 중 재시작하면 상태와 대화가 유지된다. 실행 중
결과가 불명확해진 작업은 `unknown`으로 보존하며 자동 재실행하지 않는다.
목표 전체에 고정된 턴·시간·비용 상한은 없다. 명령 결과와 오류 진단, 파일 변경, 도구 결과,
저장된 협업 요청·수신 답변에서 새 관측 결과가 없는 판단 턴이 세 번 연속되면 사유와 함께 중단한다.
모델의 진행 보고 문구만 바뀌어도 진전으로 인정하지 않는다. 이는 반복 감지 신호이며
완료 근거 검증을 대신하지 않는다. 답변 대기는 모델을 호출하지 않는다.
사용자가 후속 입력을 보내면 같은 목표·완료 조건·누적 턴 수를 유지하고 반복 감지 구간을
새로 시작한다. 최근 판단과 관측 지문은 각각 64개를 보관하며 전체 턴 수를 제한하지 않는다.
대기 또는 계속 작업 예약도 기존 취소 기능으로 중단한다. 단일 실행의 통신 타임아웃과
unknown 자동 재실행 금지는 유지한다. Chats는 누적 턴 수와 목표 전용 대화의 누적 모델 토큰과
마지막으로 보고된 턴를 표시하며, 미수집 사용량·비용은 Unknown으로 둔다. Jev 사용량은 기존
기억 조회 상세에서 별도로 확인한다. 개발앱 재시작 후 Start agent로 워커를 갱신한다.

Jev는 과거 근거를 찾는 데 사용하고, 다음 행동은 에이전트 모델이 결정한다.
동료 상담은 계속 읽기 전용이며 변경 작업의 위임 권한을 추가하지 않는다.

## 독립 검증과 완료 조건

최신 앱에서 **Start agent**로 갱신한 워커의 새 목표에는 `verificationRequired`가
저장된다. `request_verification`으로 같은 프로젝트의 별도 `verification` 역할
에이전트를 선택한다. 요청 시 원래 목표·완료 조건과 검증할 파일의 SHA-256을
저장하고, 이미 정한 완료 조건을 바꾸거나 자기 자신에게 검증을 요청할 수 없다.
구현 파일뿐 아니라 테스트와 관련 의존 파일도 대상에 포함해야 한다.

검증 에이전트는 프로젝트를 읽기 전용으로 실행한다. 명령 실행은 **검증 에이전트
자신의 Run commands 설정**이 켜져 있을 때만 가능하며, 요청자의 권한을 상속하지
않는다. `verification_read`의 파일 읽기 기록과 네이티브 app-server가 보고한 실제
명령 시작·종료·종료 코드·출력을 런타임이 수집한다. 모델이 도구 인자로 실행 결과를
작성해서 이 기록을 대체할 수 없다. `verification_status`로 수집된 기록을 조회한다.

`submit_verification`은 조건별 `pass`, `fail`, `inconclusive`와 근거 기록 ID를
받는다. 통과에는 모든 대상 파일의 읽기 기록, 조건별 파일 근거와 성공한 명령 근거가
필요하다. 실패한 명령이나 존재하지 않는 기록을 근거로 통과할 수 없다. 명령 실행이
불가능하면 `inconclusive`로 보고한다. 결과는 검증 턴이 정상 종료된 뒤 전달하며,
파일 버전은 읽기·명령 시작/종료·검증 결과 확정·목표 완료 시 다시 확인한다.

요청·결과는 작업 ID, 요청 ID, 발신자·수신자에 묶어 영속화한다. 첫 검증이 실패하면
원래 개발 목표가 같은 대화에서 재개되어 수정하고 새 검증 요청을 보낸다. 최신 요청의
모든 조건이 통과하고 그 결과를 처리했으며 현재 파일 해시가 같아야 최종 완료한다.
대기 중인 컨테이너를 재생성해도 요청이 이어진다. 중복 결과는 한 번만 처리하며,
취소된 목표에는 늦은 결과를 기록하되 판단을 재개하지 않는다. 실행 중 종료되어
결과가 불명확하면 기존 `unknown` 정책으로 자동 재실행을 막는다.

현재 파일 검증 범위는 요청당 1–16개의 프로젝트 상대 경로, 파일당 64 KiB 이하의
일반 파일이다. 심볼릭 링크와 `.git` 경로는 거부한다. 메시지 한도는 12,000자,
검증 작업당 근거 기록은 32개다. 파일 검사와 완료 처리는 외부 편집기와 원자적인
트랜잭션을 이루지 않는다. 기록된 파일 버전과 실행 결과를 확인하는 기능이며,
명령의 적절성·누락된 요구사항·전체 의존성의 완전성은 별도 검증 에이전트의 판단이다.
임의의 목표가 완벽히 구현됐다는 수학적 증명을 제공하지 않는다.

재현 가능한 검증은 저장소의 테스트로 제공하며, 임시 스크립트가 런타임 기능을
대체하지 않는다. 아래 첫 명령은 프로토콜 응답만 고정하고 Docker 내 파일 수정과
테스트 실행은 실제로 수행한다. 두 번째 명령은 명시적으로 선택한 기존 워커의
ChatGPT 인증을 격리된 테스트 볼륨에서 사용하며 실제 모델 호출이 발생한다.
인증 사본은 이미지·출력에 포함하지 않고 테스트 후 전용 자원과 함께 제거한다.

```sh
CHESHI_ORCHESTRATION_DOCKER_CONTEXT=colima-cheshi bun test desktop/test/agent-verification-docker.test.ts
CHESHI_ORCHESTRATION_DOCKER_CONTEXT=colima-cheshi CHESHI_TEST_REAL_CODEX=1 CHESHI_VERIFICATION_AUTH_CONTAINER=<existing-worker-name> bun test desktop/test/agent-verification-docker.test.ts
```


### Chats 구현 위임: 격리된 제안 제출

`workProtocol: 1` 워커는 `request_work`, `work_status`, `review_work`와
수신 작업용 `work_read`, `work_write`, `submit_work`를 지원한다.
개발앱을 재시작하고 Start agent로 코드가 갱신된 워커를 사용한다.

- 같은 프로젝트·엔진의 같은 방에 참여하며, 위임자와 수신자 모두 기존 File write
  권한이 있어야 한다. 초대나 위임 자체는 권한을 추가하지 않는다.
- 요청에는 목표, 완료 조건, 정확한 읽기/쓰기 파일 경로와 기준 스냅샷이 포함된다.
  1차 구현은 최대 32개 UTF-8 텍스트 파일, 파일당 128 KB, 직렬화된 요청/결과당
  256,000자까지 지원한다. 디렉터리 전체, 바이너리, symlink, Git 메타데이터는 거부한다.
- 원본의 선택된 파일 내용(디스크에 저장된 미커밋 변경 포함)을 캡처한다. 편집기의
  미저장 내용은 포함하지 않는다. 캡처 도중 변경을 감지하면 새 요청을 요구한다.
- 수신자의 `/agent/work/<request-id>/`에 별도 복사본을 보존한다. 모델의 네이티브
  명령과 파일 도구에는 해당 복사본도 읽기 전용이다. `work_write`만 지정된 파일을
  수정하며, 원본 프로젝트를 덮어쓰지 않는다. 명령 권한이 있다면 기존 임시 작업
  공간을 이용해 읽기 전용 검사를 실행할 수 있다. 의존성 설치·전체 저장소 복사는
  자동 수행하지 않으므로 필요한 문맥 파일을 요청에 포함해야 한다.
- 실제 파일 내용과 전후 SHA-256은 워커가 수집한다. `submit_work`는 모델 턴이
  성공한 뒤 결과로 전달된다. 제출 누락, 실패, 중단은 성공 제안으로 승격하지 않는다.
- 담당 목표는 결과를 받고 판단을 재개한다. `review_work`의 accepted는 제안 검토
  기록이며 프로젝트 반영이나 독립 검증 통과가 아니다. changes_requested 후에는
  새 requestId와 previousRequestId로 이전 제안에서 범위를 넓히지 않고 수정한다.
- 요청과 결과는 기존 영속 메시지 중계로 전달한다. 동일 ID 재전달은 실행을 추가하지
  않는다. 실행 중 재시작은 unknown으로 보존하고 자동 재실행하지 않는다. 정확한
  네이티브 턴 종료를 확인하고 제출본이 실제 파일과 일치할 때만 제안을 복구한다.
- Chats 스레드에서 위임 범위·변경 내용·해시·검토 기록을 확인하고 Delegated task로
  수신자의 실행 상태 및 복구 화면을 연다.

호스트와 워커는 `src/work-contract.ts`의 동일한 계약을 사용한다. 데스크톱 패키지는
해당 계약 파일들을 명시적으로 포함하고 실험용 테스트·fixture는 포함하지 않는다.

### 통합 후보 준비와 충돌 검사

`integrationProtocol: 1` 워커에서 새로 생성한 목표는 `prepare_integration`과
`integration_status`를 제공한다. 기존 네이티브 대화는 생성 당시 도구 구성을 유지하므로
워커 갱신만으로 새 도구를 추가하지 않는다. 기존 목표의 대화와 작업 상태는 보존한다.

- 목표 담당자가 같은 방·목표에서 수락한 최종 제안들을 선택한다. 최초 요청까지 수정
  이력을 추적하므로 이전 수정 단계에서 만든 변경도 현재 범위 안에서 누적 반영한다.
- 읽기 전용 문맥을 포함한 최초 원본 해시를 현재 프로젝트와 비교한다. 서로 다른 파일과
  동일한 수정은 합치고, 같은 파일의 다른 수정·삭제, 경로 충돌, 다른 기준본은 중단한다.
  줄 단위 자동 병합은 하지 않는다. 통합 범위는 최대 32개 텍스트 파일이며, 후보도
  파일당 128 KB·직렬화된 스냅샷 256,000자 제한을 따른다.
- 원본을 수정하지 않고 담당 워커의 `/agent/integrations/` 영속 공간에 후보와 기준본,
  해시, 요청 ID, 충돌 근거를 저장한다. 동일 요청 재시도는 같은 기록을 반환하며
  재시작이나 응답 유실 때문에 후보를 다시 생성하지 않는다.
- Chats와 작업 상세에서 prepared/conflict/stale/invalid 상태와 파일별 해시·문제를
  표시한다. 조회할 때 후보와 원본을 재검사하며, 원본 변경이나 저장 파일 손상을
  준비 완료로 표시하지 않는다. 실패한 시도는 보존하고 해결 후 새 요청 ID를 사용한다.
- 후보 준비는 프로젝트 반영이나 검증 통과가 아니다. 아래 독립 검증이 통과해도
  원본 반영은 별도 단계이며, 후보만으로 목표를 완료 처리하지 않는다.

`src/integration-contract.ts`를 호스트와 워커가 공유한다. 다음 자동 테스트는 실제 임시
파일과 영속 저장소를 사용하고 모델·Docker 통신은 테스트 대역으로 실행한다.

```sh
bun test experiments/codex-specialists/src/integration.test.ts desktop/test/agent-work.test.ts
```

### 통합 후보의 독립 검증

`candidateVerificationProtocol: 1` 워커는 기존 `request_verification` 도구로 후보를
검증한다. 호스트와 워커를 갱신해야 하며, 이미 통합 도구가 있는 목표는 같은 대화를
재개할 수 있다. 새로운 동적 도구를 기존 네이티브 대화에 추가하지 않는다.

- 후보가 있는 목표는 원본 프로젝트 검증으로 우회할 수 없다. 현재 준비된 후보의
  모든 파일과 삭제 상태, 후보 ID·해시, 수락한 제안 ID를 보낸다. `paths`에는 읽기 전용
  문맥까지 포함한 전체 후보 경로를 지정한다. 원래 완료 조건을 유지해야 한다.
- 같은 방의 검증 역할 에이전트가 수행하며 목표 담당자와 후보 작성자는 제외한다.
  호스트도 수락된 제안 이력과 후보 내용·해시를 확인한 뒤 영속 중계한다.
- 검증자의 `/agent/verification-candidates/<request-id>/`에 복사본을 보존한다.
  네이티브 실행의 작업 폴더는 이 복사본이며 읽기 전용이다. 명령 실행 권한이 있어야
  검사를 실행할 수 있고 쓰기는 기존 임시 테스트 폴더에만 허용한다. 테스트·의존성은
  위임 시 선택한 범위에 포함해야 하며 자동 설치나 전체 프로젝트 복사는 하지 않는다.
- `verification_read`는 모든 후보 파일과 삭제 상태의 근거를 기록한다. 통과에는 실제
  네이티브 명령의 성공 근거가 필요하다. 후보 ID·해시는 워커가 결과에 부착하고,
  후보 변경이나 근거 부족은 통과시키지 않는다. 최대 32개 파일·64개 근거를 보존한다.
- 재시작 후 `unknown`은 정확히 저장된 네이티브 턴의 종료를 확인한다. 실행 종료와
  검증 통과는 별도이다. 확정된 제출·기록된 근거·후보 복사본이 모두 일치해야 통과를
  복구하며, 유실된 복사본을 자동 재생성하지 않는다.
- Chats와 작업 상세는 pending/pass/fail/inconclusive/stale 및 검증 근거를 표시한다.
  원본 또는 후보가 변경되면 이전 통과는 stale로 표시한다. 새 후보에는 이전 결과를
  재사용하지 않는다. 원본 적용 및 최종 목표 완료는 아래 applicationProtocol 단계에서 별도로 처리한다.

다음 자동 검증은 실제 임시 파일·영속 저장소를 사용하며 모델·Docker 통신은 대역이다.

```sh
bun test experiments/codex-specialists/src/candidate-verification.test.ts desktop/test/agent-candidate-verification.test.ts
```


### 검증 후보의 원본 적용과 완료 판정

`applicationProtocol: 1`로 호스트·워커를 갱신한 뒤 **새 목표**를 만들면
`apply_integration`, `recover_integration`을 사용할 수 있다. 기존 네이티브 대화에는
새 도구를 주입하지 않으며, 해당 대화의 기록과 상태는 보존한다.

- 적용은 목표 담당자의 기존 Write files 권한과 방 참여가 필요하다. 실제 Docker/VM
  공유도 쓰기 가능해야 한다. 권한이나 Colima 공유를 자동으로 확대하지 않는다.
- 현재 후보 ID·해시, 수락한 제안 이력, 원래 완료 조건의 독립 검증 통과를 확인한다.
  읽기 전용 문맥까지 원본 해시를 다시 비교하고, 선택된 변경 파일만 적용한다.
- 프로젝트의 `.cheshi-integration-lock`으로 Cheshi 적용 작업을 직렬화한다.
  기존 락은 다른 워커가 자동 제거하지 않는다. 파일 추가는 배타적으로 생성하며
  수정은 기존 모드를 보존한 파일 교체, 삭제는 명시된 경로에만 수행한다.
- 후보 디렉터리의 `application.json`에 쓰기 전 의도와 파일별 결과를 먼저 기록한다.
  원본·후보 내용은 기존 manifest에 보존한다. 동일 요청은 이전 상태를 반환하고
  중단된 쓰기를 재실행하지 않는다. 여러 파일 전체를 원자적으로 교체하지 않으며,
  외부 편집기는 Cheshi 락을 따르지 않으므로 편집 충돌을 완전히 잠그는 기능은 아니다.
- `recover_integration`은 파일을 쓰거나 되돌리지 않고 before/after/changed/unavailable를
  비교한다. 모든 쓰기 의도와 실제 결과가 일치하면 applied, 전부 원본이면 aborted로
  기록하고 소유한 락을 해제한다. 일부만 적용되거나 외부 변경이 있으면 interrupted/
  conflict로 남겨 사용자 검토를 요구한다. 손상·유실된 기록으로 성공을 추정하지 않는다.
- 적용 후 새 requestId로 `request_verification`을 호출한다. 검증자는 후보 복사본이
  아닌 실제 프로젝트를 읽기 전용으로 검사한다. 전체 대상 경로와 삭제 상태, 후보 ID·해시,
  적용 ID를 결과에 연결한다. 명령 쓰기는 기존 scratch 공간에만 허용한다.
- 후보 검증 결과와 프로젝트 검증 결과는 서로 대체할 수 없다. 담당 목표는 프로젝트
  검증 응답을 처리하고 모든 최종 제안의 적용을 확인한 뒤 완료 판단을 기록한다.
  턴 종료 직전에도 재검사하며 변경된 원본이나 실패·불확실한 검증을 완료로 처리하지 않는다.
- Chats와 작업 상세의 **Inspect application**은 현재 후보 ID·해시에 해당하는
  적용 기록과 실제 파일을 비교한다. `applicationInspectionProtocol: 1` 워커 갱신이
  필요하지만 기존 목표에서도 사용할 수 있다. 모델 호출·쓰기 재실행·자동 재개·완료
  판정은 하지 않는다. 실행 중인 작업을 멈추고 unknown 실행 결과를 먼저 확인해야 한다.
- 적용 의도는 프로젝트 락 생성 전부터 기록한다. 복구가 applied/aborted를 확인하고
  락 해제까지 확인하면 `lockReleased: true`를 영속화한다. 부분 적용·외부 수정은
  미해결 상태로 남기며, 이 확인 자체가 독립 검증 통과를 뜻하지 않는다.
- 삭제 전에는 실행 중·중지된 컨테이너와 에이전트의 분리된 저장 볼륨을 검사한다.
  네트워크·capability가 없는 일회성 읽기 전용 검사 컨테이너로 저장 기록을 읽으며
  워커나 모델을 실행하지 않는다. 로컬 `cheshi-specialist:1` 이미지가 없거나 기록을
  읽을 수 없으면 삭제를 중단한다. 미해결 적용과 유실·손상된 복구 기록은 데이터 보존을
  선택해도 에이전트 삭제를 막는다. 기존 완료 기록도 락 해제 표식이 없으면 명시적으로
  Inspect application을 실행한 뒤 삭제해야 한다.

```sh
bun test experiments/codex-specialists/src/integration-application.test.ts desktop/test/agent-application.test.ts
bun test desktop/test/agent-application-storage.test.ts desktop/test/agent-deletion.test.ts desktop/test/agent-chats.test.ts desktop/test/agent-chats-views.test.tsx
```

이 테스트는 실제 임시 파일과 저장소에 적용·복구를 실행한다. 모델 및 Docker 통신은
대역이며, 개발앱의 실제 모델·컨테이너 검증과는 구분한다.
