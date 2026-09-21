# 실행 가능한 스킬

Cheshi 체크아웃에서 스킬마다 입력 검사, 실행 함수, 결과 검증 함수를 정의할 수 있습니다.
공통 실행기는 Jev 판단, Luna 폴백, 산출물 경로 검사와 `success` / `fail` 기록을 담당합니다.
새 스킬을 추가할 때 중앙 레지스트리 코드를 수정할 필요가 없습니다.

## 파일 구성

`.agents/skills/<name>/`에 다음 두 파일을 둡니다.

- `SKILL.md`: `name`, `description` frontmatter와 입력 및 실행 방법. 에이전트가 읽는 사용 설명입니다.
- `workflow.mts`: `defineSkill()`로 만든 실행 정의를 default export합니다.

이름은 소문자 영숫자와 하이픈으로 구성하며 64자 이내입니다.
`SKILL.md`의 코드 블록 자체를 실행하지는 않습니다.
모듈은 신뢰하는 저장소 코드이며 실행 명령의 권한으로 동작합니다. 별도 샌드박스가 아닙니다.

## 함수 작성 예

아래는 `.agents/skills/condition-note/workflow.mts` 위치를 기준으로 한 예입니다.

```ts
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineSkill } from '../../../desktop/lib/skill-flow-definition.mts';

export default defineSkill({
  name: 'condition-note',
  parseInput(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('문자열 필요');
    return value;
  },
  async run(ctx, input, env) {
    const urgent = await ctx.jev({ state: input, condition: '긴급한 요청인가?' });
    const file = path.join(env.directory, 'note.md');
    await writeFile(file, urgent ? '긴급 처리' : '일반 처리', { flag: 'wx' });
    return { outcome: 'success', artifacts: [file] };
  },
  async validate(result, _input, env) {
    const file = path.join(env.directory, 'note.md');
    if (result.artifacts?.length !== 1 || result.artifacts[0] !== file) return false;
    return ['긴급 처리', '일반 처리'].includes(await readFile(file, 'utf8'));
  },
});
```

`ctx.jev()`는 실제 boolean을 반환합니다. 정상 `no`는 `else`로 진행하며 작업 실패를 뜻하지 않습니다.
실행 함수의 `outcome`과 검증 결과가 최종 성공 여부를 결정합니다. 판단 없이 끝나는 함수도 가능합니다.
Jev 오류는 Luna low/default로 한 번 폴백합니다. 정상 `no`, 취소, 잘못된 입력에는 폴백하지 않습니다.
두 제공자 모두 실패하면 예외가 발생하고 실행기는 실패로 기록합니다. 점수 임계값은 사용하지 않습니다.

검증 함수는 반드시 literal `true`를 반환해야 합니다. 문자열 `"true"`는 실패입니다.
검증 함수에서도 `ctx.jev()`를 호출할 수 있습니다. 산출물은 해당 실행 폴더 안의 실제 파일이어야 합니다.
스킬의 외부 부작용을 되돌리지는 않으므로, 스킬 내부에서 검증 후 저장하도록 작성합니다.
취소 가능한 작업에는 `env.signal`을 전달하고 반복 횟수 등 종료 조건을 스킬이 명시합니다.
실행기 기본 한도는 5분과 `ctx.jev()` 64회입니다. Luna 폴백을 포함한 한 번의 판단이 1회로 계산됩니다.
초과하면 `timeout` 또는 `call_limit`, 취소하면 `canceled`로 기록하며 이후 판단 호출을 막습니다.
실행과 검증 함수가 취소를 무시하고 대기해도 실행기는 기다림을 끝냅니다.
같은 프로세스에 남은 코드의 부작용까지 되돌리거나 강제 정지시키지는 않습니다.
CLI는 별도 프로세스를 감시하며, 전체 시간 한도 또는 취소 후 5초의 여유가 지나도 종료하지 않으면 강제 종료합니다.
이 경우 `result.md`가 없을 수 있으며, 별도로 만든 하위 프로세스·외부 작업의 종료까지 보장하지 않습니다.

## 실행과 확장

```sh
bun run scripts/skill-flow-run.mts --skill condition-note --input out/skill-flow/request.json
```

`--timeout-ms 300000 --max-judgments 64`로 한도를 설정할 수 있습니다.
시간은 최대 1시간, 판단은 최대 1,000회이며 둘 다 양의 정수여야 합니다.
코드 호출에서는 `runRegisteredSkill()`에 `timeoutMs`, `maxJudgments`를 전달합니다.

예제 입력은 JSON 문자열 `"내일 확인해 주세요"`입니다. 이 예제는 작성법이며 기본 설치된 스킬은 아닙니다.
현재 설치된 스킬은 `jev-research-report`이고 같은 명령으로 실행합니다.
입력 JSON은 32,000 UTF-8 바이트 이내여야 합니다.
키는 기존 Cheshi 저장소에서 읽으며, Codex 계정의 `CODEX_HOME`을 유지합니다.
성공 시 산출물 경로와 `result.md`를 출력합니다. 실패 시에도 실행에 진입했다면 `result.md`에 이유를 남깁니다.
모듈 로드나 출력 저장 자체가 실패한 경우에는 보고서 없이 종료할 수 있습니다.

