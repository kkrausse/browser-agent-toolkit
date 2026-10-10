//! CommonJS: the code passes through (only `import()` and a hashbang are
//! rewritten); the work here is the facts, i.e. what Node's `cjs-module-lexer`
//! detects so that `import { x } from 'cjs'` can be linked, done on the AST.

use oxc_ast::ast::*;
use oxc_ast_visit::{walk, Visit};

use crate::edits::Edits;
use crate::esm::literal_specifier;
use crate::facts::{flags, Facts, ModuleKind, NameSet};
use crate::{Diagnostic, CTX};

pub(crate) struct CjsOutput {
    /// `None`: the code is the input, unchanged.
    pub code: Option<String>,
    pub facts: Facts,
    pub applied: Vec<(u32, u32, u32)>,
}

pub(crate) fn transform_cjs<'a>(
    program: &Program<'a>,
    source: &str,
    want_applied: bool,
    dynamic_import: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> CjsOutput {
    let mut visitor = CjsVisitor {
        edits: Edits::default(),
        dynamic_import,
        exports: NameSet::default(),
        reexports: NameSet::default(),
        requires: NameSet::default(),
        dynamic_imports: NameSet::default(),
        required_as: Vec::new(),
        flags: 0,
        check_reserved: source.contains(CTX),
        reserved: None,
    };
    if let Some(hashbang) = &program.hashbang {
        visitor.edits.replace(hashbang.span.start, hashbang.span.start + 2, "//");
    }
    visitor.visit_program(program);

    if let Some((name, start, end)) = visitor.reserved.take() {
        diagnostics.push(Diagnostic::error(
            format!("identifier `{name}` collides with the loader's reserved `{CTX}` prefix"),
            start,
            end,
        ));
    }

    let mut facts = Facts { kind: ModuleKind::CommonJs, flags: visitor.flags, ..Facts::default() };
    if visitor.exports.contains("__esModule") {
        facts.flags |= flags::ES_MODULE_MARKER;
    }
    facts.exports = visitor.exports.into_vec();
    facts.reexports = visitor.reexports.into_vec();
    facts.requires = visitor.requires.into_vec();
    facts.dynamic_imports = visitor.dynamic_imports.into_vec();
    if !facts.reexports.is_empty() {
        facts.flags |= flags::HAS_REEXPORTS;
    }

    if visitor.edits.is_empty() {
        facts.flags |= flags::CODE_IS_SOURCE;
        return CjsOutput { code: None, facts, applied: Vec::new() };
    }
    let (code, applied) = visitor.edits.apply(source, "", want_applied);
    CjsOutput { code: Some(code), facts, applied }
}

struct CjsVisitor<'v, 'a> {
    edits: Edits,
    dynamic_import: &'v str,
    exports: NameSet,
    reexports: NameSet,
    requires: NameSet,
    dynamic_imports: NameSet,
    /// `var x = require('lit')` / `var x = wrap(require('lit'))`, for the
    /// Babel `Object.keys(x).forEach(...)` re-export shape.
    required_as: Vec<(&'a str, &'a str)>,
    flags: u32,
    check_reserved: bool,
    reserved: Option<(String, u32, u32)>,
}

/// `exports` or `module.exports`.
fn is_exports_object(expr: &Expression) -> bool {
    match expr.without_parentheses() {
        Expression::Identifier(id) => id.name == "exports",
        Expression::StaticMemberExpression(m) => {
            m.property.name == "exports" && m.object.is_specific_id("module")
        }
        _ => false,
    }
}

/// `require("literal")`, possibly wrapped in one helper call
/// (`_interopRequireWildcard(require("x"))`, `__toESM(require("x"))`).
fn required_specifier<'a>(expr: &Expression<'a>) -> Option<&'a str> {
    let Expression::CallExpression(call) = expr.without_parentheses() else { return None };
    if call.callee.is_specific_id("require") {
        if call.arguments.len() == 1 {
            return call.arguments[0].as_expression().and_then(literal_specifier);
        }
        return None;
    }
    if !call.arguments.is_empty() {
        return call.arguments[0].as_expression().and_then(|arg| match arg.without_parentheses() {
            Expression::CallExpression(inner) if inner.callee.is_specific_id("require") => {
                required_specifier(arg)
            }
            _ => None,
        });
    }
    None
}

impl<'a> CjsVisitor<'_, 'a> {
    fn object_literal_exports(&mut self, object: &ObjectExpression<'a>) {
        for property in &object.properties {
            match property {
                ObjectPropertyKind::ObjectProperty(p) => {
                    if p.computed {
                        continue;
                    }
                    if let Some(name) = p.key.static_name() {
                        self.exports.insert(&name);
                    }
                }
                ObjectPropertyKind::SpreadProperty(s) => {
                    if let Some(spec) = required_specifier(&s.argument) {
                        self.reexports.insert(spec);
                    }
                }
            }
        }
    }

    fn define_property(&mut self, call: &CallExpression<'a>) {
        // Object.defineProperty(exports, "name", { enumerable: true, get } | { value })
        if call.arguments.len() != 3 {
            return;
        }
        let Some(target) = call.arguments[0].as_expression() else { return };
        if !is_exports_object(target) {
            return;
        }
        let Some(name) = call.arguments[1].as_expression().and_then(literal_specifier) else {
            return;
        };
        let Some(Expression::ObjectExpression(descriptor)) =
            call.arguments[2].as_expression().map(|e| e.without_parentheses())
        else {
            return;
        };
        let has = |key: &str| {
            descriptor.properties.iter().any(|p| match p {
                ObjectPropertyKind::ObjectProperty(p) => {
                    p.key.static_name().is_some_and(|name| name == key)
                }
                ObjectPropertyKind::SpreadProperty(_) => false,
            })
        };
        if has("value") || has("get") {
            self.exports.insert(name);
        }
    }
}

