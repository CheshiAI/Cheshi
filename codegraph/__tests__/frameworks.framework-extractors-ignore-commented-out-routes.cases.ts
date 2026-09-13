import {
  aspnetResolver,
  djangoResolver,
  expressResolver,
  fastapiResolver,
  flaskResolver,
  goResolver,
  laravelResolver,
  nestjsResolver,
  railsResolver,
  rustResolver,
  springResolver,
  vaporResolver,
} from '../src/resolution/frameworks';
import { describe, expect, it } from 'bun:test';

export function registerFrameworkExtractorsIgnoreCommentedOutRoutesTests(): void {


  // Regression tests: commented-out and docstring route examples must NOT
  // surface as phantom route nodes. These would have failed before the
  // strip-comments wiring (the regex would happily scan comments/docstrings).
  describe('framework extractors ignore commented-out routes', () => {
    it('django: skips line-comment and docstring routes', () => {
      const src = `
# urls.py example:
# path('/admin/', AdminPanel.as_view())
"""
Other routing example:
    path('/users/', UserListView.as_view())
"""
urlpatterns = [path('/real/', RealView.as_view())]
`;
      const result = djangoResolver.extract!('app/urls.py', src);
      const urls = result.nodes.map((n) => n.name);
      expect(urls).toEqual(['/real/']);
    });

    it('flask: skips commented-out @app.route', () => {
      const src = `
# @app.route('/fake')
# def fake_view():
#     return ''

@app.route('/real')
def real_view():
    return ''
`;
      const { nodes, references } = flaskResolver.extract!('app.py', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['real_view']);
    });

    it('fastapi: skips docstring example routes', () => {
      const src = `
"""
Example:
    @app.get('/in-docstring')
    async def doc():
        pass
"""
@app.get('/real')
async def real_handler():
    return {}
`;
      const { nodes, references } = fastapiResolver.extract!('main.py', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['real_handler']);
    });

    it('express: skips // and /* */ commented routes', () => {
      const src = `
// app.get('/fake', fakeHandler);
/* router.post('/also-fake', otherHandler); */
app.get('/real', realHandler);
`;
      const { nodes, references } = expressResolver.extract!('routes.ts', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['realHandler']);
    });

    it('laravel: skips // # and /* */ commented Route::* calls', () => {
      const src = `<?php
// Route::get('/fake', [FakeController::class, 'index']);
# Route::get('/also-fake', 'FakeController@show');
/* Route::post('/another-fake', [X::class, 'y']); */
Route::get('/real', [RealController::class, 'index']);
`;
      const { nodes, references } = laravelResolver.extract!('routes/web.php', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['RealController@index']);
    });

    it('rails: skips =begin/=end and # commented routes', () => {
      const src = `
# get '/fake', to: 'fake#index'
=begin
get '/also-fake', to: 'fake#show'
=end
get '/real', to: 'real#index'
`;
      const { nodes, references } = railsResolver.extract!('config/routes.rb', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['real#index']);
    });

    it('spring: skips // and /* */ commented @GetMapping', () => {
      const src = `
// @GetMapping("/fake")
// public List<X> fake() { return null; }

/* @PostMapping("/also-fake")
   public void alsoFake() {} */

@GetMapping("/real")
public List<User> listUsers() { return users; }
`;
      const { nodes, references } = springResolver.extract!('UserController.java', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['listUsers']);
    });

    it('go: skips // and /* */ commented router.METHOD calls', () => {
      const src = `
// r.GET("/fake", fakeHandler)
/* r.POST("/also-fake", anotherHandler) */
r.GET("/real", listUsers)
`;
      const { nodes, references } = goResolver.extract!('main.go', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['listUsers']);
    });

    it('rust: skips // and nested /* */ commented .route() calls', () => {
      const src = `
// .route("/fake", get(fake_handler))
/* outer /* inner .route("/inner-fake", get(x)) */ still .route("/outer-fake", get(y)) */
let app = Router::new().route("/real", get(list_users));
`;
      const { nodes, references } = rustResolver.extract!('main.rs', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['list_users']);
    });

    it('aspnet: skips // and /* */ commented [HttpGet] attributes', () => {
      const src = `
// [HttpGet("/fake")]
// public IActionResult Fake() { return Ok(); }

/* [HttpPost("/also-fake")]
   public IActionResult AlsoFake() { return Ok(); } */

[HttpGet("/real")]
public IActionResult ListUsers() { return Ok(); }
`;
      const { nodes, references } = aspnetResolver.extract!('UserController.cs', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['ListUsers']);
    });

    it('vapor: skips // and /* */ commented app.METHOD calls', () => {
      const src = `
// app.get("fake", use: fakeHandler)
/* app.post("also-fake", use: anotherHandler) */
app.get("real", use: listUsers)
`;
      const { nodes, references } = vaporResolver.extract!('routes.swift', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
      expect(references.map((r) => r.referenceName)).toEqual(['listUsers']);
    });

    it('nestjs: skips // and /* */ commented decorators', () => {
      const src = `
@Controller('users')
export class UsersController {
  // @Get('fake')
  // fake() {}
  /* @Post('also-fake')
     alsoFake() {} */
  @Get('real')
  real() {}
}
`;
      const { nodes, references } = nestjsResolver.extract!('users.controller.ts', src);
      expect(nodes.map((n) => n.name)).toEqual(['GET /users/real']);
      expect(references.map((r) => r.referenceName)).toEqual(['real']);
    });
  });
}
