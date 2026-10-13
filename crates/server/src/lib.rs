//! The pool server (engine/server.ts, engine/ws.ts, engine/ports.ts and the server's half of
//! ui/src/protocol.ts): the HTTP routes, the socket at /api/ws, and the embedded Console.

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
