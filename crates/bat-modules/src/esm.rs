//! ES module -> generator function body. See `docs/design/module-format.md`.
//!
//! Every decision is made on the AST with resolved scopes (so a local that
//! shadows an import is never rewritten); the output is the original text with
//! spans replaced, plus a one-line prelude.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};
use oxc_ecmascript::BoundNames;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::GetSpan;
use oxc_syntax::scope::ScopeFlags;

use crate::edits::Edits;
use crate::facts::{flags, Facts, ModuleKind, NameSet};
use crate::{Diagnostic, CTX};

pub(crate) struct EsmOutput {
    pub code: String,
    pub facts: Facts,
    /// `(start, end, replacement_len)` in input offsets, when requested.
    pub applied: Vec<(u32, u32, u32)>,
    pub prelude_len: u32,
}

/// One imported local name: where its value lives.
struct Binding {
    /// Text that reads the binding: `__bat_i0.name`, `__bat_i0["a-b"]` or `__bat_i0`.
    access: String,
}

pub(crate) fn is_identifier_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if oxc_syntax::identifier::is_identifier_start(c) => {}
        _ => return false,
    }
    chars.all(oxc_syntax::identifier::is_identifier_part)
}

/// Append `name` as a double-quoted JS string literal.
pub(crate) fn push_js_string(out: &mut String, name: &str) {
    out.push('"');
    for c in name.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn push_member(out: &mut String, object: &str, name: &str) {
    out.push_str(object);
    if is_identifier_name(name) {
        out.push('.');
        out.push_str(name);
    } else {
        out.push('[');
        push_js_string(out, name);
        out.push(']');
    }
}

fn push_key(out: &mut String, name: &str) {
    if name == "__proto__" {
        // `{__proto__: v}` would set the literal's prototype.
        out.push_str("[\"__proto__\"]");
    } else if is_identifier_name(name) {
        out.push_str(name);
    } else {
        push_js_string(out, name);
    }
}

fn export_name<'a>(name: &ModuleExportName<'a>) -> &'a str {
    match name {
        ModuleExportName::IdentifierName(id) => id.name.as_str(),
        ModuleExportName::IdentifierReference(id) => id.name.as_str(),
        ModuleExportName::StringLiteral(s) => s.value.as_str(),
    }
}

struct Deps {
    specs: NameSet,
}

impl Deps {
    fn index(&mut self, spec: &str) -> usize {
        self.specs.insert(spec)
    }
}

fn dep_name(index: usize) -> String {
    format!("{CTX}_i{index}")
}

