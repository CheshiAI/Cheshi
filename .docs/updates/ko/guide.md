# 앱 업데이트

Cheshi는 시작할 때 한 번, 실행 중에는 한 시간마다
[CheshiAI/Cheshi](https://github.com/CheshiAI/Cheshi/releases)의 공개 릴리즈를 확인합니다.
앱 시작은 네트워크 응답을 기다리지 않습니다. 절전 상태에서 깨어났을 때 마지막 확인 시도 후
한 시간 이상 지났으면 다시 확인합니다. 오프라인 상태나 요청 실패는 작업을 중단하거나
이미 발견한 업데이트를 제거하지 않습니다.

업데이트할 수 있는 새 릴리즈가 있으면 워크스페이스 상태 표시줄과 프로젝트 선택기에
**종 아이콘 / Update available** 표시가 나타납니다. 이 표시를 누르면 설치된 버전과
새 버전, 일반 텍스트로 된 릴리즈 노트 일부, **View full release**를 볼 수 있습니다.
**Cancel**은 대화상자를 닫고 업데이트 표시는 유지합니다. **Update**는 패키지를
다운로드하고 검증한 뒤 워크스페이스 복구를 준비하고 앱을 재시작합니다.
설치에 실패하면 다시 시도할 수 있습니다.

## 로컬에서 업데이트 UI 미리 보기

실행 중인 개발 앱을 닫고 저장소 루트에서 다음 명령을 실행합니다.

```sh
bun run desktop:dev:update-preview
```

이 명령은 개발 세션에 `CHESHI_UPDATE_PREVIEW=1`을 설정합니다. 상태 표시줄과 프로젝트
선택기에 영어 예제 릴리즈 노트를 포함한 가상의 `v0.0.2-alpha` 업데이트가 표시됩니다.
**Update available**을 누르면 대화상자가 열리고, **Cancel**을 누르면 업데이트 표시를
유지한 채 닫힙니다. **Update**는 다운로드와 설치 진행을 흉내 낸 뒤 의도적인 오류를
표시해 재시도 UI를 확인할 수 있게 합니다. 실제로 게시된 릴리즈가 아니므로
**View full release**는 비활성화됩니다.

미리 보기는 업데이트 확인 요청, 다운로드, 설치 변경, 워크스페이스 복구 상태 저장,
재시작을 수행하지 않습니다. 릴리즈도 게시하지 않습니다. 일반적인 앱 시작 과정은
그대로 실행됩니다. 패키징된 앱은 이 플래그를 무시합니다.
실제 업데이트 확인으로 돌아가려면 `bun run desktop:dev`로 다시 실행합니다.
셸에서 `CHESHI_UPDATE_PREVIEW`를 직접 export했다면 먼저 해제합니다.

## 버전과 릴리즈 채널

- 내부 테스트는 `v0.0.1-alpha`, `v0.0.2-alpha` 등의 버전을 사용합니다.
- 공개 Homebrew 배포는 별도로 `v0.0.1-preview`부터 시작하며, 이후
  `v0.0.2-preview`와 다음 preview 버전으로 이어집니다.
- Preview 설치는 더 최신인 preview와 정식 릴리즈를 확인하며 alpha는 제외합니다.
  정식 버전 설치는 정식 릴리즈만 확인합니다. Alpha 빌드는 내부 테스트를 위해
  더 최신인 alpha, preview, 정식 릴리즈를 모두 확인할 수 있습니다.
- 모든 버전은 SemVer 우선순위로 비교합니다. 더 높은 번호의 alpha에서
  `v0.0.1-preview`로 특별히 다운그레이드하지 않습니다. 공개 preview 배포를
  시작할 때는 내부 빌드를 수동으로 교체합니다.
- 초안 릴리즈는 무시합니다. 지원하는 사전 릴리즈 태그도 릴리즈 목록 조회에 포함되므로
  GitHub의 **Pre-release** 설정이 alpha나 preview 업데이트를 숨기지는 않습니다.
  릴리즈 노트는 원래 언어로 표시합니다.

## 설치 가능한 릴리즈 준비

빌드 전에 앱 버전을 설정하고 같은 버전의 GitHub 태그를 사용합니다.
예를 들어 앱 버전이 `0.0.2-alpha`이면 태그는 `v0.0.2-alpha`입니다.
지원하는 아키텍처마다 서명된 macOS 앱이 들어 있는 ZIP을 첨부합니다.
앱 업데이트 기능은 실제 버전과 아키텍처를 대입한 다음 두 파일 이름을 지원합니다.

- `Cheshi-0.0.2-alpha-darwin-arm64.zip`
- `Cheshi-darwin-arm64-0.0.2-alpha.zip`

버전은 `.env.product`의 `APP_VERSION`에서 읽습니다. 배포용 빌드를 만들 때마다
`APP_BUILD_NUMBER`도 올립니다. Forge는 루트 `package.json`의 개발용 버전과 별개로
이 값을 앱 버전과 ZIP 파일 이름에 동일하게 사용합니다.

서명·공증된 macOS ZIP은 `bun run desktop:make:signed`로 빌드합니다.
이 명령은 Git에서 제외된 `.env.signing` 파일을 읽고 Forge에
`CHESHI_SIGN_RELEASE=1`을 설정합니다. 해당 로컬 파일이나 빌드 환경에 다음 값을 지정합니다.

```dotenv
MACOS_SIGNING_IDENTITY="Developer ID Application: Your Company (YOURTEAMID)"
MACOS_NOTARY_PROFILE="YourNotaryProfile"
```

서명 identity에는 회사 이름과 Team ID가 포함됩니다. `.env.signing`은 Git과
패키징된 앱에서 제외됩니다. 서명 빌드에는 두 값이 모두 필요하며, 값이 없으면
다른 identity나 profile로 대체하지 않고 설정 단계에서 실패합니다.
빌드 장비에는 개인 키를 포함한 인증서와 검증된 공증 프로필이 있어야 합니다.
자격증명은 macOS 키체인에 보관하며 비밀번호나 개인 키를 저장소에 추가하지 않습니다.
서명 또는 공증에 실패하면 빌드도 실패합니다.

서명하는 macOS 빌드는 Forge가 서명하기 전에 새로 컴파일한 Bun 실행 파일을 정규화합니다.
일부 Bun 버전은 Mach-O 코드 서명 뒤에 컴파일러 템플릿의 바이트를 남겨
`main executable failed strict validation` 오류를 일으킵니다. 빌드 과정은 선언된
바이너리 범위를 검증한 뒤 사용하지 않는 끝부분을 제거하며, 서명 검증을 건너뛰지 않습니다.
Forge는 첫 서명 오류에서 중단하며 서명되지 않은 앱의 공증을 시도하지 않습니다.
컴파일러의 남은 서명 데이터와 마지막 페이지 해시 문제는
[Bun 서명 결함 분석](https://github.com/oven-sh/bun/pull/32162)을 참고합니다.
Forge는 컴파일러의 임시 서명을 검증된 Developer ID 서명으로 교체합니다.

일반 `desktop:make`와 `desktop:package` 명령은 `CHESHI_SIGN_RELEASE=1`을
명시적으로 설정하지 않으면 서명이나 공증을 요청하지 않습니다.
서명 빌드 명령은 현재 장비의 아키텍처와 설정된 앱 버전을 사용합니다.
버전을 변경하거나 릴리즈를 게시하거나 GitHub에 업로드하지 않습니다.
공증 과정에서는 패키징된 앱을 Apple에 업로드합니다. 공개 배포 전에 생성된 앱의
서명과 공증 티켓, 새 설치, 서명된 빌드 사이의 실제 업데이트를 확인합니다.

## 릴리즈 게시와 Homebrew 갱신

태그를 만들기 전에 릴리즈 변경을 `main`에 머지합니다. 검토한 커밋에서
`.env.product`의 버전·빌드 번호를 확인하고 `bun run desktop:make:signed`로 빌드합니다.
GitHub 초안 릴리즈를 만든 뒤 검증된 `Cheshi-darwin-arm64-<version>.zip`을 업로드하고
릴리즈를 게시합니다. 게시 전에 ZIP을 올려야 Homebrew 워크플로가 즉시 파일을 찾을 수 있습니다.

[Update Homebrew tap](../../../.github/workflows/update-homebrew.yml)은 정식 및 preview
릴리즈의 `release: published` 이벤트로 실행되며 alpha 릴리즈는 건너뜁니다.
`main`에서 자동화 코드를 읽고
[`scripts/update-homebrew-tap.mts`](../../../scripts/update-homebrew-tap.mts)를 실행합니다.
스크립트는 해당 릴리즈의 정확한 ZIP을 다운로드해 크기와 SHA256을 GitHub asset
메타데이터와 대조한 뒤 `CheshiAI/homebrew-tap`의 `main`을 갱신합니다.

- `Casks/cheshi.rb`의 버전과 SHA256을 하나의 커밋으로 갱신합니다.
- 기존 URL 템플릿은 새 태그와 버전이 포함된 ZIP 이름을 가리킵니다.
- 앱 의존성과 설치 설정은 유지합니다.
- 같은 릴리즈를 다시 처리해도 중복 커밋을 만들지 않습니다. 이전 릴리즈로 Cask를
  다운그레이드할 수 없습니다. 기존 버전의 체크섬이 달라졌으면 실패합니다.
  이미 배포한 파일을 교체하지 말고 새 버전을 게시합니다.

워크플로에는 `CheshiAI/Cheshi` 저장소의 Actions Secret인 `HOMEBREW_TAP_TOKEN`이
필요합니다. `CheshiAI/homebrew-tap` 접근 권한이 있는 계정에서 fine-grained PAT를
만들고, 대상 저장소를 해당 tap으로 제한해 **Contents: read and write** 권한을 부여합니다.
조직에서 토큰 승인을 요구하면 그 절차도 완료합니다. 토큰 값은 GitHub의 Actions secrets
화면에 등록하며 소스, 릴리즈 노트, 셸 인자, 채팅에 넣지 않습니다.
워크플로의 기본 `GITHUB_TOKEN`은 읽기 권한만 가지며 다른 저장소에 쓸 수 없습니다.
권한 오류를 진단할 때는 전용 토큰의 만료 여부도 확인합니다.

릴리즈는 권한이 있는 로컬 GitHub CLI 세션이나 GitHub UI로 게시합니다.
워크플로의 `GITHUB_TOKEN`으로 게시하면 후속 릴리즈 워크플로가 실행되지 않습니다.
나중에 게시 작업도 Actions로 옮긴다면 적절한 권한의 GitHub App/토큰을 사용하거나
이 워크플로를 명시적으로 실행합니다.

Homebrew 갱신 실패 원인을 해결한 뒤 다시 시도하려면 Actions → Update Homebrew tap →
Run workflow에서 `main`과 기존 공개 태그를 선택하거나 다음 명령을 실행합니다.

```sh
gh workflow run update-homebrew.yml --repo CheshiAI/Cheshi --ref main -f tag=v0.0.3-preview
```

Homebrew 갱신을 재시도하기 위해 릴리즈를 다시 게시하지 않습니다.
쓰기 응답이 중간에 끊겼다면 현재 Cask와 실행 결과를 먼저 확인합니다.
다른 작업에서 Cask를 동시에 수정하면 기존 blob SHA 검사가 실패해 해당 변경을
덮어쓰지 않습니다. 충돌한 변경을 검토한 뒤 다시 시도합니다.

다음 읽기 전용 사전 검증은 기존 공개 ZIP을 다운로드하고 검증합니다.
tap 토큰이 필요하지 않으며 커밋을 만들지 않습니다.

```sh
RELEASE_TAG=v0.0.2-preview bun run scripts/update-homebrew-tap.mts --dry-run
```

게시 후에는 Actions 실행이 성공했는지, tap의 버전·URL·SHA256이 공개 asset과
일치하는지 확인합니다. Homebrew 갱신이 실패해도 릴리즈 자체는 게시된 상태이므로
두 단계의 결과를 구분하고 실패한 단계부터 재개합니다. 로컬 테스트와 읽기 전용
사전 검증만으로 원격 쓰기 권한이 확인되지는 않습니다.
사용자는 `brew update` 실행 후 `brew upgrade --cask --greedy cheshiai/tap/cheshi`로
업데이트할 수 있습니다.

## 설치 파일 요구사항

Intel macOS 빌드는 `arm64` 대신 `x64`를 사용합니다. 파일은 `CheshiAI/Cheshi`의
해당 릴리즈에 속해야 하며 크기가 0보다 커야 합니다. GitHub asset의 `digest`에는
`sha256:` 뒤에 SHA-256 해시가 있어야 합니다. Electron이 설치를 준비하기 전에
다운로드한 파일의 크기와 해시를 기록된 값과 대조합니다.

현재 자동 설치는 유효한 Developer ID Application 서명이 있는 패키징된 macOS 앱에서
지원됩니다. 앱은 마운트된 이미지나 App Translocation 경로 밖의 쓰기 가능한 위치에서
실행돼야 합니다. 교체할 앱도 Electron의 서명된 업데이트 요구사항을 충족해야 합니다.
개발 모드에서는 업데이트 알림을 표시할 수 있지만 설치할 수는 없습니다.
지원하지 않는 플랫폼이거나 검증 가능한 ZIP이 없는 릴리즈는 설치가 비활성화되고
그 이유가 표시됩니다.

## 워크스페이스 복구

재시작 전에 Cheshi는 미저장 에디터 내용을 포함한 워크스페이스 복구 상태를 저장합니다.
진행 중인 채팅 작업이나 비어 있지 않은 채팅 초안이 있으면 사용자가 작업을 마치거나
초안을 비울 때까지 설치를 차단합니다. 워크스페이스 복원은 실행 중이던 터미널 명령을
다시 시작하지 않습니다. 해당 프로세스는 앱 종료 시 중단되며 수동으로 다시 실행해야 합니다.

이 기능을 추가하는 것만으로 GitHub 릴리즈가 게시되거나 설치 파일이 업로드되지는 않습니다.
실제 설치 과정을 처음부터 끝까지 검증하려면 별도로 게시한 서명된 릴리즈와
패키징된 이전 버전 앱이 필요합니다.
