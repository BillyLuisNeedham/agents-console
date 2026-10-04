//! The server's half of the Console's push protocol (ui/src/protocol.ts, issue #161, ADR-0032): the pool
//! log's trim, the snapshot as pushed, the delta between two pushed versions, the envelope's encode and
//! the client frame's decode, and the boot snapshot embedded in the page. The Console keeps running the
//! TypeScript twins of these (applyDelta, decodeServerMessage, readEmbeddedBoot), so every rule here is
//! the TypeScript's, worked on the snapshot's JSON exactly as the TypeScript works on its objects.

use serde_json::{Map, Value};

use ac_core::js;
use ac_protocol::{EMBED_ELEMENT_ID, EnrichedSnapshot, POOL_LOG_WINDOW, RequestKind};

/// One version of the snapshot as the socket carries it: the enriched snapshot's JSON with `state.log`
/// cut to its last POOL_LOG_WINDOW lines, the full log's length beside it, and the revision.
#[derive(Debug, Clone, PartialEq)]
pub struct Pushed {
    pub rev: u64,
    pub log_total: u64,
    /// The trimmed snapshot, a JSON object.
    pub snapshot: Value,
}

/// The pool log's last `window` lines and how many there are in all.
pub fn trim_pool_log(log: &[String], window: usize) -> (Vec<String>, u64) {
    let from = log.len().saturating_sub(window);
    (log[from..].to_vec(), log.len() as u64)
}

/// A full enriched snapshot as the socket pushes it, at revision `rev`.
pub fn to_pushed(full: &EnrichedSnapshot, rev: u64) -> Result<Pushed, serde_json::Error> {
    let mut snapshot = serde_json::to_value(full)?;
    let log_total = full.state.log.len() as u64;
    if let Some(Value::Array(log)) = snapshot
        .get_mut("state")
        .and_then(|state| state.get_mut("log"))
    {
        let from = log.len().saturating_sub(POOL_LOG_WINDOW);
        log.drain(..from);
    }
    Ok(Pushed {
        rev,
        log_total,
        snapshot,
    })
}

/// Deep equality as `JSON.stringify(a) === JSON.stringify(b)` judges it: key order counts.
pub fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => same_value(a, b),
        _ => false,
    }
}

fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b.iter())
                    .all(|((ka, va), (kb, vb))| ka == kb && same_value(va, vb))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b))
        }
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => a == b,
    }
}

fn id_of(entity: &Value) -> &str {
    entity.get("id").and_then(Value::as_str).unwrap_or("")
}

// A keyed list's change: the entities that are new or changed, whole; the ids that went; and the full
// id order, present only when the order of ids moved.
fn diff_entities(prev: &[Value], next: &[Value]) -> Option<Value> {
    let before: std::collections::HashMap<&str, &Value> =
        prev.iter().map(|entity| (id_of(entity), entity)).collect();
    let after: std::collections::HashSet<&str> = next.iter().map(id_of).collect();
    let upsert: Vec<Value> = next
        .iter()
        .filter(|entity| {
            before
                .get(id_of(entity))
                .is_none_or(|old| !same_value(old, entity))
        })
        .cloned()
        .collect();
    let remove: Vec<Value> = prev
        .iter()
        .map(id_of)
        .filter(|id| !after.contains(id))
        .map(Value::from)
        .collect();
    let moved = prev.len() != next.len()
        || prev
            .iter()
            .zip(next)
            .any(|(old, new)| id_of(old) != id_of(new));
    if upsert.is_empty() && remove.is_empty() && !moved {
        return None;
    }
    let mut delta = Map::new();
    if !upsert.is_empty() {
        delta.insert("upsert".into(), Value::Array(upsert));
    }
    if !remove.is_empty() {
        delta.insert("remove".into(), Value::Array(remove));
    }
    if moved {
        delta.insert(
            "order".into(),
            Value::Array(next.iter().map(|e| Value::from(id_of(e))).collect()),
        );
    }
    Some(Value::Object(delta))
}