pub(crate) fn transform_esm<'a>(
    program: &'a Program<'a>,
    source: &str,
    want_applied: bool,
    dynamic_import: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> EsmOutput {
    let semantic = SemanticBuilder::new().build(program);
    let scoping = semantic.semantic.into_scoping();

    let mut edits = Edits::default();
    let mut deps = Deps { specs: NameSet::default() };
    let mut bindings: Vec<Binding> = Vec::new();
    // symbol index -> index + 1 into `bindings`, 0 for "not an import".
    let mut by_symbol: Vec<u32> = vec![0; scoping.symbols_len()];
    // (export name, expression read by the getter)
    let mut getters: Vec<(String, String)> = Vec::new();
    let mut stars: Vec<usize> = Vec::new();
    let mut reexports = NameSet::default();
    let mut name_default_function = false;

    // Pass 1: imports, so that `export { x }` and references see every binding
    // regardless of statement order.
    for stmt in &program.body {
        // Dependencies are linked (and so evaluated) in source order of all
        // module requests, re-exports included.
        match stmt {
            Statement::ExportFromDeclaration(d) => {
                deps.index(d.source.value.as_str());
            }
            Statement::ExportAllDeclaration(d) => {
                deps.index(d.source.value.as_str());
            }
            _ => {}
        }
        let Statement::ImportDeclaration(decl) = stmt else { continue };
        let dep = dep_name(deps.index(decl.source.value.as_str()));
        if let Some(specifiers) = &decl.specifiers {
            for specifier in specifiers {
                let (local, access) = match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(s) => {
                        let mut access = String::new();
                        push_member(&mut access, &dep, export_name(&s.imported));
                        (&s.local, access)
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                        (&s.local, format!("{dep}.default"))
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                        (&s.local, dep.clone())
                    }
                };
                if let Some(symbol) = local.symbol_id.get() {
                    bindings.push(Binding { access });
                    by_symbol[symbol.index()] = bindings.len() as u32;
                }
            }
        }
        edits.remove_statement(source, decl.span.start, decl.span.end);
    }

    // Pass 2: exports.
    for stmt in &program.body {
        match stmt {
            Statement::ExportFromDeclaration(decl) => {
                let dep = dep_name(deps.index(decl.source.value.as_str()));
                for s in &decl.specifiers {
                    let mut read = String::new();
                    push_member(&mut read, &dep, export_name(&s.local));
                    getters.push((export_name(&s.exported).to_owned(), read));
                }
                edits.remove_statement(source, decl.span.start, decl.span.end);
            }
            Statement::ExportDeclaration(decl) => {
                // `export const a = 1` -> `const a = 1`
                edits.replace(decl.span.start, decl.declaration.span().start, "");
                decl.declaration.bound_names(&mut |id: &BindingIdentifier| {
                    getters.push((id.name.as_str().to_owned(), id.name.as_str().to_owned()));
                });
            }
            Statement::ExportNamedDeclaration(decl) => {
                for s in &decl.specifiers {
                    let local = export_name(&s.local);
                    let mut read = local.to_owned();
                    if let ModuleExportName::IdentifierReference(id) = &s.local {
                        if let Some(binding) = import_binding(&scoping, &by_symbol, id) {
                            read = bindings[binding].access.clone();
                        }
                    }
                    getters.push((export_name(&s.exported).to_owned(), read));
                }
                edits.remove_statement(source, decl.span.start, decl.span.end);
            }
            Statement::ExportDefaultDeclaration(decl) => {
                let start = decl.span.start;
                let default_local = format!("{CTX}_default");
                match &decl.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                        edits.replace(start, f.span.start, "");
                        if let Some(id) = &f.id {
                            getters.push(("default".into(), id.name.as_str().to_owned()));
                        } else {
                            // Stays a hoisted declaration; gets its spec name
                            // ("default") in the prelude.
                            edits.replace_with(f.params.span.start, f.params.span.start, |out| {
                                out.push(' ');
                                out.push_str(&default_local);
                            });
                            name_default_function = true;
                            getters.push(("default".into(), default_local));
                        }
                    }
                    ExportDefaultDeclarationKind::ClassDeclaration(c) => {
                        if let Some(id) = &c.id {
                            edits.replace(start, c.span.start, "");
                            getters.push(("default".into(), id.name.as_str().to_owned()));
                        } else {
                            edits.replace_with(start, c.span.start, |out| {
                                out.push_str("const ");
                                out.push_str(&default_local);
                                out.push_str("=({default:");
                            });
                            edits.insert(c.span.end, "}).default;");
                            getters.push(("default".into(), default_local));
                        }
                    }
                    ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {
                        edits.remove_statement(source, decl.span.start, decl.span.end);
                    }
                    other => {
                        let expr = other.to_expression();
                        let span = expr.span();
                        let anonymous = matches!(
                            expr.without_parentheses(),
                            Expression::ArrowFunctionExpression(_)
                        ) || matches!(expr.without_parentheses(), Expression::FunctionExpression(f) if f.id.is_none())
                            || matches!(expr.without_parentheses(), Expression::ClassExpression(c) if c.id.is_none());
                        edits.replace_with(start, span.start, |out| {
                            out.push_str("const ");
                            out.push_str(&default_local);
                            // The property definition gives an anonymous
                            // function or class the name "default".
                            out.push_str(if anonymous { "=({default:" } else { "=" });
                        });
                        if anonymous {
                            edits.insert(span.end, "}).default");
                        }
                        getters.push(("default".into(), default_local));
                    }
                }
            }
            Statement::ExportAllDeclaration(decl) => {
                let index = deps.index(decl.source.value.as_str());
                match &decl.exported {
                    Some(name) => getters.push((export_name(name).to_owned(), dep_name(index))),
                    None => {
                        if !stars.contains(&index) {
                            stars.push(index);
                        }
                        reexports.insert(decl.source.value.as_str());
                    }
                }
                edits.remove_statement(source, decl.span.start, decl.span.end);
            }
            Statement::TSExportAssignment(d) => diagnostics.push(Diagnostic::error(
                "`export =` cannot be used in an ES module",
                d.span.start,
                d.span.end,
            )),
            _ => {}
        }
    }

    // Pass 3: every expression. Import references, import.meta, import(), TLA.
    let mut visitor = EsmVisitor {
        scoping: &scoping,
        by_symbol: &by_symbol,
        bindings: &bindings,
        edits: &mut edits,
        dynamic_import,
        dynamic_imports: NameSet::default(),
        requires: NameSet::default(),
        function_depth: 0,
        tla: false,
        import_meta: false,
        dynamic: false,
    };
    visitor.visit_program(program);
    let EsmVisitor { dynamic_imports, requires, tla, import_meta, dynamic, .. } = visitor;

    let mut facts = Facts { kind: ModuleKind::Esm, ..Facts::default() };
    if tla {
        facts.flags |= flags::ASYNC;
    }
    if import_meta {
        facts.flags |= flags::IMPORT_META;
    }
    if dynamic {
        facts.flags |= flags::DYNAMIC_IMPORT;
    }
    let unresolved = scoping.root_unresolved_references();
    for (name, flag) in [
        ("require", flags::USES_REQUIRE),
        ("module", flags::USES_MODULE),
        ("exports", flags::USES_EXPORTS),
        ("__filename", flags::USES_FILENAME),
        ("__dirname", flags::USES_DIRNAME),
    ] {
        if unresolved.contains_key(name) {
            facts.flags |= flag;
        }
    }
    if source.contains(CTX) {
        check_reserved(&scoping, diagnostics);
    }

    // Namespace keys are sorted by code unit; do it here so the loader need not.
    getters.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    getters.dedup_by(|a, b| a.0 == b.0);
    if getters.iter().any(|g| g.0 == "default") {
        facts.flags |= flags::HAS_DEFAULT;
    }
    if !stars.is_empty() {
        facts.flags |= flags::HAS_REEXPORTS;
    }

    // The prelude: one line, so every source line keeps its number.
    let mut prelude = String::with_capacity(64 + getters.len() * 24);
    prelude.push_str("\"use strict\";");
    if !getters.is_empty() {
        prelude.push_str(CTX);
        prelude.push_str(".exports({");
        for (i, (name, read)) in getters.iter().enumerate() {
            if i > 0 {
                prelude.push(',');
            }
            push_key(&mut prelude, name);
            prelude.push_str(":()=>");
            prelude.push_str(read);
        }
        prelude.push_str("});");
    }
    let specs = deps.specs.into_vec();
    if !specs.is_empty() {
        prelude.push_str("const ");
        for (i, spec) in specs.iter().enumerate() {
            if i > 0 {
                prelude.push(',');
            }
            prelude.push_str(&dep_name(i));
            prelude.push('=');
            prelude.push_str(CTX);
            prelude.push_str(".link(");
            push_js_string(&mut prelude, spec);
            prelude.push(')');
        }
        prelude.push(';');
    }
    for index in &stars {
        prelude.push_str(CTX);
        prelude.push_str(".star(");
        prelude.push_str(&dep_name(*index));
        prelude.push_str(");");
    }
    if name_default_function {
        prelude.push_str("Object.defineProperty(");
        prelude.push_str(CTX);
        prelude.push_str("_default,\"name\",{value:\"default\",configurable:true});");
    }
    prelude.push_str("yield;");

    facts.exports = getters.into_iter().map(|g| g.0).collect();
    facts.imports = specs;
    facts.dynamic_imports = dynamic_imports.into_vec();
    facts.requires = requires.into_vec();
    facts.reexports = reexports.into_vec();

    // A hashbang is only legal at offset 0 of a script; it is now behind the prelude.
    if let Some(hashbang) = &program.hashbang {
        edits.replace(hashbang.span.start, hashbang.span.start + 2, "//");
    }

    let (code, applied) = edits.apply(source, &prelude, want_applied);
    EsmOutput { code, facts, applied, prelude_len: prelude.len() as u32 }
}

