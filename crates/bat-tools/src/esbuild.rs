//! esbuild's `transform` for JavaScript and TypeScript, on oxc.
//!
//! What it does: parse, strip TypeScript, lower JSX, replace `define`d globals,
//! optionally rewrite import specifiers, print (optionally without whitespace)
//! with a source map. What it never does: downlevel JavaScript syntax (the
//! guest's code runs in current Chrome), rename identifiers, fold or remove
//! code. Anything else esbuild can do is refused with `needs_fallback` so the
//! caller can hand the call to the real esbuild.

use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Decorator, ExportAllDeclaration, ExportFromDeclaration, Expression,
    ImportDeclaration, ImportExpression, StringLiteral, TSImportEqualsDeclaration,
};
use oxc_ast_visit::{walk_mut, VisitMut};
use oxc_codegen::{Codegen, CodegenOptions, CommentOptions, LegalComment};
use oxc_diagnostics::OxcDiagnostic;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{ClassPropertiesOptions, JsxRuntime, TransformOptions, Transformer};
use oxc_transformer_plugins::{ReplaceGlobalDefines, ReplaceGlobalDefinesConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Loader {
    #[default]
    Js,
    Jsx,
    Ts,
    Tsx,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Jsx {
    /// esbuild `jsx: "transform"`: `React.createElement` or the given factory.
    #[default]
    Classic,
    /// esbuild `jsx: "automatic"`.
    Automatic,
    /// esbuild `jsx: "preserve"`.
    Preserve,
}

#[derive(Debug, Clone, Default)]
pub struct Options {
    pub loader: Loader,
    /// Name recorded in the source map and in JSX development metadata.
    pub sourcefile: String,
    pub source_map: bool,
    pub sources_content: bool,
    pub jsx: Jsx,
    pub jsx_dev: bool,
    pub jsx_factory: Option<String>,
    pub jsx_fragment: Option<String>,
    pub jsx_import_source: Option<String>,
    /// TypeScript `verbatimModuleSyntax` / `preserveValueImports`: imports that
    /// are not `import type` stay even when unused.
    pub keep_unused_imports: bool,
    pub experimental_decorators: bool,
    /// TypeScript `useDefineForClassFields: false` (TypeScript loaders only).
    pub assign_class_fields: bool,
    pub minify_whitespace: bool,
    /// esbuild `charset` other than `utf8`: escape non-ASCII characters.
    pub ascii_only: bool,
    /// Keep `/*! ... */` and `@license` comments (esbuild `legalComments: "inline"`).
    pub legal_comments: bool,
    /// `(global expression, replacement expression)` as esbuild's `define`.
    pub define: Vec<(String, String)>,
    /// `(specifier, replacement)`: applied to static imports, re-exports,
    /// `import("…")` and `require("…")` after TypeScript and JSX lowering.
    pub rewrite_imports: Vec<(String, String)>,
    /// Report the module's imports (after lowering) in `Output::imports`.
    pub collect_imports: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
    ImportStatement,
    DynamicImport,
    RequireCall,
}

#[derive(Debug, Clone)]
pub struct Import {
    pub kind: ImportKind,
    pub specifier: String,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub error: bool,
    pub text: String,
    /// 1-based line, 0-based column and length in UTF-16 code units; line 0 = no location.
    pub line: u32,
    pub column: u32,
    pub length: u32,
}

#[derive(Debug, Default)]
pub struct Output {
    pub code: String,
    pub map: Option<String>,
    pub messages: Vec<Message>,
    pub imports: Vec<Import>,
    /// Set when the input needs something this transform does not do
    /// (decorators, a helper oxc would import from a runtime package).
    /// `code` is then empty and the caller must use the real esbuild.
    pub needs_fallback: Option<&'static str>,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.needs_fallback.is_none() && !self.messages.iter().any(|m| m.error)
    }
}

fn locate(source: &str, offset: usize, len: usize) -> (u32, u32, u32) {
    let offset = offset.min(source.len());
    let before = &source[..offset];
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let line = before.bytes().filter(|b| *b == b'\n').count() as u32 + 1;
    let column = source[line_start..offset].encode_utf16().count() as u32;
    let end = (offset + len).min(source.len());
    let end = (offset..=end).rev().find(|i| source.is_char_boundary(*i)).unwrap_or(offset);
    let length = source[offset..end].split('\n').next().unwrap_or("").encode_utf16().count() as u32;
    (line, column, length)
}

fn push(messages: &mut Vec<Message>, source: &str, diagnostic: OxcDiagnostic) {
    let error = matches!(diagnostic.severity, oxc_diagnostics::Severity::Error);
    let mut text = diagnostic.message.to_string();
    if let Some(help) = &diagnostic.help {
        text.push_str(" (");
        text.push_str(help);
        text.push(')');
    }
    let (line, column, length) = match diagnostic.labels.iter().next() {
        Some(label) => locate(source, label.offset() as usize, label.len() as usize),
        None => (0, 0, 0),
    };
    messages.push(Message { error, text, line, column, length });
}

fn transform_options(options: &Options) -> TransformOptions {
    let mut out = TransformOptions::default();
    out.typescript.only_remove_type_imports = options.keep_unused_imports;
    match options.jsx {
        Jsx::Preserve => out.jsx.jsx_plugin = false,
        Jsx::Classic => {
            out.jsx.runtime = JsxRuntime::Classic;
            if let Some(factory) = &options.jsx_factory {
                out.jsx.pragma = Some(factory.clone());
                out.typescript.jsx_pragma = factory.clone().into();
            }
            if let Some(fragment) = &options.jsx_fragment {
                out.jsx.pragma_frag = Some(fragment.clone());
                out.typescript.jsx_pragma_frag = fragment.clone().into();
            }
        }
        Jsx::Automatic => {
            out.jsx.runtime = JsxRuntime::Automatic;
            out.jsx.development = options.jsx_dev;
            if let Some(source) = &options.jsx_import_source {
                out.jsx.import_source = Some(source.clone());
            }
        }
    }
    // esbuild adds neither `__self`/`__source` props (classic) nor display names.
    out.jsx.jsx_self_plugin = false;
    out.jsx.jsx_source_plugin = false;
    out.jsx.display_name_plugin = false;
    out.decorator.legacy = options.experimental_decorators;
    if options.assign_class_fields && matches!(options.loader, Loader::Ts | Loader::Tsx) {
        out.assumptions.set_public_class_fields = true;
        out.typescript.remove_class_fields_without_initializer = true;
        out.env.es2022.class_properties = Some(ClassPropertiesOptions::default());
    }
    out
}

/// Finds decorators (not lowered here), collects imports and rewrites specifiers.
struct Specifiers<'o> {
    rewrite: &'o [(String, String)],
    collect: bool,
    imports: Vec<Import>,
    decorators: bool,
    import_equals: bool,
}

