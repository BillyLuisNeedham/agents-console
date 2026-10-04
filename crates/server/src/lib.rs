//! The pool server (engine/server.ts, engine/ws.ts, engine/ports.ts and the server's half of
//! ui/src/protocol.ts): the HTTP routes, the socket at /api/ws, and the embedded Console.
//!
//! Running note (issue #162, milestone M4, kept so the work survives a context compaction):
//! - Done: ports, the pool lock, the bind with the port hunt, fleet registration, the enriched
//!   snapshot and pool meta, Reassign (views and write; it lives here, the only user), the per-ticket
//!   reads (log ranges, events, body, grades, activity with its 1.5 s diff cache), every HTTP route
//!   and the Steward's, the socket hub (hello, snapshot and deltas with coalescing, live values,
//!   cards with a file watch, requests and replies, the page with its embedded boot snapshot), the
//!   orderly stop, and the `server` subcommand in crates/cli.
//! - Next: run the full conformance areas once the engine core (Engine::start_pool and the handle's
//!   bodies) lands.

pub mod enrich;
mod http;
mod hub;
pub mod lock;
pub mod ports;
pub mod push;
pub mod reads;
pub mod reassign;
mod routes;
pub mod server;
pub mod ui;

pub use server::{
    PoolServerOptions, RestartHandOff, SNAPSHOT_COALESCE, Server, Starter, StopHandOff,
};

#[cfg(test)]
mod tests;
