import { flaskResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerFlaskresolverExtractTests(): void {


  describe('flaskResolver.extract', () => {
    it('extracts route and reference from @app.route', () => {
      const src = `
@app.route('/users')
def list_users():
    return []
`;
      const { nodes, references } = flaskResolver.extract!('app.py', src);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe('route');
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('list_users');
    });

    it('extracts blueprint routes', () => {
      const src = `
@users_bp.route('/<id>', methods=['POST'])
def create_user(id):
    pass
`;
      const { nodes, references } = flaskResolver.extract!('routes.py', src);
      expect(nodes[0].name).toBe('POST /<id>');
      expect(references[0].referenceName).toBe('create_user');
    });

    it('resolves the handler across an intervening decorator (@login_required)', () => {
      const src = `
@bp.route('/profile')
@login_required
def profile():
    return render_template('profile.html')
`;
      const { nodes, references } = flaskResolver.extract!('routes.py', src);
      expect(nodes[0].name).toBe('GET /profile');
      expect(references[0].referenceName).toBe('profile');
    });

    it('extracts stacked @x.route decorators bound to one view', () => {
      const src = `
@bp.route('/', methods=['GET', 'POST'])
@bp.route('/index', methods=['GET', 'POST'])
@login_required
def index():
    return render_template('index.html')
`;
      const { nodes, references } = flaskResolver.extract!('routes.py', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /', 'GET /index']);
      expect(references.map((r) => r.referenceName)).toEqual(['index', 'index']);
    });

    it('extracts the method from a tuple methods=(...) (not just a list)', () => {
      const src = `
@blueprint.route('/api/articles', methods=('POST',))
def make_article():
    pass
`;
      const { nodes, references } = flaskResolver.extract!('views.py', src);
      expect(nodes[0].name).toBe('POST /api/articles');
      expect(references[0].referenceName).toBe('make_article');
    });

    it('extracts Flask-RESTful api.add_resource(Resource, paths) → the Resource class', () => {
      const src = `
api.add_resource(TodoResource, '/todos/<id>')
api.add_org_resource(AlertResource, '/api/alerts/<id>', endpoint='alert')
`;
      const { nodes, references } = flaskResolver.extract!('api.py', src);
      expect(nodes.map((n) => n.name)).toEqual(['ANY /todos/<id>', 'ANY /api/alerts/<id>']);
      expect(references.map((r) => r.referenceName)).toEqual(['TodoResource', 'AlertResource']);
    });
  });
}
