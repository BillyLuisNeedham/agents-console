//! The wire shapes and the socket protocol (engine/wire.ts and engine/protocol.ts until the flip), with
//! the serde derives that send and take exactly the JSON the TypeScript server does, and the TypeScript
//! generated from them (ADR-0036).

#[macro_use]
mod macros;

pub mod json;
pub mod protocol;
pub mod ts;
pub mod wire;

pub use protocol::*;
pub use wire::*;
#[cfg(test)]
mod roundtrip;
