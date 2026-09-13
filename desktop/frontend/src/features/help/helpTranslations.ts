import type { HelpLanguage } from '../../shared/useHelpLanguage';

interface HelpTranslations {
  title: string;
  close: string;
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  topics: string;
  back: string;
  related: string;
  popular: string;
  searchResults: string;
  browseTopics: string;
  resultCount(count: number): string;
  noResults: string;
  footer: string;
}

const translations: Record<HelpLanguage, HelpTranslations> = {
  en: {
    title: 'Help', close: 'Close help', search: 'Search help',
    searchPlaceholder: 'What would you like to do?', clearSearch: 'Clear help search',
    topics: 'Help topics', back: 'Back to topics', related: 'Related help',
    popular: 'Popular guides', searchResults: 'Search results', browseTopics: 'Browse topics',
    resultCount: count => `${count} ${count === 1 ? 'guide' : 'guides'}`,
    noResults: 'No results found. Try another word or menu name.',
    footer: 'Cheshi user guide · Available offline',
  },
  ko: {
    title: '도움말', close: '도움말 닫기', search: '도움말 검색',
    searchPlaceholder: '무엇을 하고 싶으세요?', clearSearch: '도움말 검색 지우기',
    topics: '도움말 주제', back: '목록으로 돌아가기', related: '관련 도움말',
    popular: '자주 찾는 도움말', searchResults: '검색 결과', browseTopics: '주제별 도움말',
    resultCount: count => `${count}개의 도움말`,
    noResults: '검색 결과가 없습니다. 다른 단어나 메뉴 이름으로 검색해 보세요.',
    footer: '인터넷 연결 없이 볼 수 있는 Cheshi 사용 가이드',
  },
};

export function getHelpTranslations(language: HelpLanguage): HelpTranslations {
  return translations[language];
}
