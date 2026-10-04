//! Serde helpers for the JSON shapes JavaScript makes that serde has no word for: the literal `true`,
//! a number written the way JavaScript writes it, a field that is absent, null or set, and a value the
//! TypeScript passes through unchecked.

use std::fmt;
use std::marker::PhantomData;

use serde::de::{DeserializeOwned, Deserializer, Error as _};
use serde::{Deserialize, Serialize, Serializer};

use crate::ts::{Ts, TsType};

/// The TypeScript literal type `true`: a field that is only ever `true` (`ok: true`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct True;

impl Serialize for True {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl<'de> Deserialize<'de> for True {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match bool::deserialize(deserializer)? {
            true => Ok(True),
            false => Err(D::Error::custom("expected true")),
        }
    }
}

impl Ts for True {
    fn ts() -> TsType {
        TsType::Name("true")
    }
}

/// A JavaScript number held as `f64` and written as `JSON.stringify` writes it: a whole number
/// without a fraction (`8`, not `8.0`). Use with `#[serde(with = "crate::json::js_number")]`.
pub mod js_number {
    use super::*;

    pub fn serialize<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
        // JSON.stringify writes NaN and the infinities as null.
        if !value.is_finite() {
            return serializer.serialize_unit();
        }
        if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            // Negative zero prints as 0 in JavaScript too.
            return serializer.serialize_i64(*value as i64);
        }
        serializer.serialize_f64(*value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<f64, D::Error> {
        f64::deserialize(deserializer)
    }
}

/// Deserialize a field that is present as `Some`, so that `Option<Option<T>>` tells an absent field
/// (`None`, with `#[serde(default)]`) from a null one (`Some(None)`). Use with
/// `#[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::json::some")]`.
pub fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// A value the TypeScript passes through from a file or a request without checking it against its
/// declared type `T` (a hand-edited console.json, say), so the Rust server must too. It serializes and
/// deserializes as the raw JSON value; TypeScript names it `T`.
pub struct Unchecked<T> {
    pub value: serde_json::Value,
    marker: PhantomData<fn() -> T>,
}

impl<T> Unchecked<T> {
    pub fn new(value: serde_json::Value) -> Self {
        Unchecked {
            value,
            marker: PhantomData,
        }
    }

    /// The value read as its declared type.
    pub fn parse(&self) -> serde_json::Result<T>
    where
        T: DeserializeOwned,
    {
        serde_json::from_value(self.value.clone())
    }
}

impl<T: Serialize> Unchecked<T> {
    /// A checked value, held raw.
    pub fn of(typed: &T) -> serde_json::Result<Self> {
        Ok(Unchecked::new(serde_json::to_value(typed)?))
    }
}

impl<T> Clone for Unchecked<T> {
    fn clone(&self) -> Self {
        Unchecked::new(self.value.clone())
    }
}

impl<T> PartialEq for Unchecked<T> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<T> fmt::Debug for Unchecked<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.value.fmt(f)
    }
}

impl<T> Serialize for Unchecked<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.value.serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for Unchecked<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        serde_json::Value::deserialize(deserializer).map(Unchecked::new)
    }
}

impl<T: Ts> Ts for Unchecked<T> {
    fn ts() -> TsType {
        T::ts()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Scored {
        #[serde(with = "js_number")]
        score: f64,
    }

    #[test]
    fn writes_numbers_as_javascript_does() {
        let text = |score| serde_json::to_string(&Scored { score }).unwrap();
        assert_eq!(text(8.0), r#"{"score":8}"#);
        assert_eq!(text(7.5), r#"{"score":7.5}"#);
        assert_eq!(text(0.1), r#"{"score":0.1}"#);
        assert_eq!(text(f64::NAN), r#"{"score":null}"#);
        assert_eq!(
            serde_json::from_str::<Scored>(r#"{"score":8}"#).unwrap(),
            Scored { score: 8.0 }
        );
    }

    #[test]
    fn true_is_only_true() {
        assert_eq!(serde_json::to_string(&True).unwrap(), "true");
        assert!(serde_json::from_str::<True>("true").is_ok());
        assert!(serde_json::from_str::<True>("false").is_err());
    }

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Patch {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "some"
        )]
        model: Option<Option<String>>,
    }

    #[test]
    fn tells_absent_from_null() {
        let read = |text| serde_json::from_str::<Patch>(text).unwrap().model;
        assert_eq!(read("{}"), None);
        assert_eq!(read(r#"{"model":null}"#), Some(None));
        assert_eq!(read(r#"{"model":"x"}"#), Some(Some("x".to_string())));
        assert_eq!(
            serde_json::to_string(&Patch { model: Some(None) }).unwrap(),
            r#"{"model":null}"#
        );
        assert_eq!(serde_json::to_string(&Patch { model: None }).unwrap(), "{}");
    }
}