impl Specifiers<'_> {
    fn literal<'a>(&mut self, literal: &mut StringLiteral<'a>, kind: ImportKind, allocator: &'a Allocator) {
        let value = literal.value.as_str();
        if let Some((_, to)) = self.rewrite.iter().find(|(from, _)| from == value) {
            literal.value = allocator.alloc_str(to).into();
            literal.raw = None;
        }
        if self.collect {
            self.imports.push(Import { kind, specifier: literal.value.as_str().to_owned() });
        }
    }
}

struct SpecifierVisitor<'a, 'o> {
    allocator: &'a Allocator,
    state: Specifiers<'o>,
}

impl<'a> VisitMut<'a> for SpecifierVisitor<'a, '_> {
    fn visit_decorator(&mut self, it: &mut Decorator<'a>) {
        self.state.decorators = true;
        walk_mut::walk_decorator(self, it);
    }

    fn visit_ts_import_equals_declaration(&mut self, it: &mut TSImportEqualsDeclaration<'a>) {
        self.state.import_equals = true;
        walk_mut::walk_ts_import_equals_declaration(self, it);
    }

    fn visit_import_declaration(&mut self, it: &mut ImportDeclaration<'a>) {
        self.state.literal(&mut it.source, ImportKind::ImportStatement, self.allocator);
    }

    fn visit_export_all_declaration(&mut self, it: &mut ExportAllDeclaration<'a>) {
        self.state.literal(&mut it.source, ImportKind::ImportStatement, self.allocator);
    }

    fn visit_export_from_declaration(&mut self, it: &mut ExportFromDeclaration<'a>) {
        self.state.literal(&mut it.source, ImportKind::ImportStatement, self.allocator);
    }

