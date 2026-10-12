var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// ../../node_modules/.bun/ignore@7.0.9/node_modules/ignore/index.js
var require_ignore = __commonJS(function(exports, module) {
  function makeArray(subject) {
    return Array.isArray(subject) ? subject : [subject];
  }
  var UNDEFINED = undefined;
  var EMPTY = "";
  var SPACE = " ";
  var ESCAPE = "\\";
  var REGEX_LITERAL_SPECIAL = /[.*+?()[\]{}^$|\\/]/;
  var REGEX_TEST_BLANK_LINE = /^\uFEFF? *$/;
  var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
  var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
  var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
  var REGEX_SPLITALL_CRLF = /\r?\n/g;
  var DOUBLE_SLASH = "//";
  var SLASH_CODE = 47;
  var DOT_CODE = 46;
  var SLASH = "/";
  var TMP_KEY_IGNORE = "node-ignore";
  if (typeof Symbol !== "undefined") {
    TMP_KEY_IGNORE = Symbol.for("node-ignore");
  }
  var KEY_IGNORE = TMP_KEY_IGNORE;
  var define = (object, key, value) => {
    Object.defineProperty(object, key, { value });
    return value;
  };
  var RETURN_FALSE = () => false;
  var cleanRangeBackSlash = (slashes) => {
    const { length } = slashes;
    return slashes.slice(0, length - length % 2);
  };
  var POSIX_CLASSES = {
    alnum: "0-9A-Za-z",
    alpha: "A-Za-z",
    blank: " \\t",
    cntrl: "\\x00-\\x1f\\x7f",
    digit: "0-9",
    graph: "!-.0-~",
    lower: "a-z",
    print: " -.0-~",
    punct: "!-.:-@\\[-`{-~",
    space: " \\t\\n\\r",
    upper: "A-Z",
    xdigit: "0-9A-Fa-f"
  };
  var CLASS_MEMBERS_TO_ESCAPE = "\\]^-[";
  var escapeMember = (char) => CLASS_MEMBERS_TO_ESCAPE.indexOf(char) < 0 ? char : ESCAPE + char;
  var NON_SLASH = "(?!\\/)";
  var classSource = (negated, body) => {
    if (negated) {
      return `[^\\/${body}]`;
    }
    const source = `[${body}]`;
    return new RegExp(source).test("/") ? NON_SLASH + source : source;
  };
  var scanBracket = (pattern, start) => {
    const { length } = pattern;
    let index = start + 1;
    let negated = EMPTY;
    const lead = pattern[index];
    if (lead === "!" || lead === "^") {
      negated = "^";
      index++;
    }
    let body = EMPTY;
    let prev = EMPTY;
    for (;; ) {
      const char = pattern[index];
      if (char === UNDEFINED) {
        return null;
      }
      if (char === ESCAPE) {
        const escaped = pattern[index + 1];
        if (escaped === UNDEFINED) {
          return null;
        }
        body += escapeMember(escaped);
        prev = escaped;
        index++;
      } else if (char === "-" && prev && index + 1 < length && pattern[index + 1] !== "]") {
        index++;
        let to = pattern[index];
        if (to === ESCAPE) {
          to = pattern[index += 1];
        }
        if (prev <= to) {
          body += `-${escapeMember(to)}`;
        }
        prev = EMPTY;
      } else if (char === "[" && pattern[index + 1] === ":") {
        const nameStart = index + 2;
        let end = nameStart;
        while (end < length && pattern[end] !== "]") {
          end++;
        }
        if (end === length) {
          return null;
        }
        if (end > nameStart && pattern[end - 1] === ":") {
          const expanded = POSIX_CLASSES[pattern.slice(nameStart, end - 1)];
          if (expanded === UNDEFINED) {
            return null;
          }
          body += expanded;
          prev = EMPTY;
          index = end;
        } else {
          body += escapeMember("[");
          prev = "[";
          index = nameStart - 2;
        }
      } else {
        body += escapeMember(char);
        prev = char;
      }
      index++;
      if (pattern[index] === "]") {
        return {
          end: index,
          source: classSource(negated, body)
        };
      }
    }
  };
  var NEVER_MATCH = "[]";
  var PLACEHOLDER = "\x00";
  var REGEX_RESTORE_PLACEHOLDER = new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g");
  var TRAILING_WILDCARD = "";
  var extractBrackets = (pattern) => {
    const sources = [];
    const hold = (source) => `${PLACEHOLDER}${sources.push(source) - 1}${PLACEHOLDER}`;
    const { length } = pattern;
    let out = EMPTY;
    let index = 0;
    while (index < length) {
      const char = pattern[index];
      if (char === ESCAPE) {
        const escaped = pattern[index + 1];
        if (escaped === "*" || escaped === "[" || escaped === SPACE || escaped === ESCAPE) {
          out += pattern.slice(index, index + 2);
        } else {
          out += hold(REGEX_LITERAL_SPECIAL.test(escaped) ? ESCAPE + escaped : escaped);
        }
        index += 2;
      } else if (char === PLACEHOLDER) {
        out += hold(`[${PLACEHOLDER}]`);
        index++;
      } else if (char === "[") {
        const scanned = scanBracket(pattern, index);
        if (scanned === null) {
          out += hold(NEVER_MATCH);
          index = length;
        } else {
          out += hold(scanned.source);
          index = scanned.end + 1;
        }
      } else {
        out += char;
        index++;
      }
    }
    return {
      source: out,
      sources
    };
  };
  var DIRECT = null;
  var REGEX_INNER_SLASH = /\/(?!$)/;
  var REPLACERS = [
    [
      /^\uFEFF/,
      () => EMPTY,
      "\uFEFF"
    ],
    [
      /[\r\n]+$/,
      () => EMPTY
    ],
    [
      /((?:\\\\)*?)(\\? +)$/,
      (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
    ],
    [
      /(\\+?) /g,
      (_, m1) => {
        const { length } = m1;
        return m1.slice(0, length - length % 2) + SPACE;
      }
    ],
    [
      /[\\$.|*+(){^]/g,
      (match) => `\\${match}`
    ],
    [
      /(?!\\)\?/g,
      () => "[^/]",
      "?"
    ],
    [
      /^\//,
      () => "^",
      SLASH
    ],
    [
      /\//g,
      () => "\\/",
      SLASH
    ],
    [
      /^\^*(?:\\\*\\\*\\\/)+/,
      () => "^(?:.*\\/)?",
      "*"
    ],
    [
      DIRECT,
      (source, pattern) => {
        if (!source || source[0] === "^") {
          return source;
        }
        const anchor = !REGEX_INNER_SLASH.test(pattern) ? "(?:^|\\/)" : "^";
        return anchor + source;
      }
    ],
    [
      /\\\/\\\*\\\*(?=\\\/|$)/g,
      (_, index, str) => index + 6 < str.length ? str.slice(index + 6) === "\\/" ? "(?:\\/[^\\/]+)+" : "(?:\\/[^\\/]+)*" : "\\/.+",
      "*"
    ],
    [
      /(^|[^\\]+)(\\\*)+(?=.+)/g,
      (_, p1, p2) => {
        const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
        return p1 + unescaped;
      },
      "*"
    ],
    [
      /(^|[^\\])((?:\\\\)*)\\\*$/,
      (match, p1, p2) => p2.length / 2 % 2 === 0 ? p1 + p2 + TRAILING_WILDCARD : match,
      "*"
    ],
    [
      /\\\\\\(?=[$.|*+(){^])/g,
      () => ESCAPE,
      ESCAPE + ESCAPE
    ],
    [
      /\\\\/g,
      () => ESCAPE,
      ESCAPE + ESCAPE
    ],
    [
      /\\\[([^\]/]*?)(\\*)($|\])/g,
      (match, range, endEscape, close) => `\\[${range}${cleanRangeBackSlash(endEscape)}${close}`,
      "["
    ],
    [
      DIRECT,
      (source) => {
        const last = source[source.length - 1];
        if (!last || last === TRAILING_WILDCARD) {
          return source;
        }
        return last === SLASH ? `${source}$` : `${source}(?=$|\\/$)`;
      }
    ]
  ];
  var REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\uE000$/;
  var MODE_IGNORE = "regex";
  var MODE_CHECK_IGNORE = "checkRegex";
  var UNDERSCORE = "_";
  var TRAILING_WILD_CARD_REPLACERS = {
    [MODE_IGNORE](_, p1) {
      const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
      return `${prefix}(?=$|\\/$)`;
    },
    [MODE_CHECK_IGNORE](_, p1) {
      const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
      return `${prefix}(?=$|\\/$)`;
    }
  };
  var WILDCARD = "[^\\/]*";
  var pinWildcards = (source) => {
    if (source.indexOf(WILDCARD) < 0) {
      return source;
    }
    const tokens = [];
    const { length } = source;
    let index = 0;
    while (index < length) {
      const char = source[index];
      if (source.startsWith(WILDCARD, index)) {
        tokens.push({ wildcard: true });
        index += WILDCARD.length;
      } else if (char === "[") {
        let end = index + 1;
        if (source[end] === "^") {
          end++;
        }
        if (source[end] === "]") {
          end++;
        }
        while (end < length && source[end] !== "]") {
          end += source[end] === ESCAPE ? 2 : 1;
        }
        end++;
        tokens.push({ single: source.slice(index, end) });
        index = end;
      } else if (char === ESCAPE) {
        tokens.push({ single: source.slice(index, index + 2) });
        index += 2;
      } else if (char === "(") {
        let depth = 0;
        let end = index;
        do {
          if (source[end] === ESCAPE) {
            end++;
          } else if (source[end] === "(") {
            depth++;
          } else if (source[end] === ")") {
            depth--;
          }
          end++;
        } while (end < length && depth > 0);
        if ("*+?".indexOf(source[end]) >= 0) {
          end++;
        }
        tokens.push({ boundary: source.slice(index, end) });
        index = end;
      } else if (char === "^" || char === "$") {
        tokens.push({ boundary: char });
        index++;
      } else {
        tokens.push({ single: char });
        index++;
      }
    }
    let out = EMPTY;
    let run = [];
    const flush = () => {
      let lastWildcard;
      run.forEach((token, at) => {
        if (token.wildcard) {
          lastWildcard = at;
        }
      });
      run.forEach((token, at) => {
        if (!token.wildcard) {
          out += token.single;
          return;
        }
        out += at === lastWildcard ? WILDCARD : `(?:(?!${run[at + 1].single})[^\\/])*`;
      });
      run = [];
    };
    tokens.forEach((token) => {
      if (token.boundary === undefined) {
        run.push(token);
        return;
      }
      flush();
      out += token.boundary;
    });
    flush();
    return out;
  };
  var makeRegexPrefix = (pattern) => {
    const { source, sources } = extractBrackets(pattern);
    const replaced = REPLACERS.reduce((prev, [matcher, replacer, required]) => {
      if (matcher === DIRECT) {
        return replacer(prev, pattern);
      }
      if (required !== UNDEFINED && prev.indexOf(required) < 0) {
        return prev;
      }
      return matcher.test(prev) ? prev.replace(matcher, replacer.bind(pattern)) : prev;
    }, source);
    return sources.length ? replaced.replace(REGEX_RESTORE_PLACEHOLDER, (match, index) => sources[index]) : replaced;
  };
  var matchesBasename = (body) => {
    const index = body.indexOf(SLASH);
    return index < 0 || index === body.length - 1;
  };
  var basenameOf = (path) => {
    const end = path.length - 1;
    const index = path.lastIndexOf(SLASH, path[end] === SLASH ? end - 1 : end);
    return index < 0 ? path : path.slice(index + 1);
  };
  var parentOf = (path) => {
    if (path.charCodeAt(0) === SLASH_CODE || path.indexOf(DOUBLE_SLASH) >= 0) {
      const slices = path.split(SLASH).filter(Boolean);
      slices.pop();
      return slices.length ? slices.join(SLASH) + SLASH : EMPTY;
    }
    const end = path.length - 1;
    const cut = path.lastIndexOf(SLASH, path.charCodeAt(end) === SLASH_CODE ? end - 1 : end);
    return cut < 0 ? EMPTY : path.slice(0, cut + 1);
  };
  var isString = (subject) => typeof subject === "string";
  var checkPattern = (pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0;
  var splitPattern = (pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);

  class IgnoreRule {
    constructor(pattern, mark, body, ignoreCase, negative, prefix) {
      this.pattern = pattern;
      this.mark = mark;
      this.negative = negative;
      define(this, "body", body);
      define(this, "ignoreCase", ignoreCase);
      define(this, "regexPrefix", prefix);
    }
    get _basenameOnly() {
      return define(this, "_basenameOnly", matchesBasename(this.body));
    }
    get regex() {
      const key = UNDERSCORE + MODE_IGNORE;
      if (this[key]) {
        return this[key];
      }
      return this._make(MODE_IGNORE, key);
    }
    get checkRegex() {
      const key = UNDERSCORE + MODE_CHECK_IGNORE;
      if (this[key]) {
        return this[key];
      }
      return this._make(MODE_CHECK_IGNORE, key);
    }
    _make(mode, key) {
      const str = pinWildcards(this.regexPrefix.replace(REGEX_REPLACE_TRAILING_WILDCARD, TRAILING_WILD_CARD_REPLACERS[mode]));
      const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
      return define(this, key, regex);
    }
  }
  var createRule = ({
    pattern,
    mark
  }, ignoreCase) => {
    let negative = false;
    let body = pattern;
    if (body.indexOf("!") === 0) {
      negative = true;
      body = body.substr(1);
    }
    body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
    const regexPrefix = makeRegexPrefix(body);
    return new IgnoreRule(pattern, mark, body, ignoreCase, negative, regexPrefix);
  };

  class RuleManager {
    constructor(ignoreCase) {
      this._ignoreCase = ignoreCase;
      this._rules = [];
      this._basenameCount = 0;
    }
    _add(pattern) {
      if (pattern && pattern[KEY_IGNORE]) {
        this._rules = this._rules.concat(pattern._rules._rules);
        this._basenameCount += pattern._rules._basenameCount;
        this._added = true;
        return;
      }
      if (isString(pattern)) {
        pattern = {
          pattern
        };
      }
      if (checkPattern(pattern.pattern)) {
        const rule = createRule(pattern, this._ignoreCase);
        this._added = true;
        this._rules.push(rule);
        if (matchesBasename(rule.body)) {
          this._basenameCount++;
        }
      }
    }
    add(pattern) {
      this._added = false;
      makeArray(isString(pattern) ? splitPattern(pattern) : pattern).forEach(this._add, this);
      return this._added;
    }
    test(path, checkUnignored, mode) {
      let ignored = false;
      let unignored = false;
      let matchedRule;
      const rules = this._rules;
      const { length } = rules;
      const shortcut = this._basenameCount * 2 >= length;
      const basename = shortcut ? basenameOf(path) : path;
      for (let index = 0;index < length; index++) {
        const rule = rules[index];
        const { negative } = rule;
        const skip = unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored;
        if (!skip && rule[mode].test(shortcut && rule._basenameOnly ? basename : path)) {
          ignored = !negative;
          unignored = negative;
          matchedRule = negative ? UNDEFINED : rule;
        }
      }
      const ret = {
        ignored,
        unignored
      };
      if (matchedRule) {
        ret.rule = matchedRule;
      }
      return ret;
    }
  }
  var throwError = (message, Ctor) => {
    throw new Ctor(message);
  };
  var checkPath = (path, originalPath, doThrow) => {
    if (!isString(path)) {
      return doThrow(`path must be a string, but got \`${originalPath}\``, TypeError);
    }
    if (!path) {
      return doThrow(`path must not be empty`, TypeError);
    }
    if (checkPath.isNotRelative(path)) {
      const r = "`path.relative()`d";
      return doThrow(`path should be a ${r} string, but got "${originalPath}"`, RangeError);
    }
    return true;
  };
  var isNotRelative = (path) => {
    const first = path.charCodeAt(0);
    if (first === SLASH_CODE) {
      return true;
    }
    if (first !== DOT_CODE) {
      return false;
    }
    if (path.length === 1) {
      return true;
    }
    const second = path.charCodeAt(1);
    if (second === SLASH_CODE) {
      return true;
    }
    if (second !== DOT_CODE) {
      return false;
    }
    return path.length === 2 || path.charCodeAt(2) === SLASH_CODE;
  };
  checkPath.isNotRelative = isNotRelative;
  checkPath.convert = (p) => p;

  class Ignore {
    constructor({
      ignorecase = true,
      ignoreCase = ignorecase,
      allowRelativePaths = false
    } = {}) {
      define(this, KEY_IGNORE, true);
      this._rules = new RuleManager(ignoreCase);
      this._strictPathCheck = !allowRelativePaths;
      this._initCache();
    }
    _initCache() {
      this._ignoreCache = Object.create(null);
      this._testCache = Object.create(null);
    }
    add(pattern) {
      if (this._rules.add(pattern)) {
        this._initCache();
      }
      return this;
    }
    addPattern(pattern) {
      return this.add(pattern);
    }
    _test(originalPath, cache, checkUnignored) {
      const path = originalPath && checkPath.convert(originalPath);
      checkPath(path, originalPath, this._strictPathCheck ? throwError : RETURN_FALSE);
      return this._t(path, cache, checkUnignored);
    }
    checkIgnore(path) {
      if (path.charCodeAt(path.length - 1) !== SLASH_CODE) {
        return this.test(path);
      }
      const parentPath = parentOf(path);
      if (parentPath) {
        const parent = this._t(parentPath, this._testCache, true);
        if (parent.ignored) {
          return parent;
        }
      }
      return this._rules.test(path, false, MODE_CHECK_IGNORE);
    }
    _t(path, cache, checkUnignored) {
      if (path in cache) {
        return cache[path];
      }
      const parentPath = parentOf(path);
      const parent = parentPath ? this._t(parentPath, cache, checkUnignored) : UNDEFINED;
      return cache[path] = parent && parent.ignored ? parent : this._rules.test(path, checkUnignored, MODE_IGNORE);
    }
    ignores(path) {
      return this._test(path, this._ignoreCache, false).ignored;
    }
    createFilter() {
      return (path) => !this.ignores(path);
    }
    filter(paths) {
      return makeArray(paths).filter(this.createFilter());
    }
    test(path) {
      return this._test(path, this._testCache, true);
    }
  }
  var factory = (options) => new Ignore(options);
  var isPathValid = (path) => checkPath(path && checkPath.convert(path), path, RETURN_FALSE);
  var setupWindows = () => {
    const makePosix = (str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");
    checkPath.convert = makePosix;
    const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
    checkPath.isNotRelative = (path) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
  };
  if (typeof process !== "undefined" && process.platform === "win32") {
    setupWindows();
  }
  module.exports = factory;
  factory.default = factory;
  module.exports.isPathValid = isPathValid;
  define(module.exports, Symbol.for("setupWindows"), setupWindows);
});

// ../../packages/toolkit/dist/browser.js
var import_ignore = __toESM(require_ignore(), 1);
var workspaceRoot = "/workspace";
function decodeSourceFile(file) {
  if (typeof file === "string")
    return new TextEncoder().encode(file);
  if (!file || file.encoding !== "base64" || typeof file.data !== "string")
    throw Error("Invalid prepared project file");
  return Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
}
var workspace = "/workspace";
var server = `${workspace}/.server`;
var configDirectory = `${server}/config/opencode`;
var locationQuery = new URLSearchParams({ "location[directory]": workspace }).toString();
var openCode = {
  port: 4096,
  directory: workspace,
  model: { providerID: "opencode", id: "muse-spark-1.3-contributor-free" },
  configPath: `${configDirectory}/opencode.json`,
  directories: ["home", "config/opencode/plugins", "state", "data", "cache", "tmp"].map((name) => `${server}/${name}`)
};
var defaultAgent = {
  entry: "/app/server.js",
  cwd: "/app",
  port: openCode.port,
  programs: ["opencode-server"],
  env: {
    PATH: "/app/node_modules/.bin:/bin",
    HOME: `${server}/home`,
    OPENCODE_TEST_HOME: `${server}/home`,
    XDG_CONFIG_HOME: `${server}/config`,
    XDG_STATE_HOME: `${server}/state`,
    XDG_DATA_HOME: `${server}/data`,
    XDG_CACHE_HOME: `${server}/cache`,
    TMPDIR: `${server}/tmp`,
    OPENCODE_TREE_SITTER_WASM_PATH: "/app/tree-sitter.wasm",
    OPENCODE_TREE_SITTER_BASH_WASM_PATH: "/app/tree-sitter-bash.wasm",
    OPENCODE_TREE_SITTER_POWERSHELL_WASM_PATH: "/app/tree-sitter-powershell.wasm"
  }
};
var modelSourcePreload = `${server}/editor-model-source.cjs`;
var maxEventBytes = 16 * 1024 * 1024;
var zipTime = new Date(1980, 0, 1);
var sourceMarker = `${workspaceRoot}/.server/source-installed`;
async function installSource(fs, source, initial) {
  if (await fs.stat(sourceMarker).then(() => true, () => false))
    return { installed: 0, preserved: true };
  const supplied = await initial?.() || undefined;
  let installed = 0;
  const made = new Set;
  for (const [path, file] of Object.entries(supplied?.files ?? source).sort(([a], [b]) => a < b ? -1 : 1)) {
    if (!validPath(path))
      throw Error(`Invalid source path: ${path}`);
    const target = workspaceRoot + path;
    if (!supplied && await fs.stat(target).then(() => true, () => false))
      continue;
    const parent = target.slice(0, target.lastIndexOf("/"));
    if (!made.has(parent)) {
      await fs.mkdir(parent);
      made.add(parent);
    }
    await fs.writeFile(target, file instanceof Uint8Array ? file : decodeSourceFile(file));
    installed++;
  }
  await fs.mkdir(`${workspaceRoot}/.server`);
  if (!supplied?.sessions?.length)
    await fs.writeFile(sourceMarker, new Date().toISOString());
  return { installed, preserved: false, initial: supplied };
}
var derivedMarker = `${workspaceRoot}/.server/derived-installed`;
var validPath = (path) => path.startsWith("/") && !path.split("/").slice(1).some((part) => !part || part === "." || part === "..");
async function installDerived(fs, manifest, manifestUrl, signal) {
  const derived = manifest.derived;
  if (!derived)
    return { installed: 0 };
  const identity = [derived.file, manifest.image?.file ?? "", ...(manifest.layers ?? []).map((layer) => layer.file)].join(" ");
  const have = await fs.readFile(derivedMarker).then((bytes) => new TextDecoder().decode(bytes), () => "");
  if (have === identity)
    return { installed: 0 };
  const response = await fetch(new URL(derived.file, manifestUrl), { signal });
  if (!response.ok)
    throw Error(`Prepared derived files unavailable: HTTP ${response.status}`);
  const files = await response.json();
  for (const path of derived.owns) {
    if (!validPath("/" + path))
      throw Error(`Invalid derived directory: ${path}`);
    await fs.remove(`${workspaceRoot}/${path}`);
  }
  const made = new Set;
  let installed = 0;
  for (const [path, file] of Object.entries(files)) {
    if (!validPath(path))
      throw Error(`Invalid derived path: ${path}`);
    const target = workspaceRoot + path, parent = target.slice(0, target.lastIndexOf("/"));
    if (!made.has(parent)) {
      await fs.mkdir(parent);
      made.add(parent);
    }
    await fs.writeFile(target, decodeSourceFile(file));
    installed++;
  }
  await fs.mkdir(`${workspaceRoot}/.server`);
  await fs.writeFile(derivedMarker, identity);
  return { installed };
}

// src/opencode.ts
var workspace2 = "/workspace";
var state = `${workspace2}/.server`;
var configPath = `${state}/config/opencode/opencode.json`;
function serverConfig(model, hosted) {
  const base = {
    $schema: "https://opencode.ai/config.json",
    snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }]
  };
  if (!model)
    return hosted ? { ...base, model: `opencode/${hosted}` } : base;
  return {
    ...base,
    model: `direct/${model.id}`,
    providers: { direct: {
      name: new URL(model.baseURL).host,
      activation: "enabled",
      settings: { baseURL: model.baseURL, apiKey: model.apiKey },
      models: { [model.id]: {
        name: model.id,
        package: "@opencode/ai/providers/openai",
        websocket: false,
        disabled: false,
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 200000, output: 8192 }
      } }
    } }
  };
}
async function installServerConfig(fs, model, hosted) {
  for (const name of ["home", "config/opencode/plugins", "state", "data", "cache", "tmp"])
    await fs.mkdir(`${state}/${name}`);
  await fs.writeFile(`${state}/.gitignore`, `*
`);
  for (const name of ["editor-model-headers.js", "editor-javascript.js", "editor-model-catalog.js"])
    await fs.remove(`${state}/config/opencode/plugins/${name}`);
  await fs.writeFile(configPath, JSON.stringify(serverConfig(model, hosted), null, 2));
}
function toLaunch(description, env = {}) {
  return {
    argv: ["node", description.entry, ...description.args ?? []],
    cwd: description.cwd ?? workspace2,
    env: { PATH: "/bin", HOME: `${state}/home`, ...description.env, ...env },
    programs: description.programs ?? []
  };
}
function serverLaunch(description, password, model, { fetchMap = {}, tunnel } = {}) {
  const url = model && new URL(model.baseURL);
  const loopback = !!url && /^(localhost|127(\.\d+){3}|\[::1\])$/.test(url.hostname) && url.protocol === "http:";
  return toLaunch(description, {
    OPENCODE_PASSWORD: password,
    OPENCODE_DATABASE_PATH: `${state}/data/opencode.sqlite`,
    BAT_FETCH_DIAG: "1",
    ...Object.keys(fetchMap).length ? { BAT_FETCH_MAP: JSON.stringify(fetchMap) } : {},
    ...tunnel ? { BAT_FETCH_TUNNEL: tunnel.to.join(" "), BAT_FETCH_TUNNEL_URL: tunnel.url, ...tunnel.protocol === "wisp" ? { BAT_FETCH_TUNNEL_PROTOCOL: "wisp" } : {} } : {},
    OPENCODE_LOG_LEVEL: "WARN",
    ...loopback ? { BAT_HOST_LOOPBACK_PORTS: url.port || "80" } : {}
  });
}
async function serverHealthy(endpoint, authorization, signal) {
  let last = "no answer";
  for (const deadline = Date.now() + 60000;Date.now() < deadline; ) {
    signal.throwIfAborted();
    try {
      const response = await endpoint.fetch("/api/info", { headers: { authorization }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      await response.arrayBuffer();
      if (response.ok)
        return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`The OpenCode server did not become healthy within 60 s (${last})`);
}

// src/client.ts
var clientEntry = "/app/tui/main.js";
var home = "/home/user";
var tapDirectory = "/tmp/opencode-client";
var clientLog = `${tapDirectory}/tui.log`;
var tap = { script: `${tapDirectory}/tap.mjs`, file: `${tapDirectory}/signin.jsonl` };
function clientLaunch(port, password, tapped) {
  return {
    argv: ["node", ...tapped ? ["--import", tap.script] : [], clientEntry],
    cwd: workspace2,
    env: {
      PATH: "/bin",
      HOME: home,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OPENCODE_SERVER_URL: `http://127.0.0.1:${port}`,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DIRECTORY: workspace2,
      ...tapped ? { SIGNIN_TAP_FILE: tap.file } : {},
      OPENCODE_TUI_LOG: clientLog
    },
    programs: []
  };
}
async function installClient(fs, signIn) {
  const state2 = `${home}/.local/state/opencode`;
  for (const directory of [state2, ...await fs.readdir(state2).then((names) => names.map((name) => `${state2}/${name}`), () => [])])
    await fs.remove(`${directory}/locks`);
  await fs.mkdir(tapDirectory);
  if (!signIn)
    return;
  const { exchange } = signIn;
  await fs.writeFile(tap.script, signIn.script);
  await fs.writeFile(tap.file, "");
  let seen = 0;
  const decoder = new TextDecoder;
  fs.watch(tapDirectory, () => void fs.readFile(tap.file).then((bytes) => {
    const lines = decoder.decode(bytes).split(`
`).filter(Boolean);
    for (const line of lines.slice(seen)) {
      try {
        exchange(JSON.parse(line));
      } catch {}
    }
    seen = lines.length;
  }, () => {}));
}

// src/diag.ts
var text = (value, limit = 2000) => {
  if (value instanceof Error) {
    let out = `${value.name}: ${value.message}
${value.stack ?? ""}`;
    for (let cause = value.cause, depth = 0;cause && depth < 4; cause = cause.cause, depth++)
      out += `
caused by: ${cause instanceof Error ? `${cause.name}: ${cause.message}
${cause.stack ?? ""}` : String(cause)}`;
    return out.slice(0, limit);
  }
  if (typeof value === "string")
    return value.slice(0, limit);
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
};
var isPanel = (given) => given === "1" || given === "panel";
function installDiag(params, built, panelBuilt = false) {
  const given = params.get("diag");
  const url = given === "0" ? null : given && !isPanel(given) ? given : built === null ? null : built ?? `${location.protocol}//${location.hostname}:4311/diag`;
  const id = Math.random().toString(36).slice(2, 8);
  const panel = (isPanel(given) || panelBuilt) && params.get("panel") !== "0" ? installPanel(url, id) : undefined;
  let queue = [], timer;
  const flush = () => {
    timer = undefined;
    if (!url || !queue.length)
      return;
    const body = JSON.stringify(queue);
    queue = [];
    fetch(url, { method: "POST", body, headers: { "content-type": "text/plain" }, keepalive: body.length < 60000 }).catch(() => {});
  };
  const event = (kind, data) => {
    panel?.event(kind, data);
    if (!url)
      return;
    queue.push({ id, t: Math.round(performance.now()), kind, data: data instanceof Error ? text(data) : data });
    timer ??= setTimeout(flush, 500);
  };
  event("start", { href: location.href, userAgent: navigator.userAgent, isolated: crossOriginIsolated, viewport: [innerWidth, innerHeight], touch: navigator.maxTouchPoints });
  window.addEventListener("error", (e) => event(!e.filename || !e.filename.includes(location.origin) ? "foreign" : "error", e.error instanceof Error ? `${text(e.error)}
(${e.filename}:${e.lineno}:${e.colno})` : `${e.message} (${e.filename}:${e.lineno}:${e.colno})`));
  window.addEventListener("unhandledrejection", (e) => event("rejection", e.reason instanceof Error ? e.reason : text(e.reason)));
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      event("console." + level, args.map((arg) => text(arg)).join(" "));
      original(...args);
    };
  }
  window.addEventListener("pagehide", flush);
  return {
    event,
    panel: !!panel,
    watchScreen(screen) {
      let last = "";
      setInterval(() => {
        let now = "";
        try {
          now = screen().map((line) => line.trimEnd()).join(`
`).trim();
        } catch (error) {
          now = "screen() failed: " + text(error);
        }
        if (now !== last) {
          last = now;
          panel?.screen(now);
          if (url)
            event("screen", now);
        }
      }, 2000);
    }
  };
}
var traceChannel = "bat-trace";
var reportChannel = "bat-diag";
var lastKey = "terminal-app-diag-last";
var loadsKey = "terminal-app-diag-loads";
function installPanel(collector, id) {
  const started = new Date;
  const ms = (t) => `${String(Math.round(t)).padStart(6)} ms`;
  const mib = (bytes) => bytes === undefined ? "?" : `${(bytes / 1048576).toFixed(1)} MiB`;
  const stages = [], errors = [], warnings = [], logs = [], marks = [], foreign = [], frameLog = [], uploads = [];
  const facts = {};
  let lastError, screenText = "", traceTotal = 0;
  let previous = "";
  try {
    previous = localStorage.getItem(lastKey) ?? "";
  } catch {}
  let loads = 1;
  try {
    loads = Number(sessionStorage.getItem(loadsKey) ?? 0) + 1;
    sessionStorage.setItem(loadsKey, String(loads));
  } catch {}
  const push = (list, kind, value, limit) => {
    const line = { t: performance.now(), kind, text: text(value, 4000) };
    list.push(line);
    if (list.length > limit)
      list.shift();
    changed();
    return line;
  };
  const problem = (kind, value) => {
    lastError = push(errors, kind, value, 60);
    uploadSoon("error");
  };
  const root = document.createElement("section");
  root.id = "diag";
  root.setAttribute("aria-label", "Diagnostics");
  root.innerHTML = `<style>
    #diag { position: fixed; left: 0; right: 0; bottom: 0; z-index: 20; display: flex; flex-direction: column; max-height: 55vh; background: #0d0d12f2; color: #c8c5b4; border-top: 1px solid #54546d; font: 11px/1.4 ui-monospace, Menlo, monospace; }
    #diag.small { left: auto; right: 6px; bottom: 6px; border: 1px solid #54546d; border-radius: 6px; }
    #diag.small > pre, #diag.small > textarea, #diag.small .wide { display: none; }
    #diag > header { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 5px 8px; }
    #diag > header b { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #dcd7ba; }
    #diag > header b.bad { color: #e06c75; }
    #diag > header { flex-wrap: wrap; }
    #diag > header i { flex: 1 0 100%; order: -1; font-style: normal; color: #98bb6c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #diag.small > header { max-width: 92vw; }
    #diag.tall { max-height: 94vh; font-size: 9px; line-height: 1.25; }
    #diag button { font: inherit; padding: 5px 10px; }
    #diag > pre { flex: 1 1 auto; min-height: 0; margin: 0; padding: 0 8px 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; -webkit-user-select: text; user-select: text; }
    #diag > textarea { flex: 0 0 30vh; margin: 0 8px 8px; font: inherit; color: inherit; background: #16161d; border: 1px solid #54546d; }
    #diag > textarea[hidden] { display: none; }
  </style>
  <header><i></i><b></b><button type="button" name="send">Send</button><button type="button" name="copy" class="wide">Copy all</button><button type="button" name="toggle">Hide</button></header>
  <pre></pre><textarea readonly hidden aria-label="The readout as text, to select and copy by hand"></textarea>`;
  const headline = root.querySelector("b"), body = root.querySelector("pre"), manual = root.querySelector("textarea");
  const marker = root.querySelector("i"), sendButton = root.querySelector('button[name="send"]');
  const toggle = root.querySelector('button[name="toggle"]'), copy = root.querySelector('button[name="copy"]');
  if (new URLSearchParams(location.search).get("diagTall") === "1")
    root.classList.add("tall");
  const attach = () => document.body.append(root);
  if (document.body)
    attach();
  else
    addEventListener("DOMContentLoaded", attach);
  let touched = false;
  const small = (on) => {
    root.classList.toggle("small", on);
    toggle.textContent = on ? "Diagnostics" : "Hide";
    render();
  };
  toggle.addEventListener("click", () => {
    touched = true;
    small(!root.classList.contains("small"));
  });
  copy.addEventListener("click", () => {
    const all = readout(true);
    const shown = (label) => {
      copy.textContent = label;
      setTimeout(() => {
        copy.textContent = "Copy all";
      }, 2500);
    };
    const byHand = () => {
      manual.hidden = false;
      manual.value = all;
      manual.focus();
      manual.select();
      manual.setSelectionRange(0, all.length);
      let done = false;
      try {
        done = document.execCommand("copy");
      } catch {}
      shown(done ? "Copied" : "Select all, copy");
      if (done)
        manual.hidden = true;
    };
    if (navigator.clipboard?.writeText)
      navigator.clipboard.writeText(all).then(() => shown(`Copied ${all.length} chars`), byHand);
    else
      byHand();
  });
  const fact = (name, value) => {
    facts[name] = value;
    changed();
  };
  const estimate = () => {
    if (!navigator.storage?.estimate)
      return fact("storage.estimate", "not offered");
    navigator.storage.estimate().then((e) => fact("storage.estimate", `usage ${mib(e.usage)}, quota ${mib(e.quota)}`), (e) => fact("storage.estimate", `failed: ${text(e, 300)}`));
  };
  const stored = async () => {
    const found = [];
    const walk = async (directory, path, depth) => {
      for await (const [name, handle] of directory.entries()) {
        if (found.length >= 40)
          return;
        if (handle.kind === "file")
          found.push(`${path}${name} ${await handle.getFile().then((file) => mib(file.size), () => "(size not readable)")}`);
        else if (depth < 5)
          await walk(handle, `${path}${name}/`, depth + 1);
      }
    };
    try {
      await walk(await navigator.storage.getDirectory(), "", 0);
      fact("storage files", found.join("; ") || "none");
    } catch (error) {
      fact("storage files", `not readable: ${text(error, 200)}`);
    }
  };
  try {
    const { port1, port2 } = new MessageChannel, probe2 = new ReadableStream;
    port1.postMessage(probe2, [probe2]);
    port1.close();
    port2.close();
    facts["stream transfer"] = "yes";
  } catch (error) {
    facts["stream transfer"] = `NO (${text(error, 120)}): preview bodies over 256 KB cross a port instead`;
  }
  const storage = () => {
    estimate();
    stored();
  };
  storage();
  setInterval(storage, 15000);
  navigator.storage?.persisted?.().then((p) => fact("storage.persisted", String(p)), (e) => fact("storage.persisted", `failed: ${text(e, 300)}`));
  const probe = `onmessage = async () => { const t = performance.now(); try {
    const d = await navigator.storage.getDirectory(); const f = await d.getFileHandle('diag-probe', { create: true });
    const h = await f.createSyncAccessHandle(); const n = h.write(new Uint8Array(4096), { at: 0 }); h.flush(); const size = h.getSize(); h.close();
    await d.removeEntry('diag-probe').catch(() => {});
    postMessage('ok: created, wrote ' + n + ' bytes, size ' + size + ', ' + Math.round(performance.now() - t) + ' ms');
  } catch (e) { postMessage('FAILED: ' + (e && e.name) + ': ' + (e && e.message)) } }`;
  const native = window.Worker;
  try {
    const address = URL.createObjectURL(new Blob([probe], { type: "text/javascript" }));
    const worker = new native(address);
    const end = (value) => {
      fact("opfs sync handle (probe)", value);
      worker.terminate();
      URL.revokeObjectURL(address);
    };
    worker.onmessage = (e) => end(String(e.data));
    worker.onerror = (e) => end(`FAILED: the probe worker did not run: ${e.message}`);
    setTimeout(() => {
      if (!facts["opfs sync handle (probe)"])
        end("no answer in 10 s");
    }, 1e4);
    worker.postMessage(0);
  } catch (error) {
    fact("opfs sync handle (probe)", `FAILED: ${text(error, 300)}`);
  }
  window.Worker = new Proxy(native, {
    construct(target2, args) {
      const worker = new target2(...args);
      const name = args[1]?.name || String(args[0]).split("/").pop()?.split("?")[0] || "worker";
      worker.addEventListener("error", (e) => problem("worker error", `${name}: ${e.message || "(no message: the script failed to load, or the worker was killed)"} ${e.filename ?? ""}:${e.lineno ?? ""}`));
      worker.addEventListener("messageerror", () => problem("worker messageerror", name));
      push(stages, "worker", `created ${name}`, 300);
      return worker;
    }
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.name.startsWith("bat:"))
          continue;
        const detail = entry.detail;
        if (typeof detail?.kernelMemoryBytes === "number")
          facts["kernel memory"] = `allocated: ${mib(detail.kernelMemoryBytes)} shared${detail.kernelMemoryFixed === false ? ", growable" : ", fixed"}`;
        const line = { t: entry.startTime, kind: "runtime", text: `${entry.name.slice(4)}${detail ? " " + text(Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v])), 600) : ""}` };
        stages.push(line);
      }
      stages.sort((a, b) => a.t - b.t);
      changed();
    }).observe({ type: "mark", buffered: true });
  } catch {}
  try {
    const channel = new BroadcastChannel(traceChannel);
    channel.onmessage = (e) => {
      const mark = e.data;
      if (!mark?.name)
        return;
      traceTotal++;
      marks.push({ t: (mark.t ?? 0) - performance.timeOrigin, kind: mark.src ?? "", text: `${mark.name}${mark.data === undefined ? "" : " " + text(mark.data, 120)}` });
      if (marks.length > 400)
        marks.shift();
      changed();
    };
    const reports = new BroadcastChannel(reportChannel);
    reports.onmessage = (e) => problem(`runtime ${e.data?.src ?? ""}`.trim(), e.data?.text ?? e.data);
  } catch {}
  addEventListener("pagehide", (e) => {
    push(stages, "page", `pagehide${e.persisted ? " (kept by the browser)" : ""}`, 300);
    save();
  });
  document.addEventListener("visibilitychange", () => push(stages, "page", `visibility ${document.visibilityState}`, 300));
  navigator.serviceWorker?.addEventListener("controllerchange", () => push(stages, "page", "service worker controller changed", 300));
  window.__batPreviewReport = true;
  addEventListener("message", (e) => {
    const said = e.data;
    if (!said || said.t !== "bat-preview" || e.origin !== location.origin)
      return;
    push(frameLog, said.kind ?? "", said.text ?? "", 120);
    if (said.kind === "error" || said.kind === "rejection" || said.kind === "console.error")
      problem(`app frame ${said.kind}`, said.text ?? "");
  });
  const describe = (element) => element ? `${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""}` : "nothing";
  const size = (box) => `${Math.round(box.width)}x${Math.round(box.height)}`;
  let frameKey = "", frameMark = "app: no frame yet";
  function frameFacts(full) {
    const out = [];
    const say = (line) => out.push(line);
    try {
      const frame = document.querySelector("iframe#app");
      if (!frame)
        return ["app: no iframe#app in this page"];
      const box = frame.getBoundingClientRect(), style = getComputedStyle(frame);
      const over = box.width > 0 && box.height > 0 ? document.elementFromPoint(box.left + box.width / 2, Math.min(box.top + 80, box.top + box.height / 2)) : null;
      const view = window.visualViewport;
      say(`frame element: box ${size(box)} at ${Math.round(box.left)},${Math.round(box.top)}, display ${style.display}, visibility ${style.visibility}, opacity ${style.opacity}, src ${frame.getAttribute("src") ? "set" : "not set"}; on top at its upper middle: ${describe(over)}`);
      say(`page: scroll ${Math.round(scrollX)},${Math.round(scrollY)}, body scroll ${document.body.scrollLeft},${document.body.scrollTop}, inner ${innerWidth}x${innerHeight}, visual viewport ${view ? `${size(view)} at ${Math.round(view.offsetLeft)},${Math.round(view.offsetTop)} scale ${view.scale.toFixed(2)}` : "n/a"}, body.closed ${document.body.classList.contains("closed")}, focus in ${describe(document.activeElement)}`);
      let inner = null, inside = null;
      try {
        inner = frame.contentDocument;
        inside = frame.contentWindow;
      } catch (error) {
        say(`frame document: not readable: ${text(error, 200)}`);
      }
      if (!inner || !inside || !frame.getAttribute("src")) {
        frameMark = `app: not loaded, frame ${size(box)}`;
        return [frameMark, ...out];
      }
      const nodes = inner.querySelectorAll("*").length;
      const appRoot = inner.getElementById("root"), body2 = inner.body;
      const heading = inner.querySelector("h1")?.textContent?.trim().slice(0, 30);
      const bodyBox = body2?.getBoundingClientRect(), bodyStyle = body2 ? inside.getComputedStyle(body2) : undefined;
      const rootBox = appRoot?.getBoundingClientRect();
      say(`frame document: ${inner.readyState}, ${inside.location.pathname}, title "${inner.title}", ${nodes} nodes, window ${inside.innerWidth}x${inside.innerHeight}, visibility ${inner.visibilityState}`);
      say(`frame #root: ${appRoot ? `${appRoot.childElementCount} children, innerText ${appRoot.innerText?.length ?? 0} chars, box ${rootBox ? size(rootBox) : "?"}` : "missing"}; h1 ${heading === undefined ? "none" : `"${heading}"`}`);
      say(`frame body: ${bodyBox && bodyStyle ? `box ${size(bodyBox)}, computed ${bodyStyle.width} x ${bodyStyle.height}, display ${bodyStyle.display}, visibility ${bodyStyle.visibility}, color ${bodyStyle.color} on ${bodyStyle.backgroundColor}` : "none"}; stylesheets ${inner.styleSheets.length}, style elements ${inner.querySelectorAll("style").length}`);
      const shim = inside;
      say(`frame scripts: preview shim ${shim.__batPreviewShim ? "ran" : "did NOT run"}, dev client websocket ${shim.__batPreviewWs ?? "never opened"}, vite client ${inner.querySelector('script[src*="@vite/client"]') ? "in the document" : "not in the document"}, window.ethereum ${typeof shim.ethereum} (top: ${typeof window.ethereum})`);
      frameMark = `app: ${nodes} nodes, ${size(box)}${heading === undefined ? ", no h1" : ` "${heading}"`}${appRoot?.childElementCount ? "" : ", #root EMPTY"}`;
      {
        const requests = inside.performance.getEntriesByType("resource");
        say(`frame requests (${requests.length}; status as the frame saw it, ms, bytes):`);
        for (const entry of requests.slice(full ? -60 : -8))
          say(`  ${entry.responseStatus ?? "?"}  ${String(Math.round(entry.duration)).padStart(5)} ms  ${String(entry.decodedBodySize ?? "?").padStart(7)}  ${entry.initiatorType}  ${entry.name.replace(location.origin, "").slice(0, 140)}`);
      }
    } catch (error) {
      say(`reading the frame failed: ${text(error, 300)}`);
    }
    return [frameMark, ...out];
  }
  let sent = 0, sendFailed = "", autoSends = 0;
  const pendingSends = new Map;
  const target = (why) => `${collector}${collector.includes("?") ? "&" : "?"}id=${id}&why=${why}`;
  const upload = (why) => {
    if (!collector)
      return Promise.resolve("no collector: add ?diag=<url>");
    const all = readout(true);
    return fetch(target(why), { method: "POST", mode: "cors", credentials: "omit", body: all, headers: { "content-type": "text/plain" } }).then((response) => {
      if (response.ok) {
        sent++;
        sendFailed = "";
        push(uploads, why, `sent ${all.length} chars`, 40);
        return `Sent (${sent})`;
      }
      sendFailed = `HTTP ${response.status}`;
      push(uploads, why, sendFailed, 40);
      return `Send: ${sendFailed}`;
    }, (error) => {
      sendFailed = text(error, 200);
      push(uploads, why, `failed: ${sendFailed}`, 40);
      return "Send failed";
    });
  };
  const uploadSoon = (why, after = 2000) => {
    if (!collector || pendingSends.has(why) || autoSends >= 60)
      return;
    autoSends++;
    pendingSends.set(why, setTimeout(() => {
      pendingSends.delete(why);
      upload(why);
    }, after));
  };
  sendButton.addEventListener("click", () => {
    sendButton.textContent = "Sending…";
    upload("button").then((label) => {
      sendButton.textContent = label;
      setTimeout(() => {
        sendButton.textContent = "Send";
      }, 4000);
    });
  });
  addEventListener("pagehide", () => {
    if (!collector || !navigator.sendBeacon)
      return;
    try {
      navigator.sendBeacon(target("pagehide"), new Blob([readout(true).slice(0, 60000)], { type: "text/plain" }));
    } catch {}
  });
  setInterval(() => {
    const first = frameFacts(false)[0];
    marker.textContent = `${first}${collector ? sendFailed ? " · send FAILED" : ` · sent ${sent}` : ""}`;
    if (first !== frameKey) {
      frameKey = first;
      changed();
      uploadSoon("frame", 2500);
    }
  }, 1000);
  const lines = (list, last) => (last ? list.slice(-last) : list).map((line) => `${ms(line.t)}  ${line.kind ? `[${line.kind}] ` : ""}${line.text}`);
  function readout(full) {
    const memory = performance.memory;
    const controller = navigator.serviceWorker?.controller;
    const out = [
      `diagnostics of ${location.href}`,
      `loaded ${started.toISOString()}, now +${Math.round(performance.now())} ms, load ${loads} of this tab`,
      `collector: ${collector ?? "none (?diag=<url>)"}${collector ? `, load id ${id}, ${sent} sent${sendFailed ? `, last failure: ${sendFailed}` : ""}` : ""}`,
      "",
      `LAST ERROR: ${lastError ? `+${Math.round(lastError.t)} ms [${lastError.kind}]
${lastError.text}` : "none"}`,
      "",
      "APP FRAME",
      ...frameFacts(full),
      `inside the frame, as its shim said it (${frameLog.length}):`,
      ...lines(frameLog, full ? undefined : 6),
      "",
      `STAGES (${stages.length})`,
      ...lines(stages),
      "",
      `ERRORS, REJECTIONS, WORKER CRASHES, console.error (${errors.length})`,
      ...lines(errors, full ? undefined : 8),
      "",
      `SCRIPTS NOT OF THIS PAGE THAT FAILED IN IT (injected by the browser or an extension) (${foreign.length})`,
      ...lines(foreign, full ? undefined : 3),
      "",
      `WARNINGS (${warnings.length})`,
      ...lines(warnings, full ? undefined : 4),
      "",
      `LOG (last ${full ? 80 : 12} of ${logs.length})`,
      ...lines(logs, full ? 80 : 12),
      "",
      `RUNTIME TRACE (last ${full ? Math.min(marks.length, 400) : Math.min(marks.length, 15)} of ${traceTotal})`,
      ...lines(marks, full ? 400 : 15)
    ];
    out.push("", "ENVIRONMENT", `user agent: ${navigator.userAgent}`, `platform: ${navigator.platform}, touch points ${navigator.maxTouchPoints}, cores ${navigator.hardwareConcurrency ?? "?"}, deviceMemory ${navigator.deviceMemory ?? "?"}, viewport ${innerWidth}x${innerHeight} @${devicePixelRatio}, standalone ${navigator.standalone ?? "n/a"}`, `crossOriginIsolated: ${crossOriginIsolated}, secure context: ${isSecureContext}, SharedArrayBuffer: ${typeof SharedArrayBuffer}, Atomics.waitAsync: ${typeof Atomics.waitAsync}, DecompressionStream: ${typeof DecompressionStream}`, `service worker: ${!("serviceWorker" in navigator) ? "not offered" : controller ? `controls the page (${controller.state}, ${controller.scriptURL.split("/").pop()})` : "does not control the page"}`, ...Object.entries(facts).map(([name, value]) => `${name}: ${value}`), ...facts["kernel memory"] ? [] : ["kernel memory: not allocated yet (or the runtime never got that far)"], ...memory ? [`js heap: ${mib(memory.usedJSHeapSize)} of ${mib(memory.jsHeapSizeLimit)}`] : [], "");
    if (full)
      out.push("", `UPLOADS (${uploads.length})`, ...lines(uploads), "", "TERMINAL SCREEN", screenText || "(nothing drawn)");
    if (previous)
      out.push("", `PREVIOUS LOAD OF THIS PAGE IN THIS BROWSER (what it had reached; ${full ? "whole" : "its head, Copy all has the rest"})`, full ? previous : previous.split(`
`).slice(0, 14).join(`
`));
    return out.join(`
`);
  }
  const save = () => {
    try {
      localStorage.setItem(lastKey, readout(true).split(`
PREVIOUS LOAD OF THIS PAGE`)[0].slice(0, 60000));
    } catch {}
  };
  let pending, saved = 0;
  let frozen = false;
  const pageAfter = Number(new URLSearchParams(location.search).get("diagPage"));
  if (pageAfter > 0)
    setTimeout(() => {
      frozen = true;
      root.classList.remove("small");
      body.textContent = readout(true).split(`
PREVIOUS LOAD OF THIS PAGE`)[0];
      body.scrollTop = 0;
      setInterval(() => {
        body.scrollTop += Math.round(body.clientHeight * 0.9);
      }, 3000);
    }, pageAfter * 1000);
  function render() {
    pending = undefined;
    const failed = stages.findLast((line) => line.kind === "failed");
    const stage = stages.findLast((line) => line.kind === "stage" || line.kind === "failed");
    headline.textContent = `diag · ${failed ? "FAILED" : stage?.text.slice(0, 60) ?? "starting"}${errors.length ? ` · ${errors.length} error(s)` : ""}`;
    headline.classList.toggle("bad", !!failed || errors.length > 0);
    if (!root.classList.contains("small") && !frozen) {
      const pinned = body.scrollTop < 4;
      body.textContent = readout(false);
      if (pinned)
        body.scrollTop = 0;
    }
    if (performance.now() - saved > 2000) {
      saved = performance.now();
      save();
    }
  }
  function changed() {
    pending ??= setTimeout(render, 250);
  }
  changed();
  setInterval(save, 5000);
  return {
    event(kind, data) {
      if (kind === "stage") {
        push(stages, "stage", data, 300);
        if (data === "terminal mounted" && !touched && !errors.length)
          small(true);
        if (data === "terminal mounted")
          uploadSoon("mounted", 4000);
      } else if (kind === "failed") {
        push(stages, "failed", data instanceof Error ? data.message : data, 300);
        problem("failed", data);
      } else if (kind === "foreign")
        push(foreign, "", data, 40);
      else if (kind === "log")
        push(logs, "", data, 400);
      else if (kind === "console.warn")
        push(warnings, "", data, 60);
      else if (kind === "start" || kind === "screen") {} else
        problem(kind, data);
    },
    screen(now) {
      screenText = now;
    }
  };
}

