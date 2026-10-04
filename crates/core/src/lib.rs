//! The pure core: on-disk formats, config, assignments, prompts, and the decisions that need no I/O.

pub mod assignment;
pub mod checkpoints;
pub mod config;
pub mod conversation_record;
pub mod drive_errors;
pub mod events;
pub mod fleet;
pub mod harness;
pub mod js;
pub mod machine_defaults;
pub mod pool;
pub mod pool_settings;
pub mod pool_title;
pub mod pool_workspace;
pub mod queued_answers;
pub mod spawn_caps;
pub mod spawn_ledger;
pub mod spawn_proposals;
pub mod stat_cache;
pub mod steward;
pub mod steward_notes;
pub mod streamlog;