코드에서 사용하는 경우 `createSkillRegistry([skillA, skillB])`와 `runRegisteredSkill()`을 조합합니다.
외부 도구는 `dependencies`로 주입하고 각 스킬이 필요한 계약을 검사합니다.
기본 CLI는 조사용 `research` 도구를 제공합니다. 다른 도구가 필요한 스킬은 구현 또는 주입 연결이 필요합니다.
이 실행기는 현재 체크아웃용이며 배포된 앱에 포함되는 기능은 아닙니다.

## 검증 범위

회귀 테스트는 잘못된 yes/no 응답, 작업 반환값, 검증 반환값, 인용 번호, 링크,
누락된 요구사항, 읽지 못한 출처, 취소, 없는 파일 및 외부 경로를 모의 주입합니다.
조사 스킬은 원문을 별도로 가져와 notes와 대조하고 완성된 문서의 요구사항 및 인용 근거를 Jev로 확인합니다.
실제로 읽은 내용은 실행 폴더의 `evidence-*.json`에 남습니다.
거절되거나 읽지 못한 출처는 `sources-*.json`에 이유를 남기고 제외합니다.
통과한 출처는 보존하고, 자료가 부족하면 최대 두 번 더 조사합니다. 통신·제공자 오류를 정상 no로 취급하지 않습니다.
자료 수·용량 한도를 넘으면 기존 자료와 새 자료를 함께 놓고, 요구사항에 어느 쪽이 더 유용한지 Jev의 yes/no로 비교합니다.
비교 순서에 따라 최대 6개·23,000바이트 안으로 고르고, 이후 충분성을 다시 판단합니다.
점수나 confidence 임계값을 사용하지 않습니다. 비교 호출도 전체 판단 한도에 포함됩니다.
`selection-*.json`에 전체 후보, 비교 결과, 선택된 URL, 한도로 제외된 URL과 이유를 기록합니다.
모델의 비교가 완벽한 순서나 필수 근거 보존을 보장하지는 않으므로, 선택된 자료의 충분성 검증은 유지합니다.

문서 본문은 Markdown 구문으로 검사합니다. 일반 배열, 인라인 코드와 코드 블록을 허용하며 실제 링크·이미지·HTML은 거절합니다.
`answers.<question_id>` 같은 밑줄 자리표시자는 코드 밖에서도 허용하고 저장할 때 화면에 글자로 표시되도록 이스케이프합니다.
출처 제목을 안전하게 처리하고 문서 조립 후 실제 링크가 검증된 인용 목록과 일치하는지도 확인합니다.

작성은 최초 시도와 최대 두 번의 재작성으로 제한됩니다. 잘못된 JSON·구조·인용·본문 표기,
요구사항 미충족과 근거 부족에는 구체적인 오류 코드와 필드 위치를 전달해 새 문서를 작성합니다.
재작성 문서도 구조·의미 검증을 다시 통과해야 저장됩니다. 제공자 오류, 취소, 시간·판단 한도 소진에는 재작성하지 않습니다.
`writing-1.json`부터 각 시도의 원문 응답, 수락 여부, 오류 항목을 저장합니다.
원문 기록은 최대 64,000 UTF-8 바이트이며 넘는 경우 잘렸음을 표시하고 실패로 처리합니다.
피드백에는 18,000바이트 이내의 잘리지 않은 이전 응답만 첨부합니다. 제공자 예외의 내부 메시지는 기록하지 않습니다.

인용 검증 요청이 크면 전체 인용 근거를 유지하면서 본문을 문장 단위로 나눕니다.
요청 본문은 실제 Jev 직렬화와 같은 방법으로 크기를 검사합니다. 문장이나 근거를 몰래 자르지 않습니다.
하나의 문장 자체가 전체 근거와 함께 한도에 들어가지 않으면 검증 실패입니다. 작성 도구에는 짧은 문장을 요청합니다.
긴 웹 원문은 읽기 한도 안의 앞부분을 사용하므로, 뒷부분에만 있는 근거는 검증에서 거절될 수 있습니다.

`bun run skill-flow:test`로 실행기 회귀 테스트를 실행합니다. 기본 `bun run test`에도 연결되어 있습니다.

의미 검증 모델이 틀린 내용에 `yes`를 반환하는 경우까지 코드가 알아낼 수는 없습니다.
이 한계도 의도적으로 잘못된 `yes`를 주입하는 테스트로 드러냅니다.
웹 페이지가 차단되거나 읽기 한도를 넘으면 보고서 작성을 완료하지 못할 수 있습니다.
조사 자료 보완과 문서 재작성을 넘어선 임의 작업의 복구·재개, 임의 스킬 변환, 모든 도구의 자동 연결을 보장하지 않습니다.
