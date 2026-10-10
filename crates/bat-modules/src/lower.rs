//! TypeScript and JSX lowering with oxc's transformer and codegen. Types are
//! stripped, JSX becomes calls; modern JavaScript syntax is left alone (the
//! target is current Chrome). The result is plain JavaScript that then goes
//! through the same ESM/CJS pass as any `.js` file.

use std::path::{Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_ast::ast::Statement;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{
    ClassPropertiesOptions, JsxRuntime, TransformOptions, Transformer,
};

use crate::{push_oxc, Diagnostic, JsxMode, TsOptions};

pub(crate) struct Lowered {
    pub code: String,
    pub map: Option<oxc_sourcemap::SourceMap<'static>>,
}

fn transform_options(ts: &TsOptions) -> TransformOptions {
    let mut options = TransformOptions::default();
    options.typescript.only_remove_type_imports = ts.verbatim_module_syntax;
    options.jsx.runtime = match ts.jsx {
        JsxMode::Classic => JsxRuntime::Classic,
        JsxMode::Automatic | JsxMode::AutomaticDev => JsxRuntime::Automatic,
    };
    options.jsx.development = ts.jsx == JsxMode::AutomaticDev;
    // `__self`/`__source` only make sense for React's own dev transform.
    options.jsx.jsx_self_plugin = false;
    options.jsx.jsx_source_plugin = false;
    if ts.jsx == JsxMode::Classic {
        if let Some(factory) = &ts.jsx_factory {
            options.jsx.pragma = Some(factory.clone());
            options.typescript.jsx_pragma = factory.clone().into();
        }
        if let Some(fragment) = &ts.jsx_fragment_factory {
            options.jsx.pragma_frag = Some(fragment.clone());
            options.typescript.jsx_pragma_frag = fragment.clone().into();
        }
    } else if let Some(source) = &ts.jsx_import_source {
        options.jsx.import_source = Some(source.clone());
    }
    options.decorator.legacy = ts.experimental_decorators;
    options.decorator.emit_decorator_metadata =
        ts.experimental_decorators && ts.emit_decorator_metadata;
    if !ts.use_define_for_class_fields {
        // TypeScript's `useDefineForClassFields: false`: fields are assigned in
        // the constructor, and fields without an initializer do not exist.
        options.assumptions.set_public_class_fields = true;
        options.typescript.remove_class_fields_without_initializer = true;
        options.env.es2022.class_properties = Some(ClassPropertiesOptions::default());
    }
    options
}

pub(crate) fn lower(
    allocator: &Allocator,
    source: &str,
    filename: &str,
    source_type: SourceType,
    ts: &TsOptions,
    want_map: bool,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<Lowered> {
    let parse = |source_type: SourceType| {
        Parser::new(allocator, source, source_type)
            .with_options(ParseOptions {
                allow_return_outside_function: !source_type.is_module(),
                ..ParseOptions::default()
            })
            .parse()
    };
    let mut parsed = parse(source_type);
    // `import x = require()` and `export =` are CommonJS; only real
    // import/export statements or `import.meta` make the file a module.
    let esm_syntax = !parsed.module_record.import_metas.is_empty()
        || parsed.program.body.iter().any(|stmt| match stmt {
            // Type-only statements vanish; they do not decide the module kind.
            Statement::ImportDeclaration(d) => !d.import_kind.is_type(),
            Statement::ExportAllDeclaration(d) => !d.export_kind.is_type(),
            Statement::ExportNamedDeclaration(d) => !d.export_kind.is_type(),
            Statement::ExportFromDeclaration(d) => !d.export_kind.is_type(),
            Statement::ExportDeclaration(d) => !d.declaration.is_typescript_syntax(),
            Statement::ExportDefaultDeclaration(d) => !d.is_typescript_syntax(),
            _ => false,
        });
    if source_type.is_commonjs() && esm_syntax {
        // CommonJS by extension or package type, but written with
        // import/export: the next pass will treat it as an ES module, so lower
        // it as one (otherwise the JSX runtime would arrive through `require`).
        parsed = parse(source_type.with_module(true));
    }
    let failed = parsed.fatal_error || parsed.diagnostics.has_errors();
    for d in parsed.diagnostics.into_vec() {
        push_oxc(diagnostics, source, d);
    }
    if failed {
        return None;
    }
    let mut program = parsed.program;

    let semantic = SemanticBuilder::new().with_excess_capacity(2.0).build(&program);
    let scoping = semantic.semantic.into_scoping();

    let options = transform_options(ts);
    let ret = Transformer::new(allocator, Path::new(filename), &options)
        .build_with_scoping(scoping, &mut program);
    let failed = ret.diagnostics.has_errors();
    for d in ret.diagnostics.into_vec() {
        push_oxc(diagnostics, source, d);
    }
    if failed {
        return None;
    }

    let out = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: want_map.then(|| PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .build(&program);
    Some(Lowered { code: out.code, map: out.map.map(|m| m.into_owned()) })
}
