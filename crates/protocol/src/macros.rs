//! The two macros every wire type is declared with. Each gives the type its serde derives and its
//! TypeScript spelling from the same tokens, so the two cannot disagree.
//!
//! A struct's JSON names are the camelCase of its Rust field names. A field serde skips when `None`
//! (`skip_serializing_if = "Option::is_none"`) is optional in TypeScript (`name?: T`); any other
//! `Option` is `T | null` and always sent. `@inline` writes the type out in place wherever it is used
//! (an object or string union the TypeScript never names); without it the type is declared by name.

/// One attribute's tokens as a [`crate::ts::Attr`]: a doc line, or anything else as text.
macro_rules! ts_attr {
    (doc = $doc:literal) => {
        $crate::ts::Attr::Doc($doc)
    };
    ($($tokens:tt)*) => {
        $crate::ts::Attr::Other(stringify!($($tokens)*))
    };
}

/// A struct with named fields, sent and taken as a JSON object.
macro_rules! wire_struct {
    (@inline $($rest:tt)*) => {
        wire_struct!(@parse inline; $($rest)*);
    };
    (@parse $mode:ident;
        $(#[$($sattr:tt)*])*
        pub struct $name:ident {
            $( $(#[$($fattr:tt)*])* pub $field:ident : $ty:ty ),* $(,)?
        }
    ) => {
        $(#[$($sattr)*])*
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $( $(#[$($fattr)*])* pub $field: $ty, )*
        }

        impl $name {
            /// The type's own doc lines, for the TypeScript that names or inlines it.
            pub fn ts_docs() -> Vec<&'static str> {
                $crate::ts::docs_of(&[$(ts_attr!($($sattr)*)),*])
            }

            /// The TypeScript properties, in the order the JSON carries them.
            pub fn ts_fields() -> Vec<$crate::ts::TsField> {
                vec![$(
                    $crate::ts::TsField::from_rust(
                        stringify!($field),
                        &[$(ts_attr!($($fattr)*)),*],
                        <$ty as $crate::ts::Ts>::ts(),
                    )
                ),*]
            }
        }

        wire_struct!(@ts $mode $name [$(ts_attr!($($sattr)*)),*]);
    };
    (@ts inline $name:ident [$($attr:expr),*]) => {
        impl $crate::ts::Ts for $name {
            fn ts() -> $crate::ts::TsType {
                $crate::ts::TsType::Object(Self::ts_fields())
            }
        }
    };
    (@ts declared $name:ident [$($attr:expr),*]) => {
        impl $crate::ts::Ts for $name {
            fn ts() -> $crate::ts::TsType {
                $crate::ts::TsType::Name(stringify!($name))
            }
        }

        impl $crate::ts::TsDecl for $name {
            fn decl() -> $crate::ts::Decl {
                $crate::ts::Decl {
                    name: stringify!($name).to_string(),
                    docs: $crate::ts::docs_of(&[$($attr),*]),
                    body: $crate::ts::DeclBody::Interface { generics: Vec::new(), fields: Self::ts_fields() },
                }
            }
        }
    };
    ($($rest:tt)*) => {
        wire_struct!(@parse declared; $($rest)*);
    };
}

/// A string union: each variant is sent and taken as its exact string.
macro_rules! wire_enum {
    (@inline $($rest:tt)*) => {
        wire_enum!(@parse inline; $($rest)*);
    };
    (@parse $mode:ident;
        $(#[$($eattr:tt)*])*
        pub enum $name:ident {
            $( $(#[$($vattr:tt)*])* $variant:ident = $text:literal ),* $(,)?
        }
    ) => {
        $(#[$($eattr)*])*
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
        )]
        pub enum $name {
            $( $(#[$($vattr)*])* #[serde(rename = $text)] $variant, )*
        }

        impl $name {
            /// Every value, in the order the TypeScript lists them.
            pub const ALL: &'static [$name] = &[$($name::$variant),*];

            /// The exact string the JSON carries.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text,)*
                }
            }

            /// The value its exact string names, if any.
            pub fn parse(text: &str) -> Option<$name> {
                match text {
                    $($text => Some($name::$variant),)*
                    _ => None,
                }
            }

            /// The TypeScript union's members, each with its doc lines.
            pub fn ts_members() -> Vec<(Vec<&'static str>, &'static str)> {
                vec![$(($crate::ts::docs_of(&[$(ts_attr!($($vattr)*)),*]), $text)),*]
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        wire_enum!(@ts $mode $name [$(ts_attr!($($eattr)*)),*]);
    };
    (@ts inline $name:ident [$($attr:expr),*]) => {
        impl $crate::ts::Ts for $name {
            fn ts() -> $crate::ts::TsType {
                $crate::ts::TsType::Enum(Self::ts_members())
            }
        }
    };
    (@ts declared $name:ident [$($attr:expr),*]) => {
        impl $crate::ts::Ts for $name {
            fn ts() -> $crate::ts::TsType {
                $crate::ts::TsType::Name(stringify!($name))
            }
        }

        impl $crate::ts::TsDecl for $name {
            fn decl() -> $crate::ts::Decl {
                $crate::ts::Decl {
                    name: stringify!($name).to_string(),
                    docs: $crate::ts::docs_of(&[$($attr),*]),
                    body: $crate::ts::DeclBody::Alias {
                        generics: Vec::new(),
                        ty: $crate::ts::TsType::Enum(Self::ts_members()),
                    },
                }
            }
        }
    };
    ($($rest:tt)*) => {
        wire_enum!(@parse declared; $($rest)*);
    };
}
