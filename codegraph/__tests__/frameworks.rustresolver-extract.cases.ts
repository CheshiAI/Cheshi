import { rustResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerRustresolverExtractTests(): void {


  describe('rustResolver.extract', () => {
    it('extracts route from axum .route with get()', () => {
      const src = `let app = Router::new().route("/users", get(list_users));\n`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('list_users');
    });

    it('extracts every method from a chained axum .route (get().put())', () => {
      const src = `let app = Router::new().route("/user", get(get_current_user).put(update_user));\n`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /user', 'PUT /user']);
      expect(references.map((r) => r.referenceName)).toEqual([
        'get_current_user',
        'update_user',
      ]);
    });

    it('extracts a multi-line axum .route with a namespaced handler', () => {
      const src = `
let app = Router::new()
    .route(
        "/articles/feed",
        get(listing::feed_articles),
    );
`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes[0].name).toBe('GET /articles/feed');
      expect(references[0].referenceName).toBe('feed_articles');
    });

    it('extracts actix web::resource().route(web::METHOD().to(handler))', () => {
      const src = `App::new().service(web::resource("/user/{id}").route(web::get().to(get_user)))\n`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes[0].name).toBe('GET /user/{id}');
      expect(references[0].referenceName).toBe('get_user');
    });

    it('extracts actix web::resource("/").to(handler) (all methods)', () => {
      const src = `App::new().service(web::resource("/").to(index))\n`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes[0].name).toBe('ANY /');
      expect(references[0].referenceName).toBe('index');
    });

    it('extracts actix App-level .route("/path", web::METHOD().to(handler))', () => {
      const src = `App::new().route("/health", web::get().to(health_check))\n`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes[0].name).toBe('GET /health');
      expect(references[0].referenceName).toBe('health_check');
    });
  });
}
