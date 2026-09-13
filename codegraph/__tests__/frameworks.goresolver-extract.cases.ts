import { goResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerGoresolverExtractTests(): void {


  describe('goResolver.extract', () => {
    it('extracts route from r.GET', () => {
      const src = `r.GET("/users", listUsers)\n`;
      const { nodes, references } = goResolver.extract!('main.go', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('listUsers');
    });

    it('extracts route from router.HandleFunc', () => {
      const src = `router.HandleFunc("/items", createItem)\n`;
      const { references } = goResolver.extract!('main.go', src);
      expect(references[0].referenceName).toBe('createItem');
    });

    it('extracts gorilla/mux HandleFunc on a subrouter var, ignoring chained .Methods()', () => {
      // `s` is a PathPrefix().Subrouter() var — any receiver is matched; the
      // trailing .Methods("GET") doesn't break the handler capture.
      const src = `s.HandleFunc("/users/{id}", listUsers).Methods("GET")\n`;
      const { references } = goResolver.extract!('routes.go', src);
      expect(references[0].referenceName).toBe('listUsers');
    });

    it('does NOT treat verb-named method calls with non-path args as routes (#1259)', () => {
      // The issue's repro: a generic cache type whose Put/Get share router verb
      // names. First args are keys, not URL paths — no route nodes.
      const src = [
        `c.Put("a", 1)`,
        `c.Put("user:123", value)`,
        `store.Get("config", out)`,
        `bus.Handle("user.created", onUserCreated)`,
        `m.HandleFunc("shutdown", hook)`,
      ].join('\n');
      const { nodes } = goResolver.extract!('cache.go', src);
      expect(nodes).toHaveLength(0);
    });

    it('keeps real registrations whose paths start with "/" for every router style', () => {
      const src = [
        `r.Put("/users/{id}", updateUser)`, // chi
        `v1.GET("/ping", ping)`, // gin group
        `mux.HandleFunc("/healthz", health)`, // net/http
      ].join('\n');
      const { nodes } = goResolver.extract!('routes.go', src);
      expect(nodes.map((n) => n.name)).toEqual(['PUT /users/{id}', 'GET /ping', 'ANY /healthz']);
    });

    it('recognizes Go 1.22 "METHOD /path" patterns on HandleFunc and extracts the method', () => {
      const src = `mux.HandleFunc("GET /api/users/{id}", getUser)\n`;
      const { nodes, references } = goResolver.extract!('main.go', src);
      expect(nodes[0].name).toBe('GET /api/users/{id}');
      expect(references[0].referenceName).toBe('getUser');
    });
  });
}
