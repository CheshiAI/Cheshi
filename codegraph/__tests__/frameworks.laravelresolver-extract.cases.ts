import { laravelResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerLaravelresolverExtractTests(): void {


  describe('laravelResolver.extract', () => {
    it('extracts route with controller tuple syntax', () => {
      const src = `Route::get('/users', [UserController::class, 'index']);\n`;
      const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('UserController@index');
    });

    it('extracts route with Controller@action syntax', () => {
      const src = `Route::post('/users', 'UserController@store');\n`;
      const { references } = laravelResolver.extract!('routes/web.php', src);
      expect(references[0].referenceName).toBe('UserController@store');
    });

    it('extracts resource route', () => {
      const src = `Route::resource('users', UserController::class);\n`;
      const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
      expect(nodes[0].kind).toBe('route');
      expect(references[0].referenceName).toBe('UserController');
    });
  });
}