// src/isolate.ts
var key = "terminal-app-isolating";
async function isolate(workerUrl, scope, note) {
  if (!("serviceWorker" in navigator))
    throw Error("This page needs a service worker, and this browser offers none here (a private window, or a page that is not https or localhost).");
  const registration = await navigator.serviceWorker.register(workerUrl, { scope, updateViaCache: "none" });
  for (const other of await navigator.serviceWorker.getRegistrations()) {
    if (other.scope !== registration.scope && other.scope.startsWith(registration.scope)) {
      note("stage", `removing an older service worker at ${other.scope}`);
      await other.unregister().catch(() => {});
    }
  }
  await registration.update().catch(() => {});
  const next = registration.installing ?? registration.waiting;
  if (next) {
    await new Promise((resolve) => {
      const check = () => {
        if (next.state === "activated" || next.state === "redundant")
          resolve();
      };
      next.addEventListener("statechange", check);
      check();
      setTimeout(resolve, 1e4);
    });
  }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
  }
  const tries = Number(sessionStorage.getItem(key) ?? 0);
  if (navigator.serviceWorker.controller && crossOriginIsolated) {
    sessionStorage.removeItem(key);
    note("stage", `isolated by the service worker${tries ? ` after ${tries} reload(s)` : ""}`);
    return;
  }
  if (tries >= 2) {
    sessionStorage.removeItem(key);
    throw Error(`This page could not be cross-origin isolated (service worker ${navigator.serviceWorker.controller ? "controls the page" : "does not control the page"}, crossOriginIsolated ${crossOriginIsolated}).`);
  }
  sessionStorage.setItem(key, String(tries + 1));
  addEventListener("pageshow", (event) => {
    if (event.persisted)
      location.reload();
  });
  note("stage", "reloading once so the service worker serves this page");
  location.reload();
  await new Promise(() => {});
}

