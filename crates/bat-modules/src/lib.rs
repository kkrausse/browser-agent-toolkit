//! Module transform for the browser-hosted runtime: turns CommonJS, ES
//! modules, TypeScript, JSX and JSON into function bodies in the loader's
//! format, and reports the module facts the loader and the prepare tool need.
//!
//! The format is specified in `docs/design/module-format.md`. In short:
//!
//! * CommonJS: `function (exports, require, module, __filename, __dirname, __bat)`,
//!   source passed through except `import()` -> `__bat.import()`.
//! * ESM: `function* (__bat)` (`async function*` with top-level await). One
//!   prelude line defines live export getters, links dependencies and yields;
//!   the loader evaluates dependencies, then resumes the body. Imported names
//!   are read through the dependency's namespace object at each use.
//!
//! `transform` is a pure function of its arguments, does no I/O, and is safe
//! to call from many threads at once.

mod cjs;
mod edits;
mod esm;
pub mod facts;
mod lower;
mod map;

use std::borrow::Cow;
use std::cell::RefCell;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Program, Statement, VariableDeclarationKind};
use oxc_ecmascript::BoundNames;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;

pub use facts::{flags, Facts, ModuleKind};

/// The one identifier the format reserves (and the prefix of the locals the
/// ESM prelude declares: `__bat_i0`, `__bat_default`).
pub const CTX: &str = "__bat";

/// `"type"` of the nearest `package.json`, as read by the caller.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PackageType {
    /// No `type` field (or no package.json): decide by syntax, as Node does.
    #[default]
    None,
    CommonJs,
    Module,
}

/// tsconfig `jsx`. `preserve` cannot be executed; callers map it to `Automatic`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum JsxMode {
    /// `react-jsx`: `import { jsx } from "<jsxImportSource>/jsx-runtime"`.
    #[default]
    Automatic,
    /// `react-jsxdev`: `jsxDEV` from `<jsxImportSource>/jsx-dev-runtime`.
    AutomaticDev,
    /// `react`: `jsxFactory(...)` / `jsxFragmentFactory`.
    Classic,
}

/// The tsconfig options that change emitted code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TsOptions {
    pub jsx: JsxMode,
    /// Default `react`.
    pub jsx_import_source: Option<String>,
    /// Default `React.createElement`.
    pub jsx_factory: Option<String>,
    /// Default `React.Fragment`.
    pub jsx_fragment_factory: Option<String>,
    /// Keep imports that are never used as values (only `import type` goes).
    pub verbatim_module_syntax: bool,
    /// Legacy (`experimentalDecorators`) decorators. Standard decorators are
    /// left in the output untouched.
    pub experimental_decorators: bool,
    pub emit_decorator_metadata: bool,
    /// Default true. False gives assignment semantics for class fields.
    pub use_define_for_class_fields: bool,
}

