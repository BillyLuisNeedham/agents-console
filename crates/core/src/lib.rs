//! The pure core: on-disk formats, config, assignments, prompts, and the decisions that need no I/O.

pub mod stat_cache;

pub mod assignment;
pub mod config;
pub mod fleet;
pub mod harness;
mod js_compat;
pub mod machine_defaults;
pub mod pool_settings;
pub mod pool_title;
pub mod spawn_caps;
pub mod steward;