// src/panel.ts
var widthKey = "terminal-panel-width";
var openKey = "terminal-panel-open";
var stored = (key2) => {
  try {
    return localStorage.getItem(key2);
  } catch {
    return null;
  }
};
var store = (key2, value) => {
  try {
    localStorage.setItem(key2, value);
  } catch {}
};
function installPanel2(options = {}) {
  const body = document.body;
  const panel = document.querySelector("#panel"), grip = document.querySelector("#grip");
  const clamp = (pixels) => Math.round(Math.max(280, Math.min(window.innerWidth - 120, pixels)));
  const setWidth = (pixels) => {
    if (window.innerWidth <= 700)
      return;
    body.style.setProperty("--panel", `${clamp(pixels)}px`);
  };
  const saved = Number(stored(widthKey));
  if (saved > 0)
    setWidth(saved);
  let open = !options.startClosed && stored(openKey) !== "0";
  const apply = () => body.classList.toggle("closed", !open);
  apply();
  const setOpen = (next) => {
    open = next;
    store(openKey, next ? "1" : "0");
    if (!next && panel.contains(document.activeElement))
      document.activeElement.blur();
    apply();
    if (next)
      options.onOpen?.();
    options.onChange?.(next);
  };
  document.querySelector("#close").addEventListener("click", () => setOpen(false));
  document.querySelector("#open").addEventListener("click", () => setOpen(true));
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0)
      return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    body.classList.add("dragging");
    const move = (moved) => setWidth(window.innerWidth - moved.clientX);
    const end = () => {
      grip.removeEventListener("pointermove", move);
      body.classList.remove("dragging");
      store(widthKey, String(panel.getBoundingClientRect().width));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end, { once: true });
    grip.addEventListener("pointercancel", end, { once: true });
  });
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      return;
    setWidth(panel.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 24 : -24));
    store(widthKey, String(panel.getBoundingClientRect().width));
  });
  window.addEventListener("resize", () => {
    if (body.style.getPropertyValue("--panel"))
      setWidth(panel.getBoundingClientRect().width);
  });
  return { get open() {
    return open;
  }, setOpen, setWidth };
}