impl Default for TsOptions {
    fn default() -> Self {
        TsOptions {
            jsx: JsxMode::Automatic,
            jsx_import_source: None,
            jsx_factory: None,
            jsx_fragment_factory: None,
            verbatim_module_syntax: false,
            experimental_decorators: false,
            emit_decorator_metadata: false,
            use_define_for_class_fields: true,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    /// Used only for `.js`, `.jsx`, `.ts`, `.tsx`.
    pub package_type: PackageType,
    /// Overrides extension, package type and detection.
    pub force_kind: Option<ModuleKind>,
    /// Produce a source map when the output's lines differ from the source's
    /// (TypeScript/JSX). Plain JavaScript keeps its lines and gets no map.
    pub source_map: bool,
    pub ts: TsOptions,
    /// What `import(...)` is rewritten to. Default `__bat.import`. Set it to a
    /// global hook when transforming code that runs outside a module function
    /// (`new Function`, `vm`, `eval`).
    pub dynamic_import: Option<String>,
    /// Wrap every `await x` as `__bat_u(await __bat_w(x))`. The two globals are
    /// the runtime's hooks for carrying async context (AsyncLocalStorage)
    /// across `await`, which no browser API exposes: `__bat_w` may capture the
    /// current context with the awaited value, `__bat_u` restores it when the
    /// function resumes. With both as identity functions the code behaves
    /// exactly as before. Off by default.
    pub async_context: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub severity: Severity,
    pub message: String,
    /// Byte offsets into the source given to `transform`.
    pub start: u32,
    pub end: u32,
    /// 1-based line and column (in bytes) of `start`; 0 when unknown.
    pub line: u32,
    pub column: u32,
}

impl Diagnostic {
    pub(crate) fn error(message: impl Into<String>, start: u32, end: u32) -> Diagnostic {
        Diagnostic { severity: Severity::Error, message: message.into(), start, end, line: 0, column: 0 }
    }

    pub(crate) fn warning(message: impl Into<String>, start: u32, end: u32) -> Diagnostic {
        Diagnostic { severity: Severity::Warning, ..Diagnostic::error(message, start, end) }
    }
}

/// Decorators that survived lowering: only legacy (`experimentalDecorators`)
/// decorators can be compiled; standard ones are passed through and current
/// engines reject them.
pub(crate) fn standard_decorator_warning(start: u32, end: u32) -> Diagnostic {
    Diagnostic::warning(
        "standard decorators are not lowered (only `experimentalDecorators` are); the output keeps them and will not parse in engines without decorator support",
        start,
        end,
    )
}

pub(crate) fn push_oxc(
    out: &mut Vec<Diagnostic>,
    _source: &str,
    diagnostic: oxc_diagnostics::OxcDiagnostic,
) {
    let (start, end) = diagnostic
        .labels
        .iter()
        .next()
        .map(|label| (label.offset(), label.offset() + label.len()))
        .unwrap_or((0, 0));
    let severity = match diagnostic.severity {
        oxc_diagnostics::Severity::Error => Severity::Error,
        _ => Severity::Warning,
    };
    let mut message = diagnostic.message.to_string();
    if let Some(help) = &diagnostic.help {
        message.push_str(" (");
        message.push_str(help);
        message.push(')');
    }
    out.push(Diagnostic { severity, message, start, end, line: 0, column: 0 });
}

#[derive(Debug)]
pub struct Output<'s> {
    /// The function body. Borrowed from the source when nothing changed.
    /// Empty when `ok()` is false.
    pub code: Cow<'s, str>,
    pub facts: Facts,
    /// Source map (JSON, version 3) when requested and lines changed.
    pub map: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
}

impl Output<'_> {
    /// No error diagnostics: `code` and `facts` are usable.
    pub fn ok(&self) -> bool {
        !self.diagnostics.iter().any(|d| d.severity == Severity::Error)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lang {
    Js,
    Jsx,
    Ts,
    Tsx,
    Json,
}

/// Module kind hint from the extension and package type; `None` = ambiguous.
fn classify(filename: &str, options: &Options) -> (Lang, Option<ModuleKind>) {
    let ext = filename.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let ext = if ext.contains('/') { "" } else { ext };
    let by_package = match options.package_type {
        PackageType::Module => Some(ModuleKind::Esm),
        PackageType::CommonJs => Some(ModuleKind::CommonJs),
        PackageType::None => None,
    };
    let (lang, kind) = match ext {
        "mjs" => (Lang::Js, Some(ModuleKind::Esm)),
        "cjs" => (Lang::Js, Some(ModuleKind::CommonJs)),
        "jsx" => (Lang::Jsx, by_package),
        "ts" => (Lang::Ts, by_package),
        "mts" => (Lang::Ts, Some(ModuleKind::Esm)),
        "cts" => (Lang::Ts, Some(ModuleKind::CommonJs)),
        "tsx" => (Lang::Tsx, by_package),
        "json" => (Lang::Json, Some(ModuleKind::Json)),
        _ => (Lang::Js, by_package),
    };
    (lang, options.force_kind.filter(|k| *k != ModuleKind::Unknown).or(kind))
}

thread_local! {
    static ALLOCATOR: RefCell<Allocator> = RefCell::new(Allocator::default());
}

/// Sources above this size get their own arena, freed on return, instead of
/// growing the thread's reusable one for good.
const BIG_SOURCE: usize = 2 << 20;

/// Transform one file. `filename` is used for the extension, diagnostics and
/// the source map; nothing is read from disk.
pub fn transform<'s>(source: &'s str, filename: &str, options: &Options) -> Output<'s> {
    let mut output = if source.len() > BIG_SOURCE {
        let allocator = Allocator::default();
        transform_in(&allocator, source, filename, options)
    } else {
        ALLOCATOR.with(|cell| match cell.try_borrow_mut() {
            Ok(mut allocator) => {
                allocator.reset();
                transform_in(&allocator, source, filename, options)
            }
            Err(_) => transform_in(&Allocator::default(), source, filename, options),
        })
    };
    if !output.diagnostics.is_empty() {
        for d in &mut output.diagnostics {
            let (line, column) = line_column(source, d.start);
            d.line = line;
            d.column = column;
        }
        if !output.ok() {
            output.code = Cow::Borrowed("");
            output.map = None;
        }
    }
    output
}

