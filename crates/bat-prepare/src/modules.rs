//! Adapter between the packer's transform hook and `bat-modules`.

use crate::pack::Transform;

#[cfg(feature = "modules")]
mod real {
    use crate::pack::{Compiled, ModuleInput};
    use bat_modules::{flags, transform, ModuleKind, Options, PackageType};

    pub fn compile(input: &ModuleInput) -> Option<Compiled> {
        let source = std::str::from_utf8(input.source).ok()?;
        let options = Options {
            package_type: match input.package_type {
                Some("module") => PackageType::Module,
                Some("commonjs") => PackageType::CommonJs,
                _ => PackageType::None,
            },
            // The runtime carries AsyncLocalStorage context across `await` through these hooks.
            async_context: true,
            ..Options::default()
        };
        let output = transform(source, input.path, &options);
        if !output.ok() || output.facts.kind == ModuleKind::Unknown {
            return Some(Compiled { code: Vec::new(), facts: bat_image::facts::FAILED, blob: Vec::new() });
        }
        let word = output.facts.word();
        debug_assert_eq!(word & !bat_image::facts::MODULE_MASK, 0);
        // Identical to the source: the image stores no second body.
        let code = if word & flags::CODE_IS_SOURCE != 0 { Vec::new() } else { output.code.as_bytes().to_vec() };
        Some(Compiled { code, facts: word, blob: output.facts.encode_blob() })
    }
}

/// Identifies the transform implementation in fingerprints. The tool's own binary is
/// fingerprinted too, so a rebuilt `bat-modules` invalidates images by itself.
pub const TRANSFORM_VERSION: &str = if cfg!(feature = "modules") { "bat-modules" } else { "none" };

pub fn transform() -> Option<Box<Transform<'static>>> {
    #[cfg(feature = "modules")]
    {
        Some(Box::new(real::compile))
    }
    #[cfg(not(feature = "modules"))]
    {
        None
    }
}