fn import_binding(
    scoping: &Scoping,
    by_symbol: &[u32],
    id: &IdentifierReference,
) -> Option<usize> {
    let reference = id.reference_id.get()?;
    let symbol = scoping.get_reference(reference).symbol_id()?;
    match by_symbol.get(symbol.index()).copied() {
        Some(n) if n > 0 => Some(n as usize - 1),
        _ => None,
    }
}

/// `__bat` and names starting with it belong to the format.
fn check_reserved(scoping: &Scoping, diagnostics: &mut Vec<Diagnostic>) {
    for symbol in scoping.symbol_ids() {
        if scoping.symbol_name(symbol).starts_with(CTX) {
            let span = scoping.symbol_span(symbol);
            diagnostics.push(Diagnostic::error(
                format!(
                    "identifier `{}` collides with the loader's reserved `{CTX}` prefix",
                    scoping.symbol_name(symbol)
                ),
                span.start,
                span.end,
            ));
            return;
        }
    }
    for name in scoping.root_unresolved_references().keys() {
        if name.as_str().starts_with(CTX) {
            diagnostics.push(Diagnostic::error(
                format!(
                    "identifier `{}` collides with the loader's reserved `{CTX}` prefix",
                    name.as_str()
                ),
                0,
                0,
            ));
            return;
        }
    }
}

#[derive(Clone, Copy)]
enum Position {
    /// Plain expression position: `x` -> `ns.x`.
    Value,
    /// Callee or tag: `x()` -> `(0,ns.x)()`, so the namespace is not `this`.
    Callee,
    /// Shorthand property: `{x}` -> `{x:ns.x}`.
    Shorthand,
}

struct EsmVisitor<'v> {
    scoping: &'v Scoping,
    by_symbol: &'v [u32],
    bindings: &'v [Binding],
    edits: &'v mut Edits,
    dynamic_import: &'v str,
    dynamic_imports: NameSet,
    requires: NameSet,
    function_depth: u32,
    tla: bool,
    import_meta: bool,
    dynamic: bool,
}

