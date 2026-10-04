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
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        $(#[$($sattr)*])*
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

/// A union of JSON shapes, one Rust variant per arm, each holding the arm's type. Its serde attributes
/// say how an arm is told apart: `untagged` by its fields, or `tag = "..."` by that field, which the
/// TypeScript arm then carries first.
macro_rules! wire_union {
    (@inline $($rest:tt)*) => {
        wire_union!(@parse inline; $($rest)*);
    };
    (@parse $mode:ident;
        $(#[$($eattr:tt)*])*
        pub enum $name:ident {
            $( $(#[$($vattr:tt)*])* $variant:ident($ty:ty) ),* $(,)?
        }
    ) => {
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
        $(#[$($eattr)*])*
        pub enum $name {
            $( $(#[$($vattr)*])* $variant($ty), )*
        }

        impl $name {
            /// The union's own doc lines.
            pub fn ts_docs() -> Vec<&'static str> {
                $crate::ts::docs_of(&[$(ts_attr!($($eattr)*)),*])
            }

            /// The TypeScript arms, each with its doc lines.
            pub fn ts_arms() -> Vec<(Vec<&'static str>, $crate::ts::TsType)> {
                let tag = $crate::ts::tag_of(&[$(ts_attr!($($eattr)*)),*]);
                vec![$(
                    $crate::ts::arm(
                        tag.as_deref(),
                        stringify!($variant),
                        &[$(ts_attr!($($vattr)*)),*],
                        <$ty as $crate::ts::Ts>::ts(),
                    )
                ),*]
            }
        }

        wire_union!(@ts $mode $name);
    };
    (@ts inline $name:ident) => {
        impl $crate::ts::Ts for $name {
            fn ts() -> $crate::ts::TsType {
                $crate::ts::TsType::Union(Self::ts_arms().into_iter().map(|(_, ty)| ty).collect())
            }
        }
    };
    (@ts declared $name:ident) => {
        impl $crate::ts::Ts for $name {
            fn ts() -> $crate::ts::TsType {
                $crate::ts::TsType::Name(stringify!($name))
            }
        }

        impl $crate::ts::TsDecl for $name {
            fn decl() -> $crate::ts::Decl {
                let arms = Self::ts_arms();
                let ty = if arms.iter().all(|(docs, _)| docs.is_empty()) && arms.len() < 4 {
                    $crate::ts::TsType::Union(arms.into_iter().map(|(_, ty)| ty).collect())
                } else {
                    $crate::ts::TsType::DocUnion(arms)
                };
                $crate::ts::Decl {
                    name: stringify!($name).to_string(),
                    docs: Self::ts_docs(),
                    body: $crate::ts::DeclBody::Alias { generics: Vec::new(), ty },
                }
            }
        }
    };
    ($($rest:tt)*) => {
        wire_union!(@parse declared; $($rest)*);
    };
}

/// Constants the TypeScript declares too, each with its doc lines and its TypeScript value.
macro_rules! wire_consts {
    ($list:ident => $( $(#[$($attr:tt)*])* pub const $name:ident : $ty:ty = $value:expr; )*) => {
        $( $(#[$($attr)*])* pub const $name: $ty = $value; )*

        /// These constants as the generated TypeScript declares them, in order.
        pub fn $list() -> Vec<$crate::ts::Decl> {
            vec![$({
                let (annotation, value) = $crate::ts::TsConst::ts_const(&$name);
                $crate::ts::Decl {
                    name: stringify!($name).to_string(),
                    docs: $crate::ts::docs_of(&[$(ts_attr!($($attr)*)),*]),
                    body: $crate::ts::DeclBody::Const { annotation, value },
                }
            }),*]
        }
    };
}

/// TypeScript declarations no Rust type stands for, written out whole, each with its doc lines. An
/// `export` entry is exported from the generated file; a `local` one is not.
macro_rules! ts_declarations {
    ($list:ident => $( $(#[$($attr:tt)*])* $visibility:ident $name:ident => $text:expr; )*) => {
        /// These declarations as the generated TypeScript writes them, each with whether it is exported.
        pub fn $list() -> Vec<($crate::ts::Decl, bool)> {
            vec![$((
                $crate::ts::Decl {
                    name: stringify!($name).to_string(),
                    docs: $crate::ts::docs_of(&[$(ts_attr!($($attr)*)),*]),
                    body: $crate::ts::DeclBody::Text($text.to_string()),
                },
                ts_declarations!(@exported $visibility),
            )),*]
        }
    };
    (@exported export) => {
        true
    };
    (@exported local) => {
        false
    };
}
