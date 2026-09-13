import { fastapiResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerFastapiresolverExtractTests(): void {


  describe('fastapiResolver.extract', () => {
    it('extracts route and reference from @app.get', () => {
      const src = `
@app.get('/users')
async def list_users():
    return []
`;
      const { nodes, references } = fastapiResolver.extract!('main.py', src);
      expect(nodes[0].name).toBe('GET /users');
      expect(references[0].referenceName).toBe('list_users');
    });

    it('extracts route from router.post', () => {
      const src = `
@router.post('/items')
def create_item(item: Item):
    pass
`;
      const { nodes, references } = fastapiResolver.extract!('items.py', src);
      expect(nodes[0].name).toBe('POST /items');
      expect(references[0].referenceName).toBe('create_item');
    });

    it('extracts a route mounted at the router/prefix root (empty path)', () => {
      const src = `
@router.get("", response_model=ListOfArticles, name="articles:list")
async def list_articles():
    return []
`;
      const { nodes, references } = fastapiResolver.extract!('articles.py', src);
      expect(nodes[0].name).toBe('GET /');
      expect(references[0].referenceName).toBe('list_articles');
    });

    it('extracts a multi-line decorator with an empty path', () => {
      const src = `
@router.post(
    "",
    status_code=201,
    response_model=ArticleInResponse,
)
async def create_article():
    pass
`;
      const { nodes, references } = fastapiResolver.extract!('articles.py', src);
      expect(nodes[0].name).toBe('POST /');
      expect(references[0].referenceName).toBe('create_article');
    });
  });
}