fn log_of(pushed: &Pushed) -> &[Value] {
    pushed
        .snapshot
        .get("state")
        .and_then(|state| state.get("log"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

// New pool log lines past the old end, or a whole new window when the log did not simply grow.
fn diff_log(prev: &Pushed, next: &Pushed) -> Option<Value> {
    let old = log_of(prev);
    let now = log_of(next);
    let grown = next.log_total as i64 - prev.log_total as i64;
    if grown == 0 && old.len() == now.len() && old.iter().zip(now).all(|(a, b)| same_value(a, b)) {
        return None;
    }
    let mut delta = Map::new();
    if grown > 0 {
        // A log that only grew: the lines the new window keeps from before must be the old window's
        // last ones, checked line by line, so a new run's longer log is replaced, never spliced on.
        let kept = now.len().saturating_sub(grown as usize);
        let overlap = &now[..kept];
        let tail = &old[old.len().saturating_sub(kept)..];
        if overlap.len() == tail.len() && overlap.iter().zip(tail).all(|(a, b)| a == b) {
            delta.insert("append".into(), Value::Array(now[kept..].to_vec()));
            delta.insert("total".into(), Value::from(next.log_total));
            return Some(Value::Object(delta));
        }
    }
    delta.insert("replace".into(), Value::Array(now.to_vec()));
    delta.insert("total".into(), Value::from(next.log_total));
    Some(Value::Object(delta))
}

const ENTITY_KEYS: [&str; 3] = ["tickets", "conversations", "log"];

/// What changed from one pushed version to the next, or `None` when nothing did (no delta is sent and
/// the revision does not move). The delta's `rev` is `next.rev`.
pub fn diff_snapshot(prev: &Pushed, next: &Pushed) -> Option<Value> {
    let empty = Map::new();
    let prev_top = prev.snapshot.as_object().unwrap_or(&empty);
    let next_top = next.snapshot.as_object().unwrap_or(&empty);
    let mut delta = Map::new();
    delta.insert("base".into(), Value::from(prev.rev));
    delta.insert("rev".into(), Value::from(next.rev));
    let mut changed = false;

    let mut set = Map::new();
    let mut unset = Vec::new();
    let keys = prev_top
        .keys()
        .chain(next_top.keys().filter(|key| !prev_top.contains_key(*key)))
        .filter(|key| *key != "state");
    for key in keys {
        match next_top.get(key) {
            None => {
                if prev_top.contains_key(key) {
                    unset.push(Value::from(key.clone()));
                }
            }
            Some(value) => {
                if !same(prev_top.get(key), Some(value)) {
                    set.insert(key.clone(), value.clone());
                }
            }
        }
    }
    if !set.is_empty() {
        delta.insert("set".into(), Value::Object(set));
        changed = true;
    }
    if !unset.is_empty() {
        delta.insert("unset".into(), Value::Array(unset));
        changed = true;
    }

    let prev_state = prev_top
        .get("state")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let next_state = next_top
        .get("state")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut state = Map::new();
    for (key, value) in next_state {
        if ENTITY_KEYS.contains(&key.as_str()) {
            continue;
        }
        if !same(prev_state.get(key), Some(value)) {
            state.insert(key.clone(), value.clone());
        }
    }
    if !state.is_empty() {
        delta.insert("state".into(), Value::Object(state));
        changed = true;
    }

    let list = |state: &Map<String, Value>, key: &str| -> Vec<Value> {
        state
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    for key in ["tickets", "conversations"] {
        if let Some(entities) = diff_entities(&list(prev_state, key), &list(next_state, key)) {
            delta.insert(key.into(), entities);
            changed = true;
        }
    }
    if let Some(log) = diff_log(prev, next) {
        delta.insert("log".into(), log);
        changed = true;
    }
    changed.then_some(Value::Object(delta))
}

/// A snapshot frame: the pushed version whole, or the null snapshot of revision 0.
pub fn snapshot_frame(of: Option<&Pushed>) -> Result<String, serde_json::Error> {
    let mut frame = Map::new();
    frame.insert("type".into(), Value::from("snapshot"));
    match of {
        Some(pushed) => {
            frame.insert("rev".into(), Value::from(pushed.rev));
            frame.insert("logTotal".into(), Value::from(pushed.log_total));
            frame.insert("snapshot".into(), pushed.snapshot.clone());
        }
        None => {
            frame.insert("rev".into(), Value::from(0));
            frame.insert("logTotal".into(), Value::from(0));
            frame.insert("snapshot".into(), Value::Null);
        }
    }
    serde_json::to_string(&Value::Object(frame))
}

/// A frame of the given type with its fields after it, as one JSON text.
pub fn frame(kind: &str, fields: Map<String, Value>) -> String {
    let mut frame = Map::new();
    frame.insert("type".into(), Value::from(kind));
    frame.extend(fields);
    js::to_json(&Value::Object(frame))
}

/// index.html with the boot snapshot in a JSON script element ahead of `</head>`. Every `<` in the JSON
/// is escaped, so no ticket title or log line can close the element early.
pub fn embed_boot(html: &str, boot: &Value) -> Result<String, serde_json::Error> {
    let json = serde_json::to_string(boot)?.replace('<', "\\u003c");
    let tag = format!(r#"<script id="{EMBED_ELEMENT_ID}" type="application/json">{json}</script>"#);
    Ok(match html.find("</head>") {
        Some(at) => format!("{}{tag}{}", &html[..at], &html[at..]),
        None => format!("{tag}{html}"),
    })
}

// ---------------------------------------------------------------------------------------------------
// The client frame's envelope
// ---------------------------------------------------------------------------------------------------

/// A frame that is not this protocol's, with the TypeScript's reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A frame from the Console, its envelope checked.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientFrame {
    Hello {
        visible: bool,
        cards: Vec<Value>,
    },
    Visibility {
        visible: bool,
    },
    Subscribe {
        card: Value,
    },
    Unsubscribe {
        id: String,
    },
    Request {
        id: u64,
        kind: RequestKind,
        payload: Map<String, Value>,
    },
}

fn need(ok: bool, what: &str) -> Result<(), ProtocolError> {
    if ok {
        Ok(())
    } else {
        Err(ProtocolError(what.to_owned()))
    }
}

/// `Number.isSafeInteger(value) && value >= 0`.
pub fn is_id(value: Option<&Value>) -> bool {
    value.and_then(js::number_of).is_some_and(|n| {
        n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)
    })
}

fn is_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

fn string_or_undefined(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), js::string_of)
}

/// The text parsed as an envelope: a JSON object, or the reason it is not one.
pub fn envelope(text: &str) -> Result<Map<String, Value>, ProtocolError> {
    match js::parse(text) {
        Err(_) => Err(ProtocolError("frame is not JSON".into())),
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(ProtocolError("frame is not an object".into())),
    }
}

/// A frame from the Console, its envelope checked: the type, and the fields every message of that type
/// carries. A request's payload is the handler's to check, as the HTTP route checks its body.
pub fn decode_client_message(text: &str) -> Result<ClientFrame, ProtocolError> {
    let m = envelope(text)?;
    match m.get("type").and_then(Value::as_str) {
        Some("hello") => {
            need(
                m.get("protocol").is_some_and(Value::is_number),
                "hello without protocol",
            )?;
            need(
                m.get("visible").is_some_and(Value::is_boolean),
                "hello without visible",
            )?;
            let cards = match m.get("cards") {
                Some(Value::Array(cards))
                    if cards.iter().all(|card| {
                        is_object(Some(card)) && card.get("id").is_some_and(Value::is_string)
                    }) =>
                {
                    cards.clone()
                }
                _ => return Err(ProtocolError("hello without cards".into())),
            };
            Ok(ClientFrame::Hello {
                visible: m["visible"].as_bool().unwrap_or(true),
                cards,
            })
        }
        Some("visibility") => {
            let visible = m.get("visible").and_then(Value::as_bool);
            need(visible.is_some(), "visibility without visible")?;
            Ok(ClientFrame::Visibility {
                visible: visible.unwrap_or(true),
            })
        }
        Some("subscribe") => {
            let card = m.get("card");
            need(
                is_object(card) && card.and_then(|c| c.get("id")).is_some_and(Value::is_string),
                "subscribe without card",
            )?;
            Ok(ClientFrame::Subscribe {
                card: card.cloned().unwrap_or(Value::Null),
            })
        }
        Some("unsubscribe") => {
            let id = m.get("id").and_then(Value::as_str);
            need(id.is_some(), "unsubscribe without id")?;
            Ok(ClientFrame::Unsubscribe {
                id: id.unwrap_or("").to_owned(),
            })
        }
        Some("request") => {
            need(is_id(m.get("id")), "request without id")?;
            let kind = m
                .get("kind")
                .and_then(Value::as_str)
                .and_then(RequestKind::parse);
            let Some(kind) = kind else {
                return Err(ProtocolError(format!(
                    "unknown request {}",
                    string_or_undefined(m.get("kind"))
                )));
            };
            let Some(Value::Object(payload)) = m.get("payload") else {
                return Err(ProtocolError("request without payload".into()));
            };
            Ok(ClientFrame::Request {
                id: js::number_of(&m["id"]).unwrap_or(0.0) as u64,
                kind,
                payload: payload.clone(),
            })
        }
        _ => Err(ProtocolError(format!(
            "unknown message {}",
            string_or_undefined(m.get("type"))
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pushed(rev: u64, log_total: u64, snapshot: Value) -> Pushed {
        Pushed {
            rev,
            log_total,
            snapshot,
        }
    }

    fn snap(seq: u64, tickets: Value, log: Value) -> Value {
        json!({
            "seq": seq, "phase": "running", "poolName": "a/b", "poolTitle": null,
            "state": { "tickets": tickets, "conversations": [], "log": log, "outcomes": {}, "config": {} },
        })
    }

    #[test]
    fn says_nothing_changed_when_nothing_did() {
        let a = pushed(1, 1, snap(1, json!([{"id": "01", "x": 1}]), json!(["one"])));
        let b = pushed(2, 1, snap(1, json!([{"id": "01", "x": 1}]), json!(["one"])));
        assert_eq!(diff_snapshot(&a, &b), None);
    }

    #[test]
    fn carries_a_changed_ticket_alone_and_an_order_only_when_ids_moved() {
        let a = pushed(
            1,
            0,
            snap(
                1,
                json!([{"id": "01", "x": 1}, {"id": "02"}, {"id": "03"}]),
                json!([]),
            ),
        );
        let b = pushed(
            2,
            0,
            snap(
                1,
                json!([{"id": "01", "x": 2}, {"id": "02"}, {"id": "03"}]),
                json!([]),
            ),
        );
        assert_eq!(
            diff_snapshot(&a, &b),
            Some(json!({"base": 1, "rev": 2, "tickets": {"upsert": [{"id": "01", "x": 2}]}}))
        );
        let c = pushed(
            3,
            0,
            snap(
                1,
                json!([{"id": "02"}, {"id": "03"}, {"id": "01", "x": 2}]),
                json!([]),
            ),
        );
        assert_eq!(
            diff_snapshot(&b, &c),
            Some(json!({"base": 2, "rev": 3, "tickets": {"order": ["02", "03", "01"]}}))
        );
        let d = pushed(
            4,
            0,
            snap(1, json!([{"id": "02"}, {"id": "04"}]), json!([])),
        );
        assert_eq!(
            diff_snapshot(&c, &d),
            Some(
                json!({"base": 3, "rev": 4, "tickets": {"upsert": [{"id": "04"}], "remove": ["03", "01"], "order": ["02", "04"]}})
            )
        );
    }

    #[test]
    fn appends_new_pool_log_lines_and_counts_the_whole_log() {
        let a = pushed(1, 600, snap(1, json!([]), json!(["a", "b", "c"])));
        let b = pushed(2, 602, snap(1, json!([]), json!(["c", "d", "e"])));
        assert_eq!(
            diff_snapshot(&a, &b).unwrap()["log"],
            json!({"append": ["d", "e"], "total": 602})
        );
    }

    // protocol.test.ts:161
    #[test]
    fn replaces_a_log_that_did_not_simply_grow() {
        let a = pushed(1, 2, snap(1, json!([]), json!(["a", "b"])));
        let b = pushed(2, 3, snap(1, json!([]), json!(["x", "y", "z"])));
        assert_eq!(
            diff_snapshot(&a, &b).unwrap()["log"],
            json!({"replace": ["x", "y", "z"], "total": 3})
        );
        let shrunk = pushed(3, 1, snap(1, json!([]), json!(["n"])));
        assert_eq!(
            diff_snapshot(&b, &shrunk).unwrap()["log"],
            json!({"replace": ["n"], "total": 1})
        );
    }

    // protocol.test.ts:169
    #[test]
    fn replaces_a_changed_top_level_field_whole_and_unsets_one_that_went() {
        let mut a = snap(1, json!([]), json!([]));
        a["stewardBudget"] = json!({"budget": 5, "used": {}});
        let mut b = snap(2, json!([]), json!([]));
        b["phase"] = json!("done");
        let delta = diff_snapshot(&pushed(1, 0, a), &pushed(2, 0, b)).unwrap();
        assert_eq!(delta["set"], json!({"seq": 2, "phase": "done"}));
        assert_eq!(delta["unset"], json!(["stewardBudget"]));
    }

    #[test]
    fn replaces_a_changed_state_field_whole_and_leaves_the_rest_out() {
        let a = snap(1, json!([]), json!([]));
        let mut b = snap(1, json!([]), json!([]));
        b["state"]["outcomes"] = json!({"01": {"status": "done"}});
        assert_eq!(
            diff_snapshot(&pushed(1, 0, a), &pushed(2, 0, b)),
            Some(json!({"base": 1, "rev": 2, "state": {"outcomes": {"01": {"status": "done"}}}}))
        );
    }

    #[test]
    fn trims_the_log_to_its_window_and_counts_it_all() {
        let log: Vec<String> = (0..600).map(|i| i.to_string()).collect();
        let (lines, total) = trim_pool_log(&log, 500);
        assert_eq!((lines.len(), total, lines[0].as_str()), (500, 600, "100"));
        let (short, total) = trim_pool_log(&log[..3], 500);
        assert_eq!((short.len(), total), (3, 3));
    }

    #[test]
    fn embeds_the_boot_snapshot_with_every_angle_bracket_escaped() {
        let page = embed_boot(
            "<html><head></head><body></body></html>",
            &json!({"title": "</script>"}),
        )
        .unwrap();
        assert_eq!(
            page,
            "<html><head><script id=\"console-boot\" type=\"application/json\">{\"title\":\"\\u003c/script>\"}</script></head><body></body></html>"
        );
        assert!(
            embed_boot("<p>", &json!({}))
                .unwrap()
                .starts_with("<script")
        );
    }

    #[test]
    fn refuses_what_is_not_this_protocols() {
        let reason = |text: &str| decode_client_message(text).unwrap_err().0;
        assert_eq!(reason("nope"), "frame is not JSON");
        assert_eq!(reason("[1]"), "frame is not an object");
        assert_eq!(reason(r#"{"type":"nope"}"#), "unknown message nope");
        assert_eq!(reason(r#"{}"#), "unknown message undefined");
        assert_eq!(
            reason(r#"{"type":"request","id":1,"kind":"rm -rf","payload":{}}"#),
            "unknown request rm -rf"
        );
        assert_eq!(
            reason(r#"{"type":"request","kind":"stop","payload":{}}"#),
            "request without id"
        );
        assert_eq!(
            reason(r#"{"type":"request","id":1,"kind":"stop"}"#),
            "request without payload"
        );
        assert_eq!(reason(r#"{"type":"subscribe"}"#), "subscribe without card");
        assert_eq!(
            reason(r#"{"type":"hello","protocol":1,"visible":true,"cards":[{}]}"#),
            "hello without cards"
        );
        assert_eq!(
            decode_client_message(
                r#"{"type":"request","id":3,"kind":"terminal.focus","payload":{"ticketId":"01"}}"#
            ),
            Ok(ClientFrame::Request {
                id: 3,
                kind: RequestKind::TerminalFocus,
                payload: json!({"ticketId": "01"}).as_object().unwrap().clone(),
            })
        );
    }
}