fn line_column(source: &str, offset: u32) -> (u32, u32) {
    let offset = (offset as usize).min(source.len());
    let before = &source.as_bytes()[..offset];
    let line = before.iter().filter(|b| **b == b'\n').count() as u32 + 1;
    let column = (offset - before.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1)) as u32 + 1;
    (line, column)
}

fn transform_in<'s>(
    allocator: &Allocator,
    source: &'s str,
    filename: &str,
    options: &Options,
) -> Output<'s> {
    // A UTF-8 byte order mark stays where it is: U+FEFF is white space in
    // JavaScript, also inside a function body, and keeping it keeps offsets
    // (and "code is source") exact. Only JSON has to drop it.
    let mut diagnostics = Vec::new();
    let (lang, hint) = classify(filename, options);

    if lang == Lang::Json {
        return json(source);
    }

    let dynamic_import = options.dynamic_import.as_deref().unwrap_or("__bat.import");

    // TypeScript / JSX: lower to JavaScript text first.
    let lowered = if lang != Lang::Js {
        let mut source_type = match hint {
            Some(ModuleKind::Esm) => SourceType::mjs(),
            Some(ModuleKind::CommonJs) => SourceType::cjs(),
            _ => SourceType::unambiguous(),
        };
        source_type = source_type
            .with_typescript(matches!(lang, Lang::Ts | Lang::Tsx))
            .with_jsx(matches!(lang, Lang::Jsx | Lang::Tsx));
        match lower::lower(
            allocator,
            source,
            filename,
            source_type,
            &options.ts,
            options.source_map,
            &mut diagnostics,
        ) {
            Some(lowered) => Some(lowered),
            None => {
                return Output {
                    code: Cow::Borrowed(""),
                    facts: Facts::default(),
                    map: None,
                    diagnostics,
                }
            }
        }
    } else {
        None
    };
    let (js, lowered_map): (&str, _) = match &lowered {
        Some(l) => (l.code.as_str(), l.map.as_ref()),
        None => (source, None),
    };
    let want_applied = lowered_map.is_some();

    let Some((program, kind)) = parse_js(allocator, js, hint, lowered.is_some(), &mut diagnostics)
    else {
        return Output { code: Cow::Borrowed(""), facts: Facts::default(), map: None, diagnostics };
    };
    // The arena outlives this function body's borrows of `program`.
    let program: &Program = allocator.alloc(program);

    let (code, mut facts, applied, prelude_len): (Option<String>, Facts, _, u32) = match kind {
        ModuleKind::Esm => {
            let out = esm::transform_esm(program, js, want_applied, dynamic_import, options.async_context, &mut diagnostics);
            (Some(out.code), out.facts, out.applied, out.prelude_len)
        }
        _ => {
            let out = cjs::transform_cjs(program, js, want_applied, dynamic_import, options.async_context, &mut diagnostics);
            (out.code, out.facts, out.applied, 0)
        }
    };

    let mut map = None;
    if let Some(lowered) = lowered {
        facts.flags |= flags::LOWERED;
        facts.flags &= !flags::CODE_IS_SOURCE;
        if let Some(lowered_map) = &lowered.map {
            map = Some(map::adjust(lowered_map, &lowered.code, &applied, prelude_len));
        }
        // Diagnostics from the second pass point into the lowered text.
        let code = code.unwrap_or(lowered.code);
        return Output { code: Cow::Owned(code), facts, map, diagnostics };
    }

    let code = match code {
        Some(code) => Cow::Owned(code),
        None => Cow::Borrowed(source),
    };
    Output { code, facts, map, diagnostics }
}

