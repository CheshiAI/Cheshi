import { createGitHubLoginApi } from './github-login-fixture';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitHubRepository } from '../shared/workspace-management';
import { filterGitHubRepositories, GitHubRepositoryPicker, GitHubRepositoryResults, mergeGitHubRepositories } from '../frontend/src/features/navigation/workspace-management/GitHubRepositoryPicker';

const first: GitHubRepository = { id: 1, fullName: 'owner/cheshi', description: 'Desktop workspace', private: true, cloneUrl: 'https://github.com/owner/cheshi.git' };
const second: GitHubRepository = { id: 2, fullName: 'team/tools', description: null, private: false, cloneUrl: 'https://github.com/team/tools.git' };

test('repository search finds accessible organization names and descriptions without changing ordering', () => {
  const repositories = [first, second];
  expect(filterGitHubRepositories(repositories, ' TEAM/ ')).toEqual([second]);
  expect(filterGitHubRepositories(repositories, 'WORKSPACE')).toEqual([first]);
  expect(filterGitHubRepositories(repositories, ' ')).toEqual(repositories);
  expect(filterGitHubRepositories(repositories, 'missing')).toEqual([]);
});

test('updated repositories crossing pagination boundaries replace stale metadata without duplicate rows', () => {
  const updated = { ...first, fullName: 'team/renamed', description: 'Renamed project' };
  const current = [first];
  expect(mergeGitHubRepositories(current, [updated, second])).toEqual([updated, second]);
  expect(current).toEqual([first]);
});

test('repository selection distinguishes private access and never submits the clone form', () => {
  const html = renderToStaticMarkup(<GitHubRepositoryResults repositories={[first, second]} disabled={false} onSelect={() => {}} />);
  expect(html).toContain('Select owner/cheshi — private');
  expect(html).toContain('Select team/tools');
  expect(html.match(/type="button"/g)).toHaveLength(2);
  expect(html).not.toContain('disabled=""');
});

test('busy repository results cannot change the selected clone target and descriptions are escaped', () => {
  const html = renderToStaticMarkup(<GitHubRepositoryResults repositories={[{ ...first, description: '<script>untrusted</script>' }, second]} disabled onSelect={() => {}} />);
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  expect(html).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
  expect(html).not.toContain('<script>');
});

test('a prepared repository catalog renders all rows immediately without another loading phase', () => {
  const api = { ...createGitHubLoginApi(), listGitHubRepositories: async () => { throw new Error('Prepared catalogs must not fetch during rendering'); } };
  const html = renderToStaticMarkup(<GitHubRepositoryPicker api={api} disabled={false} onSelect={() => {}}
    initialCatalog={{ login: 'owner', repositories: [first, second] }} />);
  expect(html).toContain('Signed in as owner');
  expect(html).toContain('Select owner/cheshi');
  expect(html).toContain('Select team/tools');
  expect(html).not.toContain('Preparing...');
  expect(html).not.toContain('Load more repositories');
});

test('repository loading shows the common loading state without partial search or repository rows', () => {
  const api = { ...createGitHubLoginApi(), listGitHubRepositories: async () => ({ login: 'owner', repositories: [], nextPage: null }) };
  const html = renderToStaticMarkup(<GitHubRepositoryPicker api={api} disabled={false} onSelect={() => {}} initialCatalog={null} />);
  expect(html).toContain('Preparing...');
  expect(html).not.toContain('Search repositories');
});