// src/signin.ts
var loopback = /^(127(\.\d+){3}|localhost|\[::1\])$/;
var start = /^\/api\/integration\/[^/]+\/connect\/oauth$/;
var status = /^\/api\/integration\/[^/]+\/connect\/oauth\/([^/]+)$/;
function watchSignIn(runtime, log) {
  const bar = document.querySelector("#signin");
  const link = bar.querySelector("a"), input = bar.querySelector("input"), note = bar.querySelector("output");
  let pending;
  let clear;
  const show = (next, failure) => {
    pending = next;
    clearTimeout(clear);
    bar.hidden = !next && !failure;
    bar.classList.toggle("over", !next);
    if (!next) {
      note.textContent = failure ? `Sign-in ${failure}` : "";
      if (failure)
        clear = setTimeout(() => show(undefined), 30000);
      return;
    }
    link.href = next.url;
    input.value = "";
    input.placeholder = `http://127.0.0.1:${next.port}${next.path}?code=…`;
    note.textContent = "";
    try {
      window.open(next.url, "_blank");
    } catch {}
  };
  bar.addEventListener("submit", (event) => {
    event.preventDefault();
    const now = pending, host = runtime();
    if (!now || !host)
      return;
    let pasted;
    try {
      pasted = new URL(input.value.trim());
    } catch {
      note.textContent = "That is not an address.";
      return;
    }
    if (!loopback.test(pasted.hostname) || Number(pasted.port) !== now.port || !(pasted.searchParams.has("code") || pasted.searchParams.has("error"))) {
      note.textContent = `Expected the address the sign-in tab ended on: http://127.0.0.1:${now.port}${now.path}?code=…`;
      return;
    }
    note.textContent = "Delivering…";
    host.endpoint(now.port).fetch(pasted.pathname + pasted.search, { headers: { host: pasted.host }, signal: AbortSignal.timeout(60000) }).then(async (response) => {
      const said = new DOMParser().parseFromString(await response.text(), "text/html").body.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "";
      log(`[page] sign-in callback delivered to the server's listener on port ${now.port}: HTTP ${response.status}${response.ok ? "" : ` (${said})`}`);
      if (pending === now)
        note.textContent = response.ok ? "Signed in." : `The server refused it (HTTP ${response.status}): ${said}`;
    }, (error) => {
      log(`[page] sign-in callback could not be delivered to port ${now.port}: ${error instanceof Error ? error.message : String(error)}`);
      if (pending === now)
        note.textContent = `Could not reach the server's listener: ${error instanceof Error ? error.message : String(error)}`;
    });
  });
  return ({ method, path, status: code, body }) => {
    const route = path.split("?")[0], ok = code >= 200 && code < 300;
    try {
      if (method === "POST" && start.test(route) && ok) {
        const data = body?.data;
        const redirect = data?.url && URL.canParse(data.url) ? new URL(data.url).searchParams.get("redirect_uri") : null;
        const to = redirect && URL.canParse(redirect) ? new URL(redirect) : undefined;
        if (data?.attemptID && to && to.protocol === "http:" && loopback.test(to.hostname)) {
          log(`[page] sign-in started; its redirect is the server's listener on port ${to.port}`);
          show({ attempt: data.attemptID, url: data.url, port: Number(to.port) || 80, path: to.pathname });
        }
      } else if (pending && status.exec(route)?.[1] === pending.attempt) {
        const state2 = method === "DELETE" ? "cancelled" : method === "GET" && ok ? body?.data : undefined;
        const over = typeof state2 === "string" ? state2 : state2?.status && state2.status !== "pending" ? `${state2.status}${state2.message ? `: ${state2.message}` : ""}` : undefined;
        if (over) {
          log(`[page] sign-in ${over}`);
          show(undefined, over.startsWith("failed") || over === "expired" ? over : undefined);
        }
      }
    } catch {}
  };
}

