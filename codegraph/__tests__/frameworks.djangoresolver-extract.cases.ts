import { djangoResolver } from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerDjangoresolverExtractTests(): void {


  describe('djangoResolver.extract', () => {
    it('extracts route node and reference for path() with CBV.as_view()', () => {
      const src = `
from django.urls import path
from users.views import UserListView

urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]
`;
      const { nodes, references } = djangoResolver.extract!('users/urls.py', src);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe('route');
      expect(nodes[0].name).toBe('users/');
      expect(references).toHaveLength(1);
      expect(references[0].referenceName).toBe('UserListView');
      expect(references[0].referenceKind).toBe('references');
      expect(references[0].fromNodeId).toBe(nodes[0].id);
    });

    it('extracts route for path() with dotted module.Class.as_view()', () => {
      const src = `from django.urls import path\nfrom api.v1 import views as api_v1_views\nurlpatterns = [path('api/', api_v1_views.UserListView.as_view())]\n`;
      const { nodes, references } = djangoResolver.extract!('api/urls.py', src);
      expect(nodes).toHaveLength(1);
      expect(references[0].referenceName).toBe('UserListView');
    });

    it('extracts route for path() with bare function view', () => {
      const src = `from django.urls import path\nurlpatterns = [path('home/', home_view, name='home')]\n`;
      const { references } = djangoResolver.extract!('home/urls.py', src);
      expect(references[0].referenceName).toBe('home_view');
    });

    it('extracts route for path() with include()', () => {
      const src = `from django.urls import path, include\nurlpatterns = [path('api/', include('api.urls'))]\n`;
      const { nodes, references } = djangoResolver.extract!('root/urls.py', src);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].kind).toBe('route');
      expect(references[0].referenceName).toBe('api.urls');
      expect(references[0].referenceKind).toBe('imports');
    });

    it('extracts routes for re_path and url', () => {
      const src = `from django.urls import re_path, url\nurlpatterns = [re_path(r'^users/$', UserView), url(r'^old/$', OldView)]\n`;
      const { nodes } = djangoResolver.extract!('legacy/urls.py', src);
      expect(nodes).toHaveLength(2);
      expect(nodes.map(n => n.name)).toEqual(['^users/$', '^old/$']);
    });

    it('returns empty result for a non-urls.py python file', () => {
      const src = `def foo(): return 1\n`;
      const { nodes, references } = djangoResolver.extract!('views.py', src);
      expect(nodes).toEqual([]);
      expect(references).toEqual([]);
    });
  });
}
