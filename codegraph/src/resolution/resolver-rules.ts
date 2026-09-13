import { Node } from '../types';

/** Node kinds that can declare supertypes (extends/implements). */
export const SUPERTYPE_BEARING_KINDS = new Set<Node['kind']>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum',
]);

/**
 * Languages whose chained static-factory/fluent calls defer to the conformance
 * second pass. Dotted-receiver languages resolve via matchDottedCallChain; the
 * `::`-receiver ones (Rust) via matchScopedCallChain.
 */
export const CHAIN_LANGUAGES = new Set(['java', 'kotlin', 'csharp', 'swift', 'rust', 'go', 'scala', 'dart', 'objc', 'pascal']);

export const SCOPED_CHAIN_LANGUAGES = new Set(['rust']);

/** The extractor's chained-receiver encoding: `<inner>().<method>`. */
export const CHAIN_SHAPE = /^(.+)\(\)\.(\w+)$/;

/** PHP `$this->prop->method()` encoded as `this->prop.method` — no `()`, so CHAIN_SHAPE misses it. */
export const PHP_PROP_SHAPE = /^this->\w+\.\w+$/;

/**
 * Cache size limits. Each per-resolver cache is bounded so memory
 * stays flat on large codebases (20k+ files). Sizes were chosen to
 * cover the working set for typical resolution batches without
 * exceeding a few hundred MB worst-case. Override via the env var
 * `CODEGRAPH_RESOLVER_CACHE_SIZE` (single integer applied to all
 * caches) when tuning for very large or very small projects.
 */
const DEFAULT_CACHE_LIMIT = 5_000;

export function resolveCacheLimit(): number {
  const raw = process.env.CODEGRAPH_RESOLVER_CACHE_SIZE;
  if (!raw) return DEFAULT_CACHE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_CACHE_LIMIT;
}

// Pre-built Sets for O(1) built-in lookups (allocated once, shared across all instances)
export const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
]);

export const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
]);

export const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
]);

export const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
]);

export const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
]);

export const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
  // Kubernetes-common stdlib aliases
  'utilruntime', 'utilwait', 'utilnet',
]);

export const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
]);

export const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
];

export const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
]);

export const C_BUILT_INS = new Set([
  // Standard C library functions
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strstr', 'strchr', 'strrchr', 'strtok', 'strdup',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fputc', 'fgetc',
  'feof', 'ferror', 'fflush', 'fseek', 'ftell', 'rewind',
  'exit', 'abort', 'atexit', 'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtod',
  'qsort', 'bsearch',
  'abs', 'labs', 'rand', 'srand',
  'sin', 'cos', 'tan', 'sqrt', 'pow', 'log', 'log10', 'exp', 'ceil', 'floor', 'fabs',
  'time', 'clock', 'difftime', 'mktime', 'localtime', 'gmtime', 'strftime', 'asctime',
  'assert', 'errno',
  'perror', 'remove', 'rename', 'tmpfile', 'tmpnam',
  'getenv', 'system',
  'signal', 'raise',
  'setjmp', 'longjmp',
  'va_start', 'va_end', 'va_arg', 'va_copy',
  'NULL', 'EOF', 'BUFSIZ', 'FILENAME_MAX', 'RAND_MAX', 'EXIT_SUCCESS', 'EXIT_FAILURE',
  'size_t', 'ptrdiff_t', 'wchar_t', 'intptr_t', 'uintptr_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'FILE',
  // POSIX additions commonly seen
  'stat', 'lstat', 'fstat', 'open', 'close', 'read', 'write', 'pipe',
  'fork', 'exec', 'waitpid', 'getpid', 'getppid', 'kill', 'sleep', 'usleep',
  'pthread_create', 'pthread_join', 'pthread_mutex_lock', 'pthread_mutex_unlock',
  'dlopen', 'dlsym', 'dlclose',
]);

export const CPP_BUILT_INS = new Set([
  // iostream objects (often used without std:: prefix via using)
  'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ws',
  'std', // the namespace itself when used as std::something
  // Common C++ keywords that leak as references
  'nullptr', 'true', 'false', 'this', 'sizeof', 'alignof', 'typeid',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'make_unique', 'make_shared', 'make_pair',
  'move', 'forward', 'swap',
]);