// src/main.ts
var here = new URL(".", document.baseURI).href;
var assets = new URL("display/", here).href;
var manifestUrl = new URL("editor/manifest.json", here).href;
var workerUrl = new URL("sw.js", here).href;
var builtModel = undefined;
var builtTunnel = undefined;
var isPublic = true;
var openAiKeys = "https://auth.openai.com/.well-known/jwks.json";
var tunnelled = isPublic ? ["chatgpt.com", "opencode.ai"] : ["api.openai.com", "chatgpt.com", "https://auth.openai.com/.well-known/", "opencode.ai"];
var params = new URLSearchParams(location.search);
var resetKey = "terminal-app-reset";
if (params.get("reset") === "1") {
  try {
    sessionStorage.setItem(resetKey, "1");
  } catch {}
  params.delete("reset");
  history.replaceState(null, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}
var mocked = params.get("mock") === "1";
var modelUrl = params.get("model") ?? (mocked ? new URL("mock/v1", here).href : undefined) ?? builtModel ?? (isPublic ? undefined : `${location.protocol}//${location.hostname}:4311/v1`);
var model = modelUrl ? { baseURL: modelUrl, id: params.get("modelId") ?? "scripted", apiKey: "not-a-key" } : undefined;
async function hostedModel() {
  const id = params.get("modelId") ?? "ling-3.1-flash-free";
  if (!id)
    return;
  const listed = await fetch("https://opencode.ai/zen/v1/models", { signal: AbortSignal.timeout(4000) }).then(async (response) => response.ok ? (await response.json()).data?.map((entry) => entry.id) : undefined, () => {
    return;
  });
  if (!listed || listed.includes(id))
    return id;
  log(`[page] OpenCode Zen no longer lists ${id}: leaving the choice of model to the server`);
  return;
}
var relayAddress = (given) => given && given !== "0" && /^wss?:$/.test(URL.parse(given)?.protocol ?? "") ? given : undefined;
var wispUrl = relayAddress(params.get("wisp")) ?? (params.get("wisp") === "0" || relayAddress(params.get("tunnel")) ? undefined : relayAddress("wss://wisp.mercurywork.shop/"));
var tunnelUrl = wispUrl ?? relayAddress(params.get("tunnel") ?? builtTunnel);
var tunnel = tunnelUrl ? { url: tunnelUrl, protocol: wispUrl ? "wisp" : "relay", to: tunnelled } : undefined;
var status2 = document.querySelector("#status");
var frame = document.querySelector("#app");
var logPane = document.querySelector("#log pre");
var diag = installDiag(params, isPublic ? null : builtModel && new URL("/diag", builtModel).href, false);
var say = (text2, error) => {
  status2.textContent = text2;
  status2.classList.toggle("error", error !== undefined);
  diag.event(error !== undefined ? "failed" : "stage", error ?? text2);
};
window.batTerminal = { log: [], model };
document.querySelector("#title").textContent = `OpenCode · ${model ? `model ${model.id} at ${new URL(model.baseURL).host}` : "free model from OpenCode Zen"}${tunnel ? ` · ${isPublic ? "relay" : "tunnel"} ${new URL(tunnel.url).host}` : ""}`;
{
  const cog = document.querySelector("#cog"), form = document.querySelector("#settings");
  const fields = ["wisp"];
  const defaults = { wisp: relayAddress("wss://wisp.mercurywork.shop/") ?? "" };
  const input = (name) => form.elements.namedItem(name);
  for (const name of fields) {
    input(name).value = params.get(name) ?? "";
    if (defaults[name])
      input(name).placeholder = defaults[name];
  }
  const show = (open) => {
    form.hidden = !open;
    cog.setAttribute("aria-expanded", String(open));
  };
  const reload = (change) => {
    const next = new URLSearchParams(location.search);
    next.delete("reset");
    change(next);
    location.search = next.toString();
  };
  cog.addEventListener("click", () => show(form.hidden));
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      show(false);
      cog.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!form.hidden && !form.contains(event.target) && !cog.contains(event.target))
      show(false);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    reload((next) => {
      for (const name of fields) {
        const value = input(name).value.trim();
        if (value)
          next.set(name, value);
        else
          next.delete(name);
      }
    });
  });
  input("reset").addEventListener("click", () => reload((next) => next.set("reset", "1")));
}
document.querySelector("#about").hidden = !isPublic || !!model;
var panel = installPanel2({
  startClosed: params.get("panel") === "closed",
  onOpen: () => window.batTerminal.terminal?.display.focus(),
  onChange: (open) => {
    diag.event("stage", `terminal panel ${open ? "opened" : "closed"}`);
  }
});
for (const type of ["keydown", "keyup"]) {
  window.addEventListener(type, (event) => {
    if (event.ctrlKey && event.key === "Tab")
      event.stopImmediatePropagation();
  }, true);
}
function log(line) {
  window.batTerminal.log.push(line);
  diag.event("log", line.slice(0, 600));
  if (window.batTerminal.log.length > 2000)
    window.batTerminal.log.shift();
  const pinned = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 4;
  logPane.append(line + `
`);
  if (pinned)
    logPane.scrollTop = logPane.scrollHeight;
}
async function pump(stream, line) {
  const reader = stream.getReader(), decoder = new TextDecoder;
  let rest = "";
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      rest += decoder.decode(value, { stream: !done });
      const lines = rest.split(`
`);
      rest = lines.pop();
      for (const text2 of lines)
        if (text2.trim())
          line(text2.slice(0, 2000));
      if (done)
        break;
    }
  } catch {}
}
function follow(name, process2, show) {
  if (show) {
    pump(process2.stdout, (text2) => log(`[${name}] ${text2}`));
    pump(process2.stderr, (text2) => log(`[${name} stderr] ${text2}`));
  }
  process2.exited.then((exit) => log(`[${name}] exited (code ${exit.code}, signal ${exit.signal ?? "none"})`));
}
async function main() {
  await isolate(workerUrl, here, (kind, data) => diag.event(kind, data));
  const displayUrl = assets + "display.js";
  const displayModule = import(displayUrl);
  displayModule.catch(() => {});
  const script = (name) => {
    const bytes = fetch(new URL(name, here)).then(async (response2) => {
      if (!response2.ok)
        throw Error(`${name} answered HTTP ${response2.status}`);
      return new Uint8Array(await response2.arrayBuffer());
    });
    bytes.catch(() => {});
    return bytes;
  };
  const hosted = model ? undefined : hostedModel();
  const tapScript = isPublic ? undefined : script("client-tap.js");
  say("Loading…");
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok)
    throw Error(`No prepared editor: ${manifestUrl} answered HTTP ${response.status}`);
  const manifest = await response.json();
  diag.event("stage", `manifest read: image ${manifest.image?.file} ${Math.round((manifest.image?.bytes ?? 0) / 1e6)} MB`);
  if (!manifest.launch.agent)
    throw Error("The prepared directory has no OpenCode server");
  const runtimeModule = await import(new URL(manifest.runtime?.entry ?? "runtime/host.js", manifestUrl).href);
  const startOver = async () => {
    await runtimeModule.resetWorkspace({ manifestUrl });
    try {
      localStorage.removeItem("todos");
    } catch {}
    for (const database of await indexedDB.databases())
      if (database.name)
        indexedDB.deleteDatabase(database.name);
  };
  if (sessionStorage.getItem(resetKey)) {
    sessionStorage.removeItem(resetKey);
    await startOver();
  }
  const { bootRuntime } = runtimeModule;
  diag.event("stage", "runtime module loaded");
  const kernelMiB = Number(params.get("kmem"));
  const bootExtras = { ...kernelMiB > 0 ? { kernelMemory: { pages: Math.round(kernelMiB * 16) } } : {}, ...diag.panel ? { trace: true } : {} };
  say("Opening the workspace in this browser…");
  const lifetime = new AbortController;
  const boot = () => bootRuntime({ manifestUrl, manifest, signal: lifetime.signal, serviceWorker: { url: workerUrl, scope: here }, ...bootExtras }).catch((error) => {
    throw error?.code === "STORAGE_BUSY" ? Error("This workspace is already open in another tab or window.") : error;
  });
  let runtime = await boot();
  diag.event("stage", "runtime booted: kernel up, image mounted, workspace restored");
  let source = await installSource(runtime.fs, manifest.project);
  const packageNote = "/workspace/.server/prepared-package.json";
  const packageNow = JSON.stringify(manifest.project["/package.json"] ?? "");
  if (source.preserved && await runtime.fs.readFile(packageNote).then((bytes) => new TextDecoder().decode(bytes), () => "") !== packageNow) {
    log("[page] the workspace in this browser is from a build with other dependencies: starting from a fresh one");
    await runtime.close();
    await startOver();
    runtime = await boot();
    source = await installSource(runtime.fs, manifest.project);
  }
  if (!source.preserved)
    await runtime.fs.writeFile(packageNote, new TextEncoder().encode(packageNow));
  window.batTerminal.runtime = runtime;
  window.addEventListener("pagehide", () => void window.batTerminal.runtime?.close().catch(() => {}));
  log(`[page] ${source.preserved ? "kept the workspace already in this browser" : `installed ${source.installed} source files`}`);
  await installDerived(runtime.fs, manifest, manifestUrl);
  const hostedId = await hosted;
  await installServerConfig(runtime.fs, model, hostedId);
  if (!runtime.spawnTerminal)
    throw Error("This runtime has no terminals (spawnTerminal)");
  if (!await runtime.fs.stat(clientEntry).then(() => true, () => false))
    throw Error(`The prepared image has no OpenCode client (${clientEntry}): build ports/opencode for Node and prepare again`);
  await installClient(runtime.fs, tapScript && { script: await tapScript, exchange: watchSignIn(() => window.batTerminal.runtime, log) });
  if (model)
    log(`[page] model endpoint: ${model.baseURL} (model ${model.id}), ${mocked && !params.get("model") ? "the scripted model in this page's service worker: nothing leaves the tab" : "fetched by this tab directly"}`);
  else
    log(`[page] model: OpenCode's hosted free models (opencode.ai/zen), no key, starting on ${hostedId ?? "the server's choice"}${tunnel ? "" : "; they need a relay (?wisp= or ?tunnel=) and there is none"}`);
  if (tunnel)
    log(`[page] tunnel: ${tunnel.to.join(", ")} through the ${tunnel.protocol === "wisp" ? "Wisp server" : "relay"} at ${new URL(tunnel.url).host}, with TLS in this tab`);
  say("Starting the app and the OpenCode server…");
  const preview = manifest.launch.preview, agent = manifest.launch.agent;
  const app = runtime.endpoint(preview.port), server2 = runtime.endpoint(agent.port);
  const password = crypto.randomUUID() + crypto.randomUUID();
  const authorization = "Basic " + btoa("opencode:" + password);
  const [appProcess, serverProcess] = await Promise.all([
    runtime.spawn(toLaunch(preview, { BROWSER_AGENT_PORT: String(preview.port), BROWSER_AGENT_BASE: new URL(app.url).pathname })),
    runtime.spawn(serverLaunch(agent, password, model, tunnel ? { tunnel } : isPublic ? {} : { fetchMap: { [openAiKeys]: new URL("openai-jwks.json", here).href } }))
  ]);
  follow("app", appProcess, diag.panel);
  follow("opencode", serverProcess, true);
  const appUp = app.ready(lifetime.signal).then(() => {
    frame.src = app.url;
    diag.event("stage", "the app's dev server listens: frame set");
  });
  frame.addEventListener("load", () => {
    if (frame.src) {
      diag.event("stage", "the app's frame loaded");
    }
  });
  const serverUp = server2.ready(lifetime.signal).then(() => serverHealthy(server2, authorization, lifetime.signal));
  Promise.allSettled([appUp, serverUp]).then(() => runtime.started?.());
  await serverUp;
  diag.event("stage", "OpenCode server healthy");
  let client;
  const display = await (await displayModule).mountDisplay({
    container: document.querySelector("#terminal"),
    wasmUrl: assets + "ghostty-vt.wasm",
    fontSize: 13,
    ctrlVPaste: true,
    onInput: (data) => client?.write(data),
    onResize: (size) => client?.resize(size)
  });
  const started = performance.now();
  const launch = clientLaunch(agent.port, password, !!tapScript);
  if (params.get("clientLog") === "debug")
    launch.env = { ...launch.env, OPENCODE_TUI_DEBUG: "1" };
  let first = true;
  client = await runtime.spawnTerminal(launch, { ...display.size(), onOutput: (data) => {
    if (first) {
      first = false;
      log(`[page] the client's first output came ${Math.round(performance.now() - started)} ms after its start`);
    }
    display.write(data);
  } });
  log(`[page] OpenCode client started on a terminal of the runtime (pid ${client.pid}, ${display.size().cols}x${display.size().rows})`);
  client.exited.then((exit) => {
    log(`[client] exited (code ${exit.code}, signal ${exit.signal ?? "none"}) after ${Math.round(performance.now() - started)} ms`);
    runtime.fs.readFile(clientLog).then((bytes) => {
      for (const line of new TextDecoder().decode(bytes).trim().split(`
`).slice(-20))
        if (line)
          log(`[client log] ${line.slice(0, 600)}`);
    }, () => {});
    display.write(`\r
\x1B[0m\x1B[2m[process ended: ${exit.signal ? `killed by ${exit.signal}` : `exit code ${exit.code}`}]\x1B[0m\r
`);
  });
  window.batTerminal.terminal = { display, client, screen: display.screen };
  status2.remove();
  diag.event("stage", "terminal mounted");
  diag.watchScreen(() => window.batTerminal.terminal.screen());
  if (!panel.open)
    document.activeElement?.blur();
  const auto = params.get("auto"), closeAfter = Number(params.get("closeAfter"));
  if (auto)
    setTimeout(() => {
      diag.event("stage", `?auto: typing "${auto.slice(0, 80)}"`);
      client.write(auto);
      setTimeout(() => client.write("\r"), 300);
    }, 3000);
  if (closeAfter > 0)
    setTimeout(() => panel.setOpen(false), closeAfter * 1000);
  await appUp;
}
main().catch((error) => {
  console.error(error);
  say(`Could not start: ${error instanceof Error ? error.message : String(error)}`, error ?? "unknown");
  panel.setOpen(true);
});
