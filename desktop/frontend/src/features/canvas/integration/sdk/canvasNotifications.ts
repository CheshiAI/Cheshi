import type { StatusToastMessage } from '../../../../shared/ui/StatusToast';
import type { HelpLanguage } from '../../../../shared/useHelpLanguage';

const titles = {
  en: {
    open: 'Could not open the design file', save: 'Could not save the design file',
    create: 'Could not create a new design', restore: 'Could not restore the last design',
    remember: 'Could not remember the design', initialize: 'Could not start Canvas',
    edit: 'Could not update the design', unavailable: 'Local design files are unavailable',
  },
  ko: {
    open: '디자인 파일을 열 수 없습니다', save: '디자인 파일을 저장할 수 없습니다',
    create: '새 디자인을 만들 수 없습니다', restore: '마지막 디자인을 복원할 수 없습니다',
    remember: '디자인 경로를 기억할 수 없습니다', initialize: 'Canvas를 시작할 수 없습니다',
    edit: '디자인을 변경할 수 없습니다', unavailable: '로컬 디자인 파일을 사용할 수 없습니다',
  },
};

export type CanvasErrorOperation = keyof typeof titles.en;

export function canvasErrorNotification(reason: unknown, operation: CanvasErrorOperation, language: HelpLanguage, path?: string): Omit<StatusToastMessage, 'id'> {
  const raw = reason instanceof Error ? reason.message : String(reason ?? '');
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '').trim();
  const code = reason instanceof Error && 'code' in reason ? reason.code : undefined;
  let description = detail || (language === 'ko' ? '다시 시도해 주세요.' : 'Please try again.');
  if (operation === 'open' && (code === 'ENOENT' || /^ENOENT\b/.test(detail))) {
    description = language === 'ko'
      ? (path ? `${path} 파일을 찾을 수 없습니다.` : '디자인 파일을 찾을 수 없습니다.')
      : (path ? `File not found: ${path}` : 'The design file could not be found.');
  } else if (code === 'EACCES' || code === 'EPERM' || /^(EACCES|EPERM)\b/.test(detail)) {
    description = language === 'ko' ? '파일 접근 권한을 확인한 뒤 다시 시도해 주세요.' : 'Check the file permissions and try again.';
  }
  if (operation === 'unavailable') {
    description = language === 'ko' ? '로컬 파일을 사용하려면 Cheshi를 다시 시작해 주세요.' : 'Restart Cheshi to enable local design files.';
  } else if (operation === 'remember') {
    description = (language === 'ko' ? '디자인은 사용할 수 있지만 다음 실행 시 자동으로 열리지 않을 수 있습니다. ' : 'The design is available, but it may not reopen automatically. ') + description;
  }
  return { variant: operation === 'remember' ? 'warning' : 'error', title: titles[language][operation], description: description.slice(0, 4096) };
}