/// Parse JavaScript and settle the module kind the way Node does: explicit
/// kind first; otherwise CommonJS unless the file has `import`/`export`/
/// `import.meta`, or only parses as a module (top-level await, or a lexical
/// redeclaration of a CommonJS wrapper variable).
fn parse_js<'a>(
    allocator: &'a Allocator,
    js: &'a str,
    hint: Option<ModuleKind>,
    lowered: bool,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<(Program<'a>, ModuleKind)> {
    let parse = |source_type: SourceType| {
        Parser::new(allocator, js, source_type)
            .with_options(ParseOptions {
                allow_return_outside_function: !source_type.is_module(),
                ..ParseOptions::default()
            })
            .parse()
    };
    let source_type = match hint {
        Some(ModuleKind::Esm) => SourceType::mjs(),
        Some(ModuleKind::CommonJs) => SourceType::cjs(),
        _ => SourceType::unambiguous(),
    };
    let mut parsed = parse(source_type);
    let mut failed = parsed.fatal_error || parsed.diagnostics.has_errors();
    let mut kind = if parsed.program.source_type.is_module() || parsed.module_record.has_module_syntax {
        ModuleKind::Esm
    } else {
        ModuleKind::CommonJs
    };

    if hint == Some(ModuleKind::CommonJs) && failed {
        // A file the package calls CommonJS but that is written as a module
        // (common for TypeScript sources and for packages without `type`
        // shipping ESM to bundlers). Node would refuse; load it as ESM.
        let retry = parse(SourceType::mjs());
        let retry_ok = !(retry.fatal_error || retry.diagnostics.has_errors());
        // The TypeScript transform leaves `export {}` behind when it removes
        // type-only imports; that alone does not make a `.cts` file a module.
        let only_empty_exports = lowered
            && retry.program.body.iter().all(|stmt| match stmt {
                Statement::ExportNamedDeclaration(d) => d.specifiers.is_empty(),
                Statement::ImportDeclaration(_)
                | Statement::ExportAllDeclaration(_)
                | Statement::ExportDefaultDeclaration(_)
                | Statement::ExportDeclaration(_)
                | Statement::ExportFromDeclaration(_) => false,
                _ => true,
            })
            && retry.module_record.import_metas.is_empty();
        if retry_ok && only_empty_exports {
            parsed = retry;
            failed = false;
            kind = ModuleKind::CommonJs;
        } else if retry_ok && retry.module_record.has_module_syntax {
            diagnostics.push(Diagnostic::warning(
                "file is CommonJS by extension or package type but uses ES module syntax; treated as an ES module",
                0,
                0,
            ));
            parsed = retry;
            failed = false;
            kind = ModuleKind::Esm;
        }
    } else if hint.is_none() && kind == ModuleKind::CommonJs {
        if failed {
            let retry = parse(SourceType::mjs());
            if !(retry.fatal_error || retry.diagnostics.has_errors()) {
                parsed = retry;
                failed = false;
                kind = ModuleKind::Esm;
            }
        } else if redeclares_wrapper_variable(&parsed.program) {
            kind = ModuleKind::Esm;
        }
    }

    if failed {
        for d in parsed.diagnostics.into_vec() {
            let before = diagnostics.len();
            push_oxc(diagnostics, js, d);
            if lowered {
                // Offsets are into generated text, not the user's source.
                for d in &mut diagnostics[before..] {
                    d.message.push_str(" (in lowered output)");
                    d.start = 0;
                    d.end = 0;
                }
            }
        }
        if !diagnostics.iter().any(|d| d.severity == Severity::Error) {
            diagnostics.push(Diagnostic::error("source could not be parsed", 0, 0));
        }
        return None;
    }
    Some((parsed.program, kind))
}

/// `const require = …`, `let module`, `class exports {}` at the top level: a
/// syntax error inside the CommonJS wrapper, so Node treats the file as ESM.
fn redeclares_wrapper_variable(program: &Program) -> bool {
    let mut found = false;
    let mut check = |name: &str| {
        if matches!(name, "require" | "module" | "exports" | "__filename" | "__dirname") {
            found = true;
        }
    };
    for stmt in &program.body {
        match stmt {
            Statement::VariableDeclaration(decl) if decl.kind != VariableDeclarationKind::Var => {
                decl.bound_names(&mut |id| check(id.name.as_str()));
            }
            Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    check(id.name.as_str());
                }
            }
            _ => {}
        }
    }
    found
}

fn json(source: &str) -> Output<'_> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut code = String::with_capacity(source.len() + 32);
    code.push_str("module.exports=JSON.parse(");
    esm::push_js_string(&mut code, source);
    code.push_str(");");
    Output {
        code: Cow::Owned(code),
        facts: Facts { kind: ModuleKind::Json, ..Facts::default() },
        map: None,
        diagnostics: Vec::new(),
    }
}

/// `await x` -> `__bat_u(await __bat_w(x))` (see [`Options::async_context`]).
/// Three insertions, so the operand keeps its text, lines and inner edits.
pub(crate) fn await_hooks(edits: &mut edits::Edits, it: &oxc_ast::ast::AwaitExpression) {
    use oxc_span::GetSpan;
    edits.insert(it.span.start, "__bat_u(");
    edits.insert(it.argument.span().start, "__bat_w(");
    edits.insert(it.span.end, "))");
}
