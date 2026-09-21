import type { SkillFlowQuestion } from '../../../desktop/lib/skill-flow-judge.mts';
import type { SkillFlowContext, SkillFlowResult } from '../../../desktop/lib/skill-flow-runtime.mts';

// Official pages actually inspected on this date. Notes are paraphrases, not verbatim quotations.
const research = [
  {
    source: 'TypeSafe: Noul', url: 'https://docs.typesafe.ai/primitives/noul', checkedAt: '2026-09-21',
    notes: 'Noul은 yes/no 질문에 yes일 확률을 0~1 숫자로 반환한다. instructions에 질문을 넣고 '
      + '선택적으로 criteria의 true/false 설명을 추가한다. 별도의 confidence 필드는 없다. '
      + '반환 확률에 코드의 임계값을 적용해 불리언을 만든다. yes와 no의 오판 비용이 같다면 문서는 0.5를 안내한다.',
  },
  {
    source: 'TypeSafe: HTTP API', url: 'https://docs.typesafe.ai/api', checkedAt: '2026-09-21',
    notes: 'POST https://api.typesafe.ai/v1/systemone 호출에 Bearer 인증과 JSON 본문을 사용한다. '
      + '본문에는 model, state, questions를 넣는다. 질문별 type은 noul, instructions는 판정 질문이다. '
      + '응답의 answers에서 같은 질문 ID를 찾아 type과 noul 숫자를 읽는다. model과 usage도 반환된다.',
  },
  {
    source: 'LangChain: Building workflows for agents with Skills and Interpreters',
    url: 'https://www.langchain.com/blog/interpreter-skills', checkedAt: '2026-09-21',
    notes: '2026-05-29 공개된 실험적 Interpreter Skills는 SKILL.md의 사용 설명과 TypeScript 모듈을 함께 제공한다. '
      + '에이전트가 관련 스킬과 입력을 선택하면 인터프리터가 내보낸 함수를 실행한다. GitHub triage 사례는 '
      + '항목 수집, 하위 에이전트 요약, 분류 순서를 코드로 수행한다. 이는 모든 Codex 스킬의 표준 동작이나 '
      + 'Jev 내장 사례라는 뜻은 아니다. 이 자료의 역할 분리에 Jev 조건 함수를 결합하는 것은 우리 구현 제안이다.',
  },
];
const request = 'Jev와 실행 가능한 스킬을 결합하는 설계를 설명할 3장짜리 발표자료를 준비해 주세요.';
const requiredTopics = [
  'Noul의 입력과 반환값 의미, 코드에서 yes/no로 변환하는 방법',
  'TypeSafe HTTP 호출의 메서드·주소·인증 및 요청·응답 필드',
  '실행 가능한 스킬의 공개 사례와 에이전트·스킬 모듈·실행 환경의 역할 분리',
];
const condition = '제공된 research의 실제 내용만으로 requiredTopics를 모두 설명하는 발표자료를 작성할 근거가 충분한가? '
  + 'URL이나 제목이 있다는 사실만으로 충족했다고 판단하지 말고 notes의 내용을 확인하세요. '
  + '항목 하나라도 근거가 빠져 있으면 no입니다. 외부 지식으로 빈 내용을 채우지 마세요.';

export const completeResearch: SkillFlowQuestion = { condition, state: { request, requiredTopics, research } };

export const partialResearch: SkillFlowQuestion = {
  condition, state: { request, requiredTopics, research: research.slice(0, 1) },
};

export const incompleteResearch: SkillFlowQuestion = {
  condition, state: { request, requiredTopics, research: [] },
};

/** The prototype substitutes Markdown success/fail for PPT creation or more research. */
export async function branchCheck(ctx: SkillFlowContext, question: SkillFlowQuestion): Promise<SkillFlowResult> {
  const judgment = await ctx.jev(question);
  if (judgment) return { outcome: 'success' };
  return { outcome: 'fail' };
}