impl<'a> Visit<'a> for CjsVisitor<'_, 'a> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let name = it.name.as_str();
        match name.len() {
            6 if name == "module" => self.flags |= flags::USES_MODULE,
            7 if name == "require" => self.flags |= flags::USES_REQUIRE,
            7 if name == "exports" => self.flags |= flags::USES_EXPORTS,
            9 if name == "__dirname" => self.flags |= flags::USES_DIRNAME,
            10 if name == "__filename" => self.flags |= flags::USES_FILENAME,
            _ => {}
        }
        if self.check_reserved && self.reserved.is_none() && name.starts_with(CTX) {
            self.reserved = Some((name.to_owned(), it.span.start, it.span.end));
        }
    }

    fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
        if self.check_reserved && self.reserved.is_none() && it.name.as_str().starts_with(CTX) {
            self.reserved = Some((it.name.as_str().to_owned(), it.span.start, it.span.end));
        }
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if it.phase.is_none() {
            self.flags |= flags::DYNAMIC_IMPORT;
            self.edits.replace(it.span.start, it.span.start + 6, self.dynamic_import);
            if let Some(spec) = literal_specifier(&it.source) {
                self.dynamic_imports.insert(spec);
            }
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (BindingPattern::BindingIdentifier(id), Some(init)) = (&it.id, &it.init) {
            if let Some(spec) = required_specifier(init) {
                self.required_as.push((id.name.as_str(), spec));
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        if it.operator == AssignmentOperator::Assign {
            if let Some(member) = it.left.as_member_expression() {
                if is_exports_object(member.object()) {
                    // exports.name = …, module.exports.name = …, exports["name"] = …
                    if let Some(name) = member.static_property_name() {
                        self.exports.insert(name);
                    }
                } else if member.is_specific_member_access("module", "exports") {
                    // module.exports = { … } | require("…")
                    let mut right = it.right.without_parentheses();
                    while let Expression::AssignmentExpression(inner) = right {
                        right = inner.right.without_parentheses();
                    }
                    match right {
                        Expression::ObjectExpression(object) => self.object_literal_exports(object),
                        other => {
                            if let Some(spec) = required_specifier(other) {
                                if matches!(other, Expression::CallExpression(c) if c.callee.is_specific_id("require"))
                                {
                                    self.reexports.insert(spec);
                                }
                            }
                        }
                    }
                }
            }
        }
        walk::walk_assignment_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        match it.callee.without_parentheses() {
            Expression::Identifier(id) => {
                let name = id.name.as_str();
                if name == "require" {
                    if it.arguments.len() == 1 {
                        if let Some(spec) =
                            it.arguments[0].as_expression().and_then(literal_specifier)
                        {
                            self.requires.insert(spec);
                        }
                    }
                } else if name == "__exportStar" || name == "__export" || name == "__reExport" {
                    // __exportStar(require("x"), exports) / __export(require("x"))
                    if let Some(spec) =
                        it.arguments.first().and_then(|a| a.as_expression()).and_then(required_specifier)
                    {
                        self.reexports.insert(spec);
                    }
                }
            }
            Expression::StaticMemberExpression(member) => {
                let property = member.property.name.as_str();
                if property == "defineProperty" && member.object.is_specific_id("Object") {
                    self.define_property(it);
                } else if property == "__exportStar" {
                    // tslib.__exportStar(require("x"), exports)
                    if let Some(spec) =
                        it.arguments.first().and_then(|a| a.as_expression()).and_then(required_specifier)
                    {
                        self.reexports.insert(spec);
                    }
                } else if property == "forEach" {
                    // Babel: Object.keys(_x).forEach(function (key) { … exports[key] = _x[key] … })
                    if let Expression::CallExpression(keys) = member.object.without_parentheses() {
                        if keys.callee.without_parentheses().as_member_expression().is_some_and(
                            |m| m.is_specific_member_access("Object", "keys"),
                        ) {
                            if let Some(Expression::Identifier(id)) =
                                keys.arguments.first().and_then(|a| a.as_expression())
                            {
                                let found = self
                                    .required_as
                                    .iter()
                                    .find(|(local, _)| *local == id.name.as_str())
                                    .map(|(_, spec)| *spec);
                                if let Some(spec) = found {
                                    self.reexports.insert(spec);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        walk::walk_call_expression(self, it);
    }
}
