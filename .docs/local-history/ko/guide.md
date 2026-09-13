# 파일 로컬 기록

Cheshi는 Git 커밋과 별개로 워크스페이스의 텍스트 파일 변경 이력을 자동 기록합니다.
탐색기 파일 메뉴의 **Local history** 또는 에디터의 기록 아이콘을 누르면
작업 영역에 해당 파일의 기록 페이지가 열립니다. 페이지를 닫으면 이전 화면으로 돌아갑니다.

## 기록과 복원

- 에디터에서 파일을 열면 현재 내용을 최초 기록으로 보관합니다.
- 저장할 때 원본과 저장 결과를 기록하며, 동일한 내용은 중복 기록하지 않습니다.
- 앱의 파일 감시기가 감지한 외부 변경도 기록합니다. 처음 감지하기 전에 덮어쓴
  내용, 앱이 닫혀 있을 때의 중간 변경, 짧은 시간에 일어난 모든 중간 상태는
  보장하지 않습니다. 최초 실행 시 프로젝트 전체를 읽는 작업은 수행하지 않습니다.
- 기록 목록에서 시점을 선택하면 해당 내용과 현재 디스크 파일을 좌우로 비교합니다.
  큰 변경은 단순화하거나 표시 행을 제한하며, 화면에 그 사실을 표시합니다.
- 복원 전 현재 내용을 보관합니다. 비교 후 디스크 파일이 바뀌었으면 복원을
  중단하고 새 비교 내용을 표시합니다. 미저장 편집 내용이 있으면 먼저 저장해야 합니다.

## 보관 범위

기록은 Cheshi 사용자 데이터의 `workspaces/<workspace-id>/local-history/`에 저장됩니다.
기본 보관 기간은 30일이며, 워크스페이스당 내용과 메타데이터 합계 100MiB,
최대 10,000개 기록을 유지합니다. 읽거나 기록할 때 한도를 넘는 오래된 이력을
정리합니다. 각 내용은 해시로 중복 제거하고 메타데이터는 원자적으로 교체합니다.

기존 에디터에서 지원하는 UTF-8 텍스트 파일을 대상으로 합니다. 이미지·바이너리·
편집 제한 크기를 넘는 파일, Git 내부 파일은 기록하지 않습니다. 외부 변경 감시에서는
의존성과 일반적인 빌드 결과 폴더를 제외합니다. 해당 텍스트 파일을 에디터에서
명시적으로 열거나 저장하면 기록할 수 있습니다.

기록은 파일 경로별로 관리합니다. 이름 변경 전 기록은 이전 경로에 남으며,
삭제된 파일의 재생성과 프로젝트 전체 복원은 현재 제공하지 않습니다.
이 기능은 이 컴퓨터의 작업 복구용이며 별도의 백업이나 원격 저장을 수행하지 않습니다.

## 검증

```sh
bun test desktop/test/local-history-service.test.ts desktop/test/local-history-store.test.ts desktop/test/local-history-runtime.test.ts desktop/test/local-history-ui-model.test.ts
bun run desktop:preload
node --test desktop/test/workspace-ipc.test.ts desktop/test/workspace-preload.test.ts
bun test desktop/test/workspace-status-bar.test.tsx
bun run viewer:typecheck
bun run desktop:typecheck
bun run codegraph:server:typecheck
bun run viewer:build
```