impl EsmVisitor<'_> {
    fn reference(&mut self, id: &IdentifierReference, position: Position) {
        let Some(binding) = import_binding(self.scoping, self.by_symbol, id) else { return };
        let access = &self.bindings[binding].access;
        self.edits.replace_with(id.span.start, id.span.end, |out| match position {
            Position::Value => out.push_str(access),
            Position::Callee => {
                out.push_str("(0,");
                out.push_str(access);
                out.push(')');
            }
            Position::Shorthand => {
                out.push_str(id.name.as_str());
                out.push(':');
                out.push_str(access);
            }
        });
    }

    /// A callee-like expression. Returns true if handled.
    fn callee(&mut self, expr: &Expression) -> bool {
        match expr {
            Expression::Identifier(id) => {
                self.reference(id, Position::Callee);
                true
            }
            _ => false,
        }
    }
}

pub(crate) fn literal_specifier<'a>(expr: &Expression<'a>) -> Option<&'a str> {
    match expr.without_parentheses() {
        Expression::StringLiteral(s) => Some(s.value.as_str()),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() && t.quasis.len() == 1 => {
            t.quasis[0].value.cooked.as_ref().map(|s| s.as_str())
        }
        _ => None,
    }
}

impl<'a> Visit<'a> for EsmVisitor<'_> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.reference(it, Position::Value);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::Identifier(id) = &it.callee {
            if id.name == "require" && it.arguments.len() == 1 {
                if let Some(spec) = it.arguments[0].as_expression().and_then(literal_specifier) {
                    self.requires.insert(spec);
                }
            }
        }
        if !self.callee(&it.callee) {
            self.visit_expression(&it.callee);
        }
        self.visit_arguments(&it.arguments);
    }

    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        if !self.callee(&it.tag) {
            self.visit_expression(&it.tag);
        }
        self.visit_template_literal(&it.quasi);
    }

    fn visit_parenthesized_expression(&mut self, it: &ParenthesizedExpression<'a>) {
        // `(x)()` must not become `(ns.x)()`: parentheses keep the reference.
        if !self.callee(&it.expression) {
            self.visit_expression(&it.expression);
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if it.shorthand {
            if let Expression::Identifier(id) = &it.value {
                self.reference(id, Position::Shorthand);
                return;
            }
        }
        walk::walk_object_property(self, it);
    }

    fn visit_assignment_target_property_identifier(
        &mut self,
        it: &AssignmentTargetPropertyIdentifier<'a>,
    ) {
        // `({x} = v)` with an imported `x` throws at run time either way, but
        // it has to stay syntactically valid.
        self.reference(&it.binding, Position::Shorthand);
        if let Some(init) = &it.init {
            self.visit_expression(init);
        }
    }

    fn visit_import_meta(&mut self, it: &ImportMeta) {
        self.import_meta = true;
        self.edits.replace_with(it.span.start, it.span.end, |out| {
            out.push_str(CTX);
            out.push_str(".meta");
        });
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if it.phase.is_none() {
            self.dynamic = true;
            self.edits.replace(it.span.start, it.span.start + 6, self.dynamic_import);
            if let Some(spec) = literal_specifier(&it.source) {
                self.dynamic_imports.insert(spec);
            }
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        self.function_depth += 1;
        walk::walk_function(self, it, flags);
        self.function_depth -= 1;
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.function_depth += 1;
        walk::walk_arrow_function_expression(self, it);
        self.function_depth -= 1;
    }

    fn visit_await_expression(&mut self, it: &AwaitExpression<'a>) {
        if self.function_depth == 0 {
            self.tla = true;
        }
        walk::walk_await_expression(self, it);
    }

    fn visit_for_of_statement(&mut self, it: &ForOfStatement<'a>) {
        if it.r#await && self.function_depth == 0 {
            self.tla = true;
        }
        walk::walk_for_of_statement(self, it);
    }

    fn visit_variable_declaration(&mut self, it: &VariableDeclaration<'a>) {
        if it.kind == VariableDeclarationKind::AwaitUsing && self.function_depth == 0 {
            self.tla = true;
        }
        walk::walk_variable_declaration(self, it);
    }

    // Types never reach here (TypeScript is lowered first), and module
    // declarations were handled statement by statement above: their
    // specifiers are not expressions.
    fn visit_import_declaration(&mut self, _it: &ImportDeclaration<'a>) {}
    fn visit_export_all_declaration(&mut self, _it: &ExportAllDeclaration<'a>) {}
    fn visit_export_named_declaration(&mut self, _it: &ExportNamedDeclaration<'a>) {}
    fn visit_export_from_declaration(&mut self, _it: &ExportFromDeclaration<'a>) {}
}
