import { extractFromSource } from '../src/extraction';
import { getSupportedLanguages, isLanguageSupported, isSourceFile } from '../src/extraction/grammars';
import { describe, expect, it } from 'bun:test';

export function registerErlangExtractionTests(): void {


  // =============================================================================
  // Erlang (vendored WhatsApp/tree-sitter-erlang grammar — the ELP grammar)
  // =============================================================================

  describe('Erlang Extraction', () => {
    describe('Language detection', () => {
      it('should report Erlang as supported', () => {
        expect(isLanguageSupported('erlang')).toBe(true);
        expect(getSupportedLanguages()).toContain('erlang');
        expect(isSourceFile('apps/app/src/foo.erl')).toBe(true);
        expect(isSourceFile('include/foo.hrl')).toBe(true);
      });
    });

    describe('Function extraction', () => {
      it('should merge multi-clause functions into one node spanning all clauses', () => {
        const code = `-module(m).
-export([classify/1]).

classify(X) when is_atom(X) ->
    atom;
classify(X) when is_binary(X) ->
    binary;
classify(_X) ->
    other.
`;
        const result = extractFromSource('src/m.erl', code);
        const fns = result.nodes.filter((n) => n.kind === 'function' && n.name === 'classify');
        expect(fns).toHaveLength(1);
        expect(fns[0]!.startLine).toBe(4);
        expect(fns[0]!.endLine).toBe(9);
        expect(fns[0]!.language).toBe('erlang');
      });

      it('should qualify functions with the module namespace', () => {
        const code = `-module(my_server).
-export([start/0]).

start() -> ok.
helper() -> ok.
`;
        const result = extractFromSource('src/my_server.erl', code);
        const ns = result.nodes.find((n) => n.kind === 'namespace');
        expect(ns?.name).toBe('my_server');
        const start = result.nodes.find((n) => n.kind === 'function' && n.name === 'start');
        expect(start?.qualifiedName).toBe('my_server::start');
      });

      it('should flag exported functions and honor -compile(export_all)', () => {
        const code = `-module(m).
-export([api/0]).

api() -> internal().
internal() -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const api = result.nodes.find((n) => n.name === 'api');
        const internal = result.nodes.find((n) => n.name === 'internal');
        expect(api?.isExported).toBe(true);
        expect(internal?.isExported).toBe(false);

        const all = extractFromSource('src/all.erl', `-module(all).
-compile(export_all).

anything() -> ok.
`);
        expect(all.nodes.find((n) => n.name === 'anything')?.isExported).toBe(true);
      });

      it('should use the preceding -spec as the signature and capture doc comments', () => {
        const code = `-module(m).

%% Fetches a value by key.
-spec fetch(binary()) -> {ok, term()} | not_found.
fetch(Key) ->
    lookup(Key).

lookup(_K) -> not_found.
`;
        const result = extractFromSource('src/m.erl', code);
        const fetch = result.nodes.find((n) => n.name === 'fetch');
        expect(fetch?.signature).toBe('-spec fetch(binary()) -> {ok, term()} | not_found.');
        expect(fetch?.docstring).toBe('Fetches a value by key.');
      });

      it('should fall back to the clause header as the signature', () => {
        const code = `-module(m).

resize(W, H) when W > 0, H > 0 ->
    {W, H}.
`;
        const result = extractFromSource('src/m.erl', code);
        const resize = result.nodes.find((n) => n.name === 'resize');
        expect(resize?.signature).toBe('resize(W, H) when W > 0, H > 0');
      });
    });

    describe('Record and type extraction', () => {
      it('should extract records as structs with fields', () => {
        const code = `-module(m).

-record(state, {
    store = #{} :: map(),
    counter = 0 :: non_neg_integer()
}).
`;
        const result = extractFromSource('src/m.erl', code);
        const rec = result.nodes.find((n) => n.kind === 'struct');
        expect(rec?.name).toBe('state');
        const fields = result.nodes.filter((n) => n.kind === 'field').map((n) => n.name);
        expect(fields).toContain('store');
        expect(fields).toContain('counter');
      });

      it('should extract -type and -opaque as type aliases, without bogus type-call refs', () => {
        const code = `-module(m).

-type key() :: atom() | binary().
-opaque handle() :: reference().
-spec noop(key()) -> ok.
noop(_K) -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const aliases = result.nodes.filter((n) => n.kind === 'type_alias').map((n) => n.name);
        expect(aliases).toContain('key');
        expect(aliases).toContain('handle');
        // Type-position expressions parse as `call` nodes — the spec/type subtrees
        // must not leak `calls` refs to type names like atom()/binary().
        const bogus = result.unresolvedReferences.filter(
          (r) => r.referenceKind === 'calls' && ['atom', 'binary', 'reference', 'key'].includes(r.referenceName)
        );
        expect(bogus).toHaveLength(0);
      });

      it('should extract -define macros as constants', () => {
        const code = `-module(m).

-define(TIMEOUT, 5000).
-define(WRAP(X), {ok, X}).
`;
        const result = extractFromSource('src/m.erl', code);
        const consts = result.nodes.filter((n) => n.kind === 'constant').map((n) => n.name);
        expect(consts).toContain('TIMEOUT');
        expect(consts).toContain('WRAP');
      });
    });

    describe('Import extraction', () => {
      it('should extract -include/-include_lib and -import', () => {
        const code = `-module(m).

-include("records.hrl").
-include_lib("kernel/include/logger.hrl").
-import(lists, [map/2]).
`;
        const result = extractFromSource('src/m.erl', code);
        const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
        expect(imports).toContain('records.hrl');
        expect(imports).toContain('kernel/include/logger.hrl');
        expect(imports).toContain('lists');
        const ref = result.unresolvedReferences.find(
          (r) => r.referenceKind === 'imports' && r.referenceName === 'records.hrl'
        );
        expect(ref).toBeDefined();
      });
    });

    describe('Call extraction', () => {
      it('should record local calls bare and remote calls module-qualified', () => {
        const code = `-module(m).
-export([run/1]).

run(X) ->
    Y = prepare(X),
    other_mod:process(Y).

prepare(X) -> X.
`;
        const result = extractFromSource('src/m.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(calls).toContain('prepare');
        // `mod:fn(...)` is emitted as `mod::fn` — the same shape the module
        // namespace gives every function's qualifiedName, so it resolves via
        // the qualified-name matcher.
        expect(calls).toContain('other_mod::process');
      });

      it('should not emit calls for dynamic dispatch (var module / var fun)', () => {
        const code = `-module(m).
-export([run/2]).

run(Mod, F) ->
    Mod:handle(x),
    F(y).
`;
        const result = extractFromSource('src/m.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(calls).not.toContain('handle');
        expect(calls).not.toContain('Mod::handle');
        expect(calls).not.toContain('F');
      });

      it('should connect gen_server self-calls to the module handlers', () => {
        const code = `-module(kv_store).
-behaviour(gen_server).
-export([get/1, put/2, drop/1]).
-export([init/1, handle_call/3, handle_cast/2]).

-define(SERVER, ?MODULE).

get(Key) ->
    gen_server:call(?SERVER, {get, Key}).

put(Key, Value) ->
    gen_server:cast(?MODULE, {put, Key, Value}).

drop(Key) ->
    gen_server:call(kv_store, {drop, Key}).

init(_) -> {ok, #{}}.
handle_call({get, K}, _From, S) -> {reply, maps:find(K, S), S};
handle_call({drop, K}, _From, S) -> {reply, ok, maps:remove(K, S)}.
handle_cast({put, K, V}, S) -> {noreply, maps:put(K, V, S)}.
`;
        const result = extractFromSource('src/kv_store.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        // ?SERVER (defined as ?MODULE), ?MODULE, and the module's own atom all
        // count as self — public API wrappers connect to their handlers.
        expect(calls.filter((c) => c === 'kv_store::handle_call')).toHaveLength(2);
        expect(calls).toContain('kv_store::handle_cast');
      });

      it('should connect gen_server calls to a registered-name module, directly or via an atom macro', () => {
        const code = `-module(kv_client).
-export([fetch/1, evict/1]).

-define(STORE, kv_store).

fetch(Key) ->
    gen_server:call(kv_store, {get, Key}).

evict(Key) ->
    gen_server:cast(?STORE, {evict, Key}).
`;
        const result = extractFromSource('src/kv_client.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        // OTP's {local, ?MODULE} convention names a server after its module —
        // a cross-module registered name targets that module's handlers. A name
        // matching no module simply never resolves downstream.
        expect(calls).toContain('kv_store::handle_call');
        expect(calls).toContain('kv_store::handle_cast');
      });

      it('should not connect gen_server calls with dynamic targets', () => {
        const code = `-module(m).
-export([go/2]).

go(Pid, Msg) ->
    gen_server:call(Pid, Msg),
    gen_server:cast({global, some_name}, Msg),
    gen_server:call({some_name, node()}, Msg).
`;
        const result = extractFromSource('src/m.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(calls.filter((c) => c.includes('handle_call') || c.includes('handle_cast'))).toHaveLength(0);
      });

      it('should lift static MFA arguments of the spawn/apply family into call refs', () => {
        const code = `-module(m).
-export([boot/2]).

boot(Req, Env) ->
    Pid = proc_lib:spawn_link(?MODULE, request_process, [Req, Env]),
    spawn(?MODULE, monitor_loop, [Pid]),
    apply(other_mod, handle, [Req]),
    timer:apply_after(500, other_mod, tick, []),
    Pid.

request_process(_R, _E) -> ok.
monitor_loop(_P) -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(calls).toContain('request_process'); // ?MODULE → bare, same-file resolution
        expect(calls).toContain('monitor_loop');
        expect(calls).toContain('other_mod::handle');
        expect(calls).toContain('other_mod::tick');
      });

      it('should stay silent on dynamic spawn/apply (var module, fun value, or plain fun)', () => {
        const code = `-module(m).
-export([go/3]).

go(M, F, A) ->
    spawn(M, F, A),
    spawn(fun() -> helper() end),
    apply(M, F, A).

helper() -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        // The fun body's call is still walked; no phantom MFA targets appear.
        expect(calls).toContain('helper');
        expect(calls.filter((c) => c !== 'spawn' && c !== 'apply' && c !== 'helper')).toHaveLength(0);
      });

      it('should treat ?MODULE:fn calls as local calls', () => {
        const code = `-module(m).
-export([kick/0]).

kick() ->
    ?MODULE:work().

work() -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(calls).toContain('work');
      });

      it('should capture fun name/arity values as function references', () => {
        const code = `-module(m).
-export([wire/1]).

wire(Pids) ->
    lists:foreach(fun notify/1, Pids),
    lists:map(fun m:notify/1, Pids).

notify(_P) -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references').map((r) => r.referenceName);
        expect(refs).toContain('notify');
        expect(refs).toContain('m::notify');
      });

      it('should reference records used in bodies and argument patterns', () => {
        const code = `-module(m).
-export([mk/1, get_id/1]).

-record(req, {id, payload}).

mk(Id) -> #req{id = Id}.
get_id(#req{id = Id}) -> Id.
`;
        const result = extractFromSource('src/m.erl', code);
        const refs = result.unresolvedReferences.filter(
          (r) => r.referenceKind === 'references' && r.referenceName === 'req'
        );
        expect(refs.length).toBeGreaterThanOrEqual(2);
      });

      it('should attribute calls from every clause of a multi-clause function', () => {
        const code = `-module(m).
-export([handle/1]).

handle({a, X}) ->
    first(X);
handle({b, X}) ->
    second(X).

first(X) -> X.
second(X) -> X.
`;
        const result = extractFromSource('src/m.erl', code);
        const handle = result.nodes.find((n) => n.kind === 'function' && n.name === 'handle');
        const calls = result.unresolvedReferences.filter(
          (r) => r.referenceKind === 'calls' && r.fromNodeId === handle?.id
        ).map((r) => r.referenceName);
        expect(calls).toContain('first');
        expect(calls).toContain('second');
      });
    });

    describe('escript and app resource files', () => {
      it('should extract functions and calls from an escript behind a shebang', () => {
        const code = `#!/usr/bin/env escript
%%! -smp enable

main([Path]) ->
    Result = analyze(Path),
    io:format("~p~n", [Result]).

analyze(Path) ->
    {ok, Bin} = file:read_file(Path),
    byte_size(Bin).
`;
        const result = extractFromSource('bin/tool.escript', code);
        const fns = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
        expect(fns).toContain('main');
        expect(fns).toContain('analyze');
        const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
        expect(calls).toContain('analyze');
        expect(calls).toContain('io::format');
      });

      it('should link an app resource file to its callback module and dependency apps', () => {
        const code = `{application, sample, [
    {description, "Sample application"},
    {vsn, "1.0.0"},
    {registered, [sample_server]},
    {mod, {sample_app, []}},
    {applications, [kernel, stdlib, sample_core]},
    {included_applications, [sample_extra]},
    {env, [{limit, 100}]},
    {modules, []}
]}.
`;
        const result = extractFromSource('src/sample.app.src', code);
        const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
        // The application-callback module is the app's entry point.
        expect(refs).toContain('references:sample_app');
        // Dependencies resolve to umbrella siblings; kernel/stdlib just drop.
        expect(refs).toContain('imports:kernel');
        expect(refs).toContain('imports:sample_core');
        expect(refs).toContain('imports:sample_extra');
        // Registered names, env values, and the like carry no graph structure.
        expect(refs.filter((r) => r.endsWith(':sample_server'))).toHaveLength(0);
        expect(refs.filter((r) => r.endsWith(':limit'))).toHaveLength(0);
      });
    });

    describe('Macro linkage', () => {
      it('should attribute macro-body calls to the macro and link function-like uses into the chain', () => {
        const code = `-module(m).
-export([do_thing/1]).

-define(LOG_AUDIT(Event), audit_logger:log(Event, ?MODULE)).

do_thing(X) ->
    ?LOG_AUDIT({thing, X}),
    ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const macro = result.nodes.find((n) => n.kind === 'constant' && n.name === 'LOG_AUDIT');
        const doThing = result.nodes.find((n) => n.kind === 'function' && n.name === 'do_thing');
        const refsFrom = (id?: string) =>
          result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => `${r.referenceKind}:${r.referenceName}`);
        // The body's remote call belongs to the macro node — true exactly once.
        expect(refsFrom(macro?.id)).toContain('calls:audit_logger::log');
        // The use site joins the call chain: do_thing -calls→ LOG_AUDIT.
        expect(refsFrom(doThing?.id)).toContain('calls:LOG_AUDIT');
      });

      it('should reference bare macro reads without polluting call chains', () => {
        const code = `-module(m).
-export([wait/0]).

-define(TIMEOUT, 5000).

wait() ->
    receive after ?TIMEOUT -> ok end.
`;
        const result = extractFromSource('src/m.erl', code);
        const refs = result.unresolvedReferences.map((r) => `${r.referenceKind}:${r.referenceName}`);
        expect(refs).toContain('references:TIMEOUT');
        expect(refs).not.toContain('calls:TIMEOUT');
      });

      it('should skip compiler-predefined macros and keep walking macro-use arguments', () => {
        const code = `-module(m).
-export([check/0]).

check() ->
    ?assertEqual(ok, prepare()),
    {?MODULE, ?LINE, ?FUNCTION_NAME}.

prepare() -> ok.
`;
        const result = extractFromSource('src/m.erl', code);
        const refs = result.unresolvedReferences.map((r) => r.referenceName);
        // The nested call inside the macro's arguments still attributes to check/0.
        expect(refs).toContain('prepare');
        // ?assertEqual (an OTP header macro) is emitted and simply never resolves…
        expect(refs).toContain('assertEqual');
        // …but predefined macros have no definition to link.
        expect(refs).not.toContain('MODULE');
        expect(refs).not.toContain('LINE');
        expect(refs).not.toContain('FUNCTION_NAME');
      });

      it('should chain macro-to-macro uses', () => {
        const code = `-module(m).

-define(TARGET, target_fn()).
-define(ALIAS, ?TARGET).
`;
        const result = extractFromSource('src/m.erl', code);
        const target = result.nodes.find((n) => n.kind === 'constant' && n.name === 'TARGET');
        const alias = result.nodes.find((n) => n.kind === 'constant' && n.name === 'ALIAS');
        const refsFrom = (id?: string) =>
          result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => `${r.referenceKind}:${r.referenceName}`);
        expect(refsFrom(target?.id)).toContain('calls:target_fn');
        expect(refsFrom(alias?.id)).toContain('references:TARGET');
      });
    });

    describe('Behaviour extraction', () => {
      it('should emit an implements reference for -behaviour', () => {
        const code = `-module(m).
-behaviour(gen_server).

init(_) -> {ok, #{}}.
`;
        const result = extractFromSource('src/m.erl', code);
        const impl = result.unresolvedReferences.find((r) => r.referenceKind === 'implements');
        expect(impl?.referenceName).toBe('gen_server');
      });

      it('should not create symbols from -callback declarations', () => {
        const code = `-module(b).

-callback handle_thing(term()) -> ok.
-callback init(list()) -> {ok, term()}.
`;
        const result = extractFromSource('src/b.erl', code);
        const fns = result.nodes.filter((n) => n.kind === 'function');
        expect(fns).toHaveLength(0);
      });
    });
  });
}
