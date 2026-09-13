import projects from '../../../../../.docs/help/en/projects.md?raw';
import aiChat from '../../../../../.docs/help/en/ai-chat.md?raw';
import editing from '../../../../../.docs/help/en/editing.md?raw';
import localHistory from '../../../../../.docs/help/en/local-history.md?raw';
import git from '../../../../../.docs/help/en/git.md?raw';
import troubleshooting from '../../../../../.docs/help/en/troubleshooting.md?raw';
import koreanProjects from '../../../../../.docs/help/ko/projects.md?raw';
import koreanAiChat from '../../../../../.docs/help/ko/ai-chat.md?raw';
import koreanEditing from '../../../../../.docs/help/ko/editing.md?raw';
import koreanLocalHistory from '../../../../../.docs/help/ko/local-history.md?raw';
import koreanGit from '../../../../../.docs/help/ko/git.md?raw';
import koreanTroubleshooting from '../../../../../.docs/help/ko/troubleshooting.md?raw';
import type { HelpLanguage } from '../../shared/useHelpLanguage';
import { getHelpTopics, type HelpArticle } from './helpCatalog';

const documents: Record<string, string> = {
  projects, 'ai-chat': aiChat, editing, 'local-history': localHistory, git, troubleshooting,
};

const koreanDocuments: Record<string, string> = {
  projects: koreanProjects, 'ai-chat': koreanAiChat, editing: koreanEditing,
  'local-history': koreanLocalHistory, git: koreanGit, troubleshooting: koreanTroubleshooting,
};

export const helpArticles: HelpArticle[] = getHelpTopics('en').map(topic => ({ ...topic, markdown: documents[topic.id]! }));
const koreanHelpArticles: HelpArticle[] = getHelpTopics('ko').map(topic => ({ ...topic, markdown: koreanDocuments[topic.id]! }));

export function getHelpArticles(language: HelpLanguage): HelpArticle[] {
  return language === 'ko' ? koreanHelpArticles : helpArticles;
}
