//! How a wire type is written in TypeScript. Every wire type knows its own TypeScript shape (the `Ts`
//! trait), built by the same macro that gives it its serde derives, so the generated wire.ts and
//! protocol.ts cannot drift from what the Rust server sends and takes.

/// One TypeScript type expression.
#[derive(Debug, Clone, PartialEq)]
pub enum TsType {
    /// A primitive or a declared type, by name: `string`, `number`, `ConversationView`.
    Name(&'static str),
    /// A declared generic type with its arguments: `EntityDelta<ConversationView>`.
    Generic(&'static str, Vec<TsType>),
    /// A string literal type, unquoted here: `herdr` prints as `"herdr"`.
    Lit(String),
    /// `T[]`.
    Array(Box<TsType>),
    /// `T | null`: a Rust `Option` the JSON always carries.
    Nullable(Box<TsType>),
    /// `A | B | ...`.
    Union(Vec<TsType>),
    /// A union of string literals, each with its own doc lines.
    Enum(Vec<(Vec<&'static str>, &'static str)>),
    /// `Record<string, T>`.
    Record(Box<TsType>),
    /// A union written one member per line, each with its own doc lines.
    DocUnion(Vec<(Vec<&'static str>, TsType)>),
    /// An object type written in place.
    Object(Vec<TsField>),
    /// TypeScript text used as written.
    Raw(String),
}

/// One property of an object type.
#[derive(Debug, Clone, PartialEq)]
pub struct TsField {
    pub name: String,
    pub docs: Vec<&'static str>,
    /// Absent from the JSON when unset (`name?: T`), rather than present as null.
    pub optional: bool,
    pub ty: TsType,
}

/// One attribute of a wire type or field, as the macros hand it over.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Attr {
    Doc(&'static str),
    Other(&'static str),
}

/// A Rust type that has a TypeScript spelling.
pub trait Ts {
    fn ts() -> TsType;
}

/// A wire type the generated files declare by name.
pub trait TsDecl {
    fn decl() -> Decl;
}

/// One top-level declaration of a generated file.
#[derive(Debug, Clone, PartialEq)]
pub struct Decl {
    pub name: String,
    pub docs: Vec<&'static str>,
    pub body: DeclBody,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeclBody {
    /// `interface Name<generics> { fields }`.
    Interface {
        generics: Vec<&'static str>,
        fields: Vec<TsField>,
    },
    /// `type Name<generics> = ty;`.
    Alias {
        generics: Vec<&'static str>,
        ty: TsType,
    },
    /// `const Name: annotation = value;`, the annotation left out when empty.
    Const { annotation: String, value: String },
    /// A declaration written out whole after `export `: what TypeScript spells with its own operators
    /// (mapped types, conditional types, method signatures), which no Rust type stands for.
    Text(String),
}

impl TsField {
    /// A field from its Rust name, its attributes and its Rust type's TypeScript. The JSON name is the
    /// camelCase of the Rust name (every wire struct is `rename_all = "camelCase"`) unless a `rename`
    /// says otherwise; a field serde skips when `None` is optional, and its type loses one `| null`.
    pub fn from_rust(rust_name: &str, attrs: &[Attr], ty: TsType) -> TsField {
        let mut name = camel_case(rust_name);
        let mut optional = false;
        let mut docs = Vec::new();
        for attr in attrs {
            match attr {
                Attr::Doc(text) => docs.push(*text),
                Attr::Other(text) => {
                    if text.contains("skip_serializing_if") {
                        optional = true;
                    }
                    if let Some(renamed) = quoted_after(text, "rename =") {
                        name = renamed;
                    }
                }
            }
        }
        let ty = match (optional, ty) {
            (true, TsType::Nullable(inner)) => *inner,
            (_, ty) => ty,
        };
        TsField {
            name,
            docs,
            optional,
            ty,
        }
    }
}

/// The doc lines among a type's attributes.
pub fn docs_of(attrs: &[Attr]) -> Vec<&'static str> {
    attrs
        .iter()
        .filter_map(|attr| match attr {
            Attr::Doc(text) => Some(*text),
            Attr::Other(_) => None,
        })
        .collect()
}

/// The tag a `#[serde(tag = "...")]` union carries, if it has one.
pub fn tag_of(attrs: &[Attr]) -> Option<String> {
    attrs.iter().find_map(|attr| match attr {
        Attr::Other(text) => quoted_after(text, "tag ="),
        Attr::Doc(_) => None,
    })
}

/// One arm of a union. A tagged union's arm is its variant's object with the tag first: the variant's
/// `rename`, or its name with a lower-case first letter (`rename_all = "camelCase"`).
pub fn arm(
    tag: Option<&str>,
    variant: &str,
    attrs: &[Attr],
    ty: TsType,
) -> (Vec<&'static str>, TsType) {
    let docs = docs_of(attrs);
    let Some(tag) = tag else { return (docs, ty) };
    let name = attrs
        .iter()
        .find_map(|attr| match attr {
            Attr::Other(text) => quoted_after(text, "rename ="),
            Attr::Doc(_) => None,
        })
        .unwrap_or_else(|| {
            let mut chars = variant.chars();
            chars
                .next()
                .map(|first| first.to_lowercase().chain(chars).collect())
                .unwrap_or_default()
        });
    let tag_field = TsField {
        name: tag.to_string(),
        docs: Vec::new(),
        optional: false,
        ty: TsType::Lit(name),
    };
    match ty {
        TsType::Object(fields) => {
            let mut all = vec![tag_field];
            all.extend(fields);
            (docs, TsType::Object(all))
        }
        other => (docs, other),
    }
}

/// serde's camelCase for a snake_case field name.
pub fn camel_case(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for (i, c) in snake.chars().enumerate() {
        if c == '_' {
            upper = i > 0;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn quoted_after(text: &str, key: &str) -> Option<String> {
    let start = text.find(key)? + key.len();
    let rest = text[start..].trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

macro_rules! ts_primitive {
    ($name:literal: $($t:ty),*) => {
        $(impl Ts for $t {
            fn ts() -> TsType {
                TsType::Name($name)
            }
        })*
    };
}

ts_primitive!("string": String, str);
ts_primitive!("number": u8, u16, u32, u64, usize, i32, i64, f64);
ts_primitive!("boolean": bool);
ts_primitive!("unknown": serde_json::Value);

impl<T: Ts + ?Sized> Ts for &T {
    fn ts() -> TsType {
        T::ts()
    }
}

impl<T: Ts> Ts for Vec<T> {
    fn ts() -> TsType {
        TsType::Array(Box::new(T::ts()))
    }
}

impl<T: Ts> Ts for Option<T> {
    fn ts() -> TsType {
        TsType::Nullable(Box::new(T::ts()))
    }
}

impl<T: Ts> Ts for Box<T> {
    fn ts() -> TsType {
        T::ts()
    }
}

impl<V: Ts> Ts for indexmap::IndexMap<String, V> {
    fn ts() -> TsType {
        TsType::Record(Box::new(V::ts()))
    }
}

impl Ts for serde_json::Map<String, serde_json::Value> {
    fn ts() -> TsType {
        TsType::Record(Box::new(TsType::Name("unknown")))
    }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/// A doc comment at `indent`, or nothing for no lines. Rust doc lines start with the space after `///`,
/// which the JSDoc's own `* ` replaces.
pub fn print_docs(docs: &[&str], indent: &str) -> String {
    let lines: Vec<&str> = docs
        .iter()
        .flat_map(|doc| doc.split('\n'))
        .map(|line| line.strip_prefix(' ').unwrap_or(line))
        .collect();
    match lines.as_slice() {
        [] => String::new(),
        [one] => format!("{indent}/** {one} */\n"),
        many => {
            let mut out = format!("{indent}/**\n");
            for line in many {
                if line.is_empty() {
                    out.push_str(&format!("{indent} *\n"));
                } else {
                    out.push_str(&format!("{indent} * {line}\n"));
                }
            }
            out.push_str(&format!("{indent} */\n"));
            out
        }
    }
}

/// A property name as TypeScript writes it: bare when it is an identifier, quoted otherwise.
pub fn property_name(name: &str) -> String {
    let plain = name.chars().enumerate().all(|(i, c)| {
        c == '_' || c == '$' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit())
    });
    if plain && !name.is_empty() {
        name.to_string()
    } else {
        format!("\"{name}\"")
    }
}

/// The properties of an object type, one per line at `indent`.
pub fn print_fields(fields: &[TsField], indent: &str) -> String {
    let mut out = String::new();
    for field in fields {
        out.push_str(&print_docs(&field.docs, indent));
        out.push_str(&format!(
            "{indent}{}{}: {};\n",
            property_name(&field.name),
            if field.optional { "?" } else { "" },
            print_type(&field.ty, indent)
        ));
    }
    out
}

/// A type expression as it reads at `indent` (the indent of the line it starts on).
pub fn print_type(ty: &TsType, indent: &str) -> String {
    match ty {
        TsType::Name(name) => name.to_string(),
        TsType::Generic(name, args) => format!(
            "{name}<{}>",
            args.iter()
                .map(|arg| print_type(arg, indent))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        TsType::Lit(text) => format!("\"{text}\""),
        TsType::Array(inner) => {
            let text = print_type(inner, indent);
            if needs_parens(inner) {
                format!("({text})[]")
            } else {
                format!("{text}[]")
            }
        }
        TsType::Nullable(inner) => format!("{} | null", print_type(inner, indent)),
        TsType::Union(members) => members
            .iter()
            .map(|member| print_type(member, indent))
            .collect::<Vec<_>>()
            .join(" | "),
        TsType::Enum(members) => {
            if members.iter().all(|(docs, _)| docs.is_empty()) {
                members
                    .iter()
                    .map(|(_, text)| format!("\"{text}\""))
                    .collect::<Vec<_>>()
                    .join(" | ")
            } else {
                let inner = format!("{indent}  ");
                let mut out = String::new();
                for (docs, text) in members {
                    out.push('\n');
                    out.push_str(print_docs(docs, &inner).as_str());
                    out.push_str(&format!("{inner}| \"{text}\""));
                }
                out
            }
        }
        TsType::Record(value) => format!("Record<string, {}>", print_type(value, indent)),
        TsType::DocUnion(members) => {
            let inner = format!("{indent}  ");
            let mut out = String::new();
            for (docs, member) in members {
                out.push('\n');
                out.push_str(print_docs(docs, &inner).as_str());
                out.push_str(&format!(
                    "{inner}| {}",
                    print_type(member, &format!("{inner}  "))
                ));
            }
            out
        }
        TsType::Object(fields) => {
            if fields.is_empty() {
                return "{}".to_string();
            }
            let one_line = fields
                .iter()
                .all(|field| field.docs.is_empty() && is_short(&field.ty));
            if one_line {
                let body = fields
                    .iter()
                    .map(|field| {
                        format!(
                            "{}{}: {}",
                            property_name(&field.name),
                            if field.optional { "?" } else { "" },
                            print_type(&field.ty, indent)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                if body.len() + indent.len() < 90 {
                    return format!("{{ {body} }}");
                }
            }
            format!(
                "{{\n{}{indent}}}",
                print_fields(fields, &format!("{indent}  "))
            )
        }
        TsType::Raw(text) => text.clone(),
    }
}

fn needs_parens(ty: &TsType) -> bool {
    matches!(
        ty,
        TsType::Nullable(_) | TsType::Union(_) | TsType::DocUnion(_)
    ) || matches!(ty, TsType::Enum(members) if members.len() > 1)
}

fn is_short(ty: &TsType) -> bool {
    match ty {
        TsType::Object(fields) => fields
            .iter()
            .all(|field| field.docs.is_empty() && is_short(&field.ty)),
        TsType::Enum(members) => members.iter().all(|(docs, _)| docs.is_empty()),
        TsType::Array(inner) | TsType::Nullable(inner) | TsType::Record(inner) => is_short(inner),
        TsType::Union(members) => members.iter().all(is_short),
        _ => true,
    }
}

/// A declaration as it reads in a generated file.
pub fn print_decl(decl: &Decl, exported: bool) -> String {
    let export = if exported { "export " } else { "" };
    let mut out = print_docs(&decl.docs, "");
    let generics = |names: &[&str]| {
        if names.is_empty() {
            String::new()
        } else {
            format!("<{}>", names.join(", "))
        }
    };
    match &decl.body {
        DeclBody::Interface {
            generics: names,
            fields,
        } => {
            out.push_str(&format!(
                "{export}interface {}{} {{\n{}}}\n",
                decl.name,
                generics(names),
                print_fields(fields, "  ")
            ));
        }
        DeclBody::Alias {
            generics: names,
            ty,
        } => {
            let mut text = print_type(ty, "");
            if !text.contains('\n') && text.len() + decl.name.len() > 80 {
                // A long union reads one member per line, as the hand-written files write it.
                let members = match ty {
                    TsType::Enum(members) => members
                        .iter()
                        .map(|(docs, text)| (docs.clone(), TsType::Lit(text.to_string())))
                        .collect(),
                    TsType::Union(members) => members
                        .iter()
                        .map(|member| (Vec::new(), member.clone()))
                        .collect(),
                    _ => Vec::new(),
                };
                if !members.is_empty() {
                    text = print_type(&TsType::DocUnion(members), "");
                }
            }
            let sep = if text.starts_with('\n') { "" } else { " " };
            out.push_str(&format!(
                "{export}type {}{} ={sep}{text};\n",
                decl.name,
                generics(names)
            ));
        }
        DeclBody::Const { annotation, value } => {
            let annotation = if annotation.is_empty() {
                String::new()
            } else {
                format!(": {annotation}")
            };
            out.push_str(&format!(
                "{export}const {}{annotation} = {value};\n",
                decl.name
            ));
        }
        DeclBody::Text(text) => {
            out.push_str(&format!("{export}{text}\n"));
        }
    }
    out
}

/// A Rust constant's TypeScript declaration: its type annotation (empty for none, so a literal keeps
/// its literal type) and its value.
pub trait TsConst {
    fn ts_const(&self) -> (String, String);
}

impl TsConst for u64 {
    fn ts_const(&self) -> (String, String) {
        (String::new(), self.to_string())
    }
}

impl TsConst for usize {
    fn ts_const(&self) -> (String, String) {
        (String::new(), self.to_string())
    }
}

impl TsConst for &str {
    fn ts_const(&self) -> (String, String) {
        (
            String::new(),
            serde_json::to_string(self).expect("a string serializes"),
        )
    }
}

impl TsConst for &[u64] {
    fn ts_const(&self) -> (String, String) {
        let values: Vec<String> = self.iter().map(u64::to_string).collect();
        (
            "readonly number[]".to_string(),
            format!("[{}]", values.join(", ")),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_cases_as_serde_does() {
        assert_eq!(camel_case("pane_id"), "paneId");
        assert_eq!(camel_case("spawned_this_run"), "spawnedThisRun");
        assert_eq!(camel_case("id"), "id");
    }

    #[test]
    fn an_optional_field_loses_one_null() {
        let field = TsField::from_rust(
            "effort",
            &[Attr::Other(
                "serde(default, skip_serializing_if = \"Option::is_none\")",
            )],
            <Option<String>>::ts(),
        );
        assert!(field.optional);
        assert_eq!(field.ty, TsType::Name("string"));
        let field = TsField::from_rust(
            "harness",
            &[Attr::Other(
                "serde(default, skip_serializing_if = \"Option::is_none\")",
            )],
            <Option<Option<String>>>::ts(),
        );
        assert_eq!(print_type(&field.ty, ""), "string | null");
    }

    #[test]
    fn prints_docs_as_jsdoc() {
        assert_eq!(print_docs(&[" One line."], ""), "/** One line. */\n");
        assert_eq!(
            print_docs(&[" First,", " second."], "  "),
            "  /**\n   * First,\n   * second.\n   */\n"
        );
    }
}
