//! The wire shapes and the socket protocol, with the serde derives that send and take exactly the JSON
//! the TypeScript server did, and the TypeScript generated from them (ADR-0036): protocol/wire.ts and
//! protocol/protocol.ts.

#[macro_use]
mod macros;

pub mod json;
pub mod protocol;
pub mod ts;
pub mod typescript;
pub mod wire;

#[cfg(test)]
mod roundtrip;

pub use protocol::*;
pub use wire::*;
