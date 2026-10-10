//! Stand-in for `js-sys` in the bat-modules Wasm build. oxc-browserslist reads
//! the clock through `js_sys::Date` when resolving browserslist queries; the
//! module transform never resolves one, so these are never called. They exist
//! so the crate compiles without wasm-bindgen.

pub struct Date {
    millis: core::cell::Cell<f64>,
}

impl Date {
    pub fn now() -> f64 {
        0.0
    }

    pub fn new_0() -> Date {
        Date { millis: core::cell::Cell::new(0.0) }
    }

    pub fn set_time(&self, millis: f64) -> f64 {
        self.millis.set(millis);
        millis
    }

    pub fn get_full_year(&self) -> u32 {
        1970
    }

    pub fn get_month(&self) -> u32 {
        0
    }

    pub fn set_full_year_with_month(&self, _year: u32, _month: i32) -> f64 {
        f64::NAN
    }
}