    fn visit_import_expression(&mut self, it: &mut ImportExpression<'a>) {
        if let Expression::StringLiteral(literal) = &mut it.source {
            self.state.literal(literal, ImportKind::DynamicImport, self.allocator);
        }
        walk_mut::walk_import_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &mut CallExpression<'a>) {
        if it.arguments.len() == 1 && matches!(&it.callee, Expression::Identifier(id) if id.name == "require") {
            if let Some(Argument::StringLiteral(literal)) = it.arguments.first_mut() {
                self.state.literal(literal, ImportKind::RequireCall, self.allocator);
            }
        }
        walk_mut::walk_call_expression(self, it);
    }
}

pub fn transform(source: &str, options: &Options) -> Output {
    let mut out = Output::default();
    let allocator = Allocator::default();
    let filename = if options.sourcefile.is_empty() { "<stdin>" } else { options.sourcefile.as_str() };

    // esbuild decides between module and script by content; TypeScript and JSX
    // dialects are chosen by the loader alone, never by the file name.
    let source_type = match options.loader {
        Loader::Js => SourceType::unambiguous(),
        Loader::Jsx => SourceType::unambiguous().with_jsx(true),
        Loader::Ts => SourceType::ts(),
        Loader::Tsx => SourceType::tsx(),
    };
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions { allow_return_outside_function: true, ..ParseOptions::default() })
        .parse();
    let failed = parsed.fatal_error || parsed.diagnostics.has_errors();
    for diagnostic in parsed.diagnostics.into_vec() {
        push(&mut out.messages, source, diagnostic);
    }
    if failed {
        return out;
    }
    let mut program = parsed.program;

    // Decorators: esbuild lowers both kinds inline; oxc lowers only the legacy
    // kind and through imported helpers.
    let mut visitor = SpecifierVisitor {
        allocator: &allocator,
        state: Specifiers { rewrite: &[], collect: false, imports: Vec::new(), decorators: false, import_equals: false },
    };
    visitor.visit_program(&mut program);
    if visitor.state.decorators {
        out.needs_fallback = Some("decorators");
        return out;
    }
    if visitor.state.import_equals {
        out.needs_fallback = Some("import = require()");
        return out;
    }

    let semantic = SemanticBuilder::new().with_excess_capacity(2.0).build(&program);
    let mut scoping = semantic.semantic.into_scoping();

    let transform_options = transform_options(options);
    let ret = Transformer::new(&allocator, Path::new(filename), &transform_options).build_with_scoping(scoping, &mut program);
    let failed = ret.diagnostics.has_errors();
    for diagnostic in ret.diagnostics.into_vec() {
        push(&mut out.messages, source, diagnostic);
    }
    if failed {
        return out;
    }
    #[allow(deprecated)]
    if !ret.helpers_used.is_empty() {
        // The helper would be an import of `@oxc-project/runtime/helpers/*`.
        out.needs_fallback = Some("runtime helper");
        return out;
    }
    scoping = ret.scoping;

    if !options.define.is_empty() {
        match ReplaceGlobalDefinesConfig::new(&options.define) {
            Ok(config) => {
                let _ = ReplaceGlobalDefines::new(&allocator, config).build(scoping, &mut program);
            }
            Err(errors) => {
                for diagnostic in errors.into_vec() {
                    let mut message = Message { error: true, text: diagnostic.message.to_string(), line: 0, column: 0, length: 0 };
                    message.text.insert_str(0, "Invalid define value: ");
                    out.messages.push(message);
                }
                return out;
            }
        }
    }

    if options.collect_imports || !options.rewrite_imports.is_empty() {
        let mut visitor = SpecifierVisitor {
            allocator: &allocator,
            state: Specifiers {
                rewrite: &options.rewrite_imports,
                collect: options.collect_imports,
                imports: Vec::new(),
                decorators: false,
                import_equals: false,
            },
        };
        visitor.visit_program(&mut program);
        out.imports = visitor.state.imports;
    }

    let printed = Codegen::new()
        .with_options(CodegenOptions {
            minify: options.minify_whitespace,
            ascii_only: options.ascii_only,
            comments: CommentOptions {
                normal: !options.minify_whitespace,
                jsdoc: !options.minify_whitespace,
                annotation: true,
                legal: if options.legal_comments { LegalComment::Inline } else { LegalComment::None },
            },
            source_map_path: options.source_map.then(|| PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .with_source_text(source)
        .build(&program);
    out.code = printed.code;
    if let Some(mut map) = printed.map {
        if !options.sources_content {
            map.set_source_contents(vec![None]);
        }
        out.map = Some(map.to_json_string());
    }
    out
}
