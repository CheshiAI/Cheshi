import type { HelpLanguage } from '../../shared/useHelpLanguage';

export interface HelpArticle {
  id: string;
  title: string;
  description: string;
  keywords: string;
  related: string[];
  markdown: string;
}

export const helpTopics = [
  { id: 'projects', title: 'Getting started with projects', description: 'Create a project, open a folder, or clone a repository', keywords: 'workspace create project open folder clone repository', related: ['ai-chat', 'git'] },
  { id: 'ai-chat', title: 'Working with AI', description: 'Chat, attach files and images, and use temporary chats', keywords: 'attach temporary chat drag question model', related: ['editing', 'troubleshooting'] },
  { id: 'editing', title: 'Editing files', description: 'Open, edit, and save files', keywords: 'editor explorer save', related: ['local-history', 'git'] },
  { id: 'local-history', title: 'Restoring previous versions', description: 'Compare and restore snapshots with Local history', keywords: 'restore diff history snapshot recovery undo', related: ['editing', 'git'] },
  { id: 'git', title: 'Recording and sharing with Git', description: 'Review changes, commit, and push', keywords: 'commit push stage remote github repository', related: ['local-history', 'troubleshooting'] },
  { id: 'troubleshooting', title: 'Troubleshooting', description: 'Resolve sign-in, response, project, and Git errors', keywords: 'login error fail sign in authentication', related: ['projects', 'ai-chat', 'git'] },
] satisfies Omit<HelpArticle, 'markdown'>[];

const koreanHelpTopics = [
  { id: 'projects', title: '프로젝트 시작하기', description: '새 프로젝트 생성, 폴더 열기, 저장소 복제', keywords: 'workspace create project open folder clone repository 워크스페이스', related: ['ai-chat', 'git'] },
  { id: 'ai-chat', title: 'AI와 작업하기', description: '대화, 파일·이미지 첨부, 임시 대화', keywords: 'attach temporary chat 드래그 질문 모델', related: ['editing', 'troubleshooting'] },
  { id: 'editing', title: '파일 편집하기', description: '파일 열기, 수정, 저장', keywords: 'editor explorer save 에디터 탐색기', related: ['local-history', 'git'] },
  { id: 'local-history', title: '이전 내용 복원하기', description: 'Local history에서 변경 이력 비교·복원', keywords: 'restore diff history 기록 복구 되돌리기', related: ['editing', 'git'] },
  { id: 'git', title: 'Git으로 기록·공유하기', description: '변경 확인, 커밋, 푸시', keywords: 'commit push stage remote github 깃허브 저장소', related: ['local-history', 'troubleshooting'] },
  { id: 'troubleshooting', title: '문제 해결', description: '로그인, 응답 실패, 프로젝트 열기, Git 오류', keywords: 'login error fail 로그인 인증 오류 실패', related: ['projects', 'ai-chat', 'git'] },
] satisfies Omit<HelpArticle, 'markdown'>[];

export function getHelpTopics(language: HelpLanguage): Omit<HelpArticle, 'markdown'>[] {
  return language === 'ko' ? koreanHelpTopics : helpTopics;
}

export function searchHelp(articles: HelpArticle[], query: string): HelpArticle[] {
  const words = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return articles.filter(article => {
    const content = `${article.title} ${article.description} ${article.keywords} ${article.markdown}`
      .normalize('NFKC').toLocaleLowerCase();
    return words.every(word => content.includes(word));
  });
}
