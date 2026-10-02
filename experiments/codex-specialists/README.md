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
작업 위임, 검토 요청, 목표 완료 기준 검사, Jev를 이용한 판단, 질문 만료와
`unknown` 복구는 후속 범위다. 상대가 중단되어 있으면 질문을 보관하고,
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
현재 실험에는 `unknown` 상태를 해제하는 복구 API가 없다. 180초 제한 시간은
취소 요청을 보내지만 실제 종료를 증명하지 못하면 `unknown`을 유지한다.

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
볼륨을 삭제하면 로그인과 대화/작업 상태도 삭제된다. 이 실험은 별도 작업 큐,
에이전트 간 협업, Cheshi UI, 상시 원격 운영까지 포함하지 않는다.
