use std::path::Path;

use serde_json::Map;

use ac_core::assignment::{
    Assignment, Assignments, assignment_event_payload, assignment_view_of,
    resolve_unseen_assignments,
};
use ac_core::config::{
    ConfigSlice, changed_slice_keys, check_steward_harness, parse_config_slice, read_config_text,
    reload_candidate,
};
use ac_core::events::{append_event, event_now, last_attempt};
use ac_core::harness::{effort_applies, pool_harness_mode};
use ac_protocol::{AssignmentView, TicketEventKind};

use crate::merges::check_resolvers;
use crate::session::{PoolUpdate, Session};

/// `assignmentWireView`: a ticket's Assignment on the wire, with the effort marked not applied when
/// the harness cannot take it in the mode this pool launches in.
pub fn assignment_wire_view(session: &Session, assignment: &Assignment) -> AssignmentView {
    let mode = pool_harness_mode(session.state.config.terminal_text());
    assignment_view_of(
        assignment,
        effort_applies(&session.harnesses, &assignment.harness, mode),
    )
}

fn log_config_reload_rejected(session: &mut Session, message: &str) {
    session.log(format!("config reload rejected: {message}"));
}

fn same_assignment(before: &Assignment, after: &Assignment) -> bool {
    before.harness == after.harness
        && before.model == after.model
        && before.effort == after.effort
        && before.drivers == after.drivers
}

/// `reloadConfigAtBoundary`: re-read console.json; a parse failure or a resolution failure (a resolver
/// included, issue #37) rejects the whole reload atomically, with one pool-log line. The same raw
/// content is never considered twice. Fails only when the file cannot be read.
pub fn reload_config(session: &mut Session) -> anyhow::Result<()> {
    let raw = read_config_text(&session.pool_dir)?;
    if raw == session.last_config_text {
        return Ok(());
    }
    session.last_config_text = raw.clone();
    let slice = match raw {
        None => ConfigSlice::default(),
        Some(raw) => match parse_config_slice(&raw, &session.pool_dir) {
            Ok(slice) => slice,
            Err(error) => {
                log_config_reload_rejected(session, &error.to_string());
                return Ok(());
            }
        },
    };
    let candidate = reload_candidate(&session.state.config, &slice);
    let changed = changed_slice_keys(&session.state.config, &candidate);
    if changed.is_empty() {
        return Ok(());
    }
    let mut resolved = Assignments::new();
    for (id, assignment) in &session.assignments {
        if !session.markers.iter().any(|m| &m.id == id) {
            resolved.insert(id.clone(), assignment.clone());
        }
    }
    let frozen_ids: Vec<String> = session
        .adopted
        .keys()
        .chain(session.enlisted_work.keys())
        .chain(session.continued.keys())
        .chain(session.launched.iter())
        .chain(session.live_attempts.ids().iter())
        .chain(
            session
                .markers
                .iter()
                .filter(|m| m.enlisted_from.is_some())
                .map(|m| &m.id),
        )
        .cloned()
        .collect();
    for id in frozen_ids {
        if let Some(frozen) = session.assignments.get(&id) {
            resolved.insert(id, frozen.clone());
        }
    }
    let dry_run = resolve_unseen_assignments(
        &session.markers,
        &mut resolved,
        &candidate,
        &session.harnesses,
    )
    .and_then(|()| check_steward_harness(&candidate, &session.harnesses))
    .map_err(anyhow::Error::from)
    .and_then(|()| {
        check_resolvers(
            &candidate,
            &session.harnesses,
            &session.machine_defaults,
            session.line.as_ref(),
        )
    });
    if let Err(error) = dry_run {
        log_config_reload_rejected(session, &error.to_string());
        return Ok(());
    }
    let previous = std::mem::replace(&mut session.assignments, resolved);
    session.apply(PoolUpdate {
        config: Some(candidate),
        log: Some(vec![format!("config reloaded: {}", changed.join(", "))]),
        ..PoolUpdate::default()
    });
    let runs = Path::new(&session.runs_dir).to_path_buf();
    for marker in &session.markers {
        let (Some(before), Some(after)) = (
            previous.get(&marker.id),
            session.assignments.get(&marker.id),
        ) else {
            continue;
        };
        if same_assignment(before, after) {
            continue;
        }
        let mut payload = Map::new();
        payload.insert(
            "from".into(),
            serde_json::to_value(assignment_event_payload(before))?,
        );
        payload.insert(
            "to".into(),
            serde_json::to_value(assignment_event_payload(after))?,
        );
        // lastAttempt, not nextAttempt: a reassigned event tags the ticket's current state.
        let attempt = last_attempt(&runs, &marker.id);
        append_event(
            &runs,
            &marker.id,
            &event_now(attempt, TicketEventKind::Reassigned, payload),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, config: serde_json::Value) {
        std::fs::write(dir.join("console.json"), config.to_string()).unwrap();
    }

    #[test]
    fn a_reload_that_would_strand_the_resolver_without_a_model_is_rejected_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (publisher, _) = tokio::sync::watch::channel(None);
        let mut session = crate::testkit::bare_session(publisher);
        session.pool_dir = ac_core::js::path_text(dir.path());
        write_config(
            dir.path(),
            serde_json::json!({"defaults": {"harness": "cursor", "model": "auto"}}),
        );
        reload_config(&mut session).unwrap();
        let before = session.state.config.clone();
        assert!(before.resolver().is_none());
        write_config(
            dir.path(),
            serde_json::json!({
                "resolver": "claude",
                "defaults": {"harness": "cursor", "model": "auto"}
            }),
        );
        reload_config(&mut session).unwrap();
        assert_eq!(session.state.config, before);
        assert_eq!(
            session.state.log.last().map(String::as_str),
            Some(
                "config reload rejected: pool config: resolver names harness 'claude' but no \
                 model: its model comes from defaults.model, which is for 'cursor'. Give resolver \
                 a model: { \"harness\": \"claude\", \"model\": \"...\" }"
            )
        );
        write_config(
            dir.path(),
            serde_json::json!({
                "resolver": {"harness": "claude", "model": "opus"},
                "defaults": {"harness": "cursor", "model": "auto"}
            }),
        );
        reload_config(&mut session).unwrap();
        assert_eq!(
            session.state.config.resolver(),
            Some(&serde_json::json!({"harness": "claude", "model": "opus"}))
        );
    }
}
