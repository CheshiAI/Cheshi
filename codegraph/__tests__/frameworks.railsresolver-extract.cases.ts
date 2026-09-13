import { railsResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerRailsresolverExtractTests(): void {


  describe('railsResolver.extract', () => {
    it('extracts route with controller#action syntax', () => {
      const src = `get '/users', to: 'users#index'\n`;
      const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('users#index');
    });

    it('extracts route without to: keyword', () => {
      const src = `post '/items' => 'items#create'\n`;
      const { references } = railsResolver.extract!('config/routes.rb', src);
      expect(references[0].referenceName).toBe('items#create');
    });
  });
}
