//! Round trips: representative JSON, in the key order the TypeScript server builds it, parses into the
//! Rust types and serializes back to the very same text.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::*;

const SNAPSHOT: &str = include_str!("../testdata/snapshot.json");

/// The JSON written compactly, keys in the order given.
fn compact(text: &str) -> String {
    let value: Value = serde_json::from_str(text).expect("fixture parses as JSON");
    serde_json::to_string(&value).unwrap()
}

/// Parse `text` as `T` and check it serializes back to the same JSON, key order included.
fn round_trip<T: Serialize + DeserializeOwned>(text: &str) -> T {
    let typed: T = serde_json::from_str(text).unwrap_or_else(|error| {
        panic!(
            "{} does not parse: {error}\n{text}",
            std::any::type_name::<T>()
        )
    });
    assert_eq!(
        serde_json::to_string(&typed).unwrap(),
        compact(text),
        "{}",
        std::any::type_name::<T>()
    );
    typed
}

fn refuses<T: DeserializeOwned + std::fmt::Debug>(text: &str) {
    if let Ok(typed) = serde_json::from_str::<T>(text) {
        panic!("{} took {text} as {typed:?}", std::any::type_name::<T>());
    }
}

#[test]
fn the_enriched_snapshot() {
    let snapshot: EnrichedSnapshot = round_trip(SNAPSHOT);
    assert_eq!(snapshot.state.tickets[1].status, TicketStatus::Checkpoint);
    assert_eq!(
        snapshot.state.conversations[0].role,
        Some(ConversationRole::Steward)
    );
    assert_eq!(
        snapshot.held_spawns[0].blocks,
        Some(SpawnBlocks::All(AllTickets::All))
    );
    assert_eq!(
        snapshot.state.outcomes["03"].spawn.as_ref().unwrap()[1].verify_ignored,
        Some(json::True)
    );
    assert_eq!(
        snapshot.state.queued_answers[1].action,
        Some(QueuedAnswerAction::Adopt)
    );
}

#[test]
fn a_snapshot_without_its_steward_budget_or_title() {
    let mut value: Value = serde_json::from_str(SNAPSHOT).unwrap();
    value.as_object_mut().unwrap().shift_remove("stewardBudget");
    value["poolTitle"] = Value::Null;
    let snapshot: EnrichedSnapshot = round_trip(&value.to_string());
    assert_eq!(snapshot.steward_budget, None);
    assert_eq!(snapshot.pool_title, None);
}

#[test]
fn the_snapshot_as_pushed_and_embedded() {
    let snapshot = compact(SNAPSHOT);
    round_trip::<PushedSnapshot>(&format!(
        r#"{{"rev":7,"logTotal":812,"snapshot":{snapshot}}}"#
    ));
    round_trip::<EmbeddedBoot>(&format!(
        r#"{{"protocol":1,"epoch":"e-1696","rev":7,"logTotal":812,"snapshot":{snapshot}}}"#
    ));
    round_trip::<EmbeddedBoot>(
        r#"{"protocol":1,"epoch":"e-1696","rev":0,"logTotal":0,"snapshot":null}"#,
    );
}

#[test]
fn server_frames() {
    let snapshot = compact(SNAPSHOT);
    let frames = [
        r#"{"type":"hello","protocol":1,"epoch":"8f2c","heartbeatMs":20000}"#.to_string(),
        r#"{"type":"snapshot","rev":0,"logTotal":0,"snapshot":null}"#.to_string(),
        format!(r#"{{"type":"snapshot","rev":3,"logTotal":2,"snapshot":{snapshot}}}"#),
        r#"{"type":"live","activity":{"01":{"ticketId":"01","running":true,"diff":{"added":12,"removed":3,"files":["a.ts","b.ts"]},"log":{"size":4096,"mtime":"2026-10-04T09:00:00.000Z"},"lastEventAt":"2026-10-04T09:00:01.000Z"}},"peeks":{"01":{"ticket":"01","paneId":"p-7","text":"$ "},"02":{"ticket":"02","error":"pane unavailable"}},"grades":{"03":{"attempt":2,"score":7.5,"verdict":"pass","winner":2},"04":{"attempt":1,"score":8,"verdict":"flag","winner":null}}}"#.to_string(),
        r#"{"type":"live","grades":{}}"#.to_string(),
        r#"{"type":"card","id":"conv-1","body":null,"events":{"events":[{"at":"2026-10-04T09:00:00.000Z","attempt":1,"kind":"spawned","payload":{"cwd":"/tmp/w","paneId":"p-9"}}],"attempts":[],"reconstructed":false,"spec":""},"log":null}"#.to_string(),
        r##"{"type":"card","id":"01","body":{"id":"01","body":"# 01: Port\n\nDo it.\n"},"events":{"events":[],"attempts":[{"attempt":1,"logFile":"01.attempt-1.log","modifiedAt":"2026-10-04T08:00:00.000Z"}],"reconstructed":true,"spec":"Do it."}}"##.to_string(),
        r#"{"type":"card","id":"01","log":{"mode":"window","attempt":2,"stream":false,"content":"hello\n","offset":0,"nextOffset":6,"totalSize":6,"attempts":[{"attempt":1,"kind":"implement","current":false,"logFile":"01.attempt-1.log","streamFile":"01.attempt-1.stream.jsonl"},{"attempt":2,"kind":"implement","current":true,"logFile":"01.attempt-2.log","streamFile":null}]}}"#.to_string(),
        r#"{"type":"card","id":"01","log":{"mode":"append","attempt":2,"stream":false,"content":"more\n","offset":6,"nextOffset":11,"totalSize":11}}"#.to_string(),
        r#"{"type":"card","id":"zz","error":"unknown ticket zz"}"#.to_string(),
        r#"{"type":"reply","id":3,"kind":"terminal.focus","rev":9,"ok":false,"refusal":{"reason":"no terminal-backed pane for ticket 01","status":404}}"#.to_string(),
        r#"{"type":"reply","id":4,"kind":"start","rev":9,"ok":true,"result":{}}"#.to_string(),
        r#"{"type":"reply","id":5,"kind":"stop","rev":10,"ok":true,"result":{"stopping":true}}"#.to_string(),
        r#"{"type":"reply","id":6,"kind":"restart","rev":10,"ok":true,"result":{"ok":true,"port":8787}}"#.to_string(),
        r#"{"type":"reply","id":7,"kind":"terminal.focus","rev":10,"ok":true,"result":{"ok":true,"paneId":"p-7"}}"#.to_string(),
        r#"{"type":"reply","id":8,"kind":"reassign","rev":11,"ok":true,"result":{"applied":["01"],"skipped":[{"id":"02","reason":"an Attempt is in flight"}]}}"#.to_string(),
        r#"{"type":"reply","id":9,"kind":"enlist","rev":11,"ok":true,"result":{"conversationId":"enlist-2"}}"#.to_string(),
        r#"{"type":"reply","id":10,"kind":"keepTalking","rev":11,"ok":true,"result":{"ticketId":"02","attempt":2}}"#.to_string(),
        r#"{"type":"reply","id":11,"kind":"terminals.closeFinished","rev":11,"ok":true,"result":{"closed":3}}"#.to_string(),
        r#"{"type":"reply","id":12,"kind":"poolLog.read","rev":11,"ok":true,"result":{"start":0,"lines":["a","b"],"total":2}}"#.to_string(),
        r#"{"type":"reply","id":13,"kind":"log.follow","rev":11,"ok":true,"result":{"content":"","offset":0,"nextOffset":0,"totalSize":0,"attempts":[{"attempt":1,"kind":"reconstructed","current":true,"logFile":"01.log","streamFile":null}],"attempt":1,"stream":false}}"#.to_string(),
        r#"{"type":"reply","id":14,"kind":"panes.list","rev":11,"ok":true,"result":{"panes":[{"paneId":"p-1","harness":"claude","status":"idle","title":"","directory":"/w","branch":null,"eligible":false,"reason":"the pane's directory has no branch checked out"}]}}"#.to_string(),
        r#"{"type":"reply","id":15,"kind":"spawns.held.adopt","rev":11,"ok":true,"result":{"id":"01-spawn-3"}}"#.to_string(),
        r#"{"type":"reply","id":16,"kind":"resume","rev":12,"ok":false,"refusal":{"reason":"could not encode the result: cyclic","status":500}}"#.to_string(),
        r#"{"type":"heartbeat"}"#.to_string(),
    ];
    for frame in &frames {
        round_trip::<ServerMessage>(frame);
    }
}

#[test]
fn a_delta_with_every_part() {
    let delta = r#"{"type":"delta","delta":{"base":4,"rev":5,"set":{"seq":43,"poolTitle":null,"spawnUsage":{"spawnedThisRun":4,"perAttempt":5,"perRun":20}},"unset":["stewardBudget"],"state":{"interrupts":[],"config":{"title":"x"}},"tickets":{"upsert":[{"id":"04","title":"New","blockedBy":[],"status":"ready","mergeState":null,"assignment":{"harness":null,"model":null,"drivers":"implement"},"liveAttempt":null,"heldPane":null,"enlisted":false,"reassign":{"eligible":true,"reason":null,"verify":null,"sources":{"harness":"default","model":"default","effort":"unset","drivers":"default"}}}],"remove":["02"],"order":["01","03","04"]},"conversations":{"order":["conv-1"]},"log":{"append":["[09:40:00] 04 ready"],"total":813}}}"#;
    let ServerMessage::Delta(frame) = round_trip::<ServerMessage>(delta) else {
        panic!("not a delta")
    };
    assert_eq!(frame.delta.set.as_ref().unwrap().pool_title, Some(None));
    assert_eq!(frame.delta.unset, Some(vec![SnapshotTopKey::StewardBudget]));
    round_trip::<SnapshotDelta>(r#"{"base":5,"rev":6,"log":{"replace":["fresh"],"total":1}}"#);
    round_trip::<SnapshotDelta>(r#"{"base":6,"rev":7,"set":{"poolTitle":"Named"}}"#);
}

#[test]
fn client_frames() {
    let frames = [
        r#"{"type":"hello","protocol":1,"visible":true,"cards":[{"id":"01"},{"id":"02","follow":{"attempt":null,"stream":true}}]}"#,
        r#"{"type":"visibility","visible":false}"#,
        r#"{"type":"subscribe","card":{"id":"01","follow":{"attempt":2,"stream":false}}}"#,
        r#"{"type":"unsubscribe","id":"01"}"#,
        r#"{"type":"request","id":1,"kind":"start","payload":{}}"#,
        r#"{"type":"request","id":2,"kind":"resume","payload":{"ticketId":"05","action":"adopt","note":"two","attempt":2}}"#,
        r#"{"type":"request","id":3,"kind":"terminal.focus","payload":{"ticketId":"01"}}"#,
        r#"{"type":"request","id":4,"kind":"enlist","payload":{"becomes":"ticket","paneId":"p-1","title":"Found","spec":"Do it.","blocks":["02"]}}"#,
        r#"{"type":"request","id":5,"kind":"reassign","payload":{"tickets":["01","02"],"fields":{"model":"x-model","effort":null,"verify":2}}}"#,
        r#"{"type":"request","id":6,"kind":"conversations.start","payload":{"title":"Steward","opening":"Keep it moving.","role":"steward","assign":{"model":"haiku"}}}"#,
        r#"{"type":"request","id":7,"kind":"conversations.end","payload":{"id":"conv-1","closing":"Thanks."}}"#,
        r#"{"type":"request","id":8,"kind":"settings.pool.put","payload":{"config":{"title":"Rust port","port":null}}}"#,
        r#"{"type":"request","id":9,"kind":"settings.machine.put","payload":{"defaults":{"harness":"claude","model":"opus","terminal":"herdr"}}}"#,
        r#"{"type":"request","id":10,"kind":"log.read","payload":{"id":"01","attempt":1,"offset":0,"end":4096,"stream":true}}"#,
        r#"{"type":"request","id":11,"kind":"log.follow","payload":{"id":"01","attempt":null,"stream":false}}"#,
        r#"{"type":"request","id":12,"kind":"poolLog.read","payload":{"before":500,"limit":200}}"#,
        r#"{"type":"request","id":13,"kind":"spawns.pending.hold","payload":{"id":"01-spawn-2"}}"#,
        r#"{"type":"request","id":14,"kind":"keepTalking","payload":{"ticketId":"02"}}"#,
    ];
    for frame in frames {
        round_trip::<ClientMessage>(frame);
    }
    let ClientMessage::Request(frame) = round_trip::<ClientMessage>(frames[8]) else {
        panic!("not a request")
    };
    let Request::Reassign(reassign) = frame.request else {
        panic!("not a reassign")
    };
    assert_eq!(reassign.fields.harness, None);
    assert_eq!(reassign.fields.effort, Some(None));
    assert_eq!(reassign.fields.model, Some(Some("x-model".to_string())));
}

#[test]
fn frames_that_are_not_this_protocols() {
    refuses::<ClientMessage>(r#"{"type":"nope"}"#);
    refuses::<ClientMessage>(r#"{"type":"request","id":1,"kind":"rm -rf","payload":{}}"#);
    refuses::<ClientMessage>(r#"{"type":"request","kind":"stop","payload":{}}"#);
    refuses::<ClientMessage>(r#"{"type":"request","id":-1,"kind":"stop","payload":{}}"#);
    refuses::<ClientMessage>(r#"{"type":"subscribe"}"#);
    refuses::<ServerMessage>(
        r#"{"type":"reply","id":1,"kind":"stop","rev":1,"ok":true,"result":{"stopping":false}}"#,
    );
    refuses::<ServerMessage>(r#"{"type":"reply","id":1,"kind":"stop","rev":1,"ok":false}"#);
}

#[test]
fn a_reply_names_its_kind() {
    let reply = Reply {
        id: 1,
        kind: RequestKind::Stop,
        rev: 2,
        outcome: Ok(RequestResult::Stop(StopResult {
            stopping: json::True,
        })),
    };
    assert_eq!(
        serde_json::to_string(&ServerMessage::Reply(reply)).unwrap(),
        r#"{"type":"reply","id":1,"kind":"stop","rev":2,"ok":true,"result":{"stopping":true}}"#
    );
    assert_eq!(RequestKind::TerminalFocus.as_str(), "terminal.focus");
    assert_eq!(
        RequestKind::TerminalFocus.http_twin(),
        "POST /api/terminal/focus?ticket="
    );
    assert!(!RequestKind::SettingsGet.is_action());
    assert_eq!(
        RequestKind::ALL
            .iter()
            .filter(|kind| kind.is_action())
            .count(),
        17
    );
}

#[test]
fn per_ticket_reads() {
    round_trip::<TicketEventsResponse>(
        r#"{"events":[{"at":"2026-10-04T09:00:00.000Z","attempt":1,"kind":"exited","payload":{"code":0,"logTail":"bye"}},{"at":"2026-10-04T09:01:00.000Z","attempt":1,"kind":"graded","payload":{"grade":{"score":7.25,"verdict":"pass","reasons":"ok"}}}],"attempts":[],"reconstructed":false,"spec":"Do it."}"#,
    );
    round_trip::<TicketLogResponse>(
        r#"{"content":"x","offset":10,"nextOffset":11,"totalSize":11,"attempts":[{"attempt":3,"kind":"resolver","current":true,"logFile":"01.resolver-3.log","streamFile":null}]}"#,
    );
    round_trip::<TicketActivityResponse>(
        r#"{"ticketId":"02","running":false,"diff":null,"log":null,"lastEventAt":null}"#,
    );
    round_trip::<TicketGradeSummary>(r#"{"attempt":1,"score":6,"verdict":"flag","winner":null}"#);
    round_trip::<TicketBodyResponse>(r#"{"id":"01","body":""}"#);
    round_trip::<TerminalPeekResponse>(r#"{"ticket":"01","paneId":"p-7","text":""}"#);
    round_trip::<KeepTalkingResponse>(r#"{"ticketId":"02","attempt":2}"#);
    round_trip::<CloseFinishedTerminalsResponse>(r#"{"closed":0}"#);
    round_trip::<HeldSpawnResponse>(r#"{"id":"01-spawn-3"}"#);
    round_trip::<PendingSpawnResponse>(r#"{"id":"01-spawn-2"}"#);
    round_trip::<TerminalFocusResponse>(r#"{"ok":true,"paneId":"p-7"}"#);
}

#[test]
fn settings() {
    let settings: SettingsResponse = round_trip(
        r#"{"pool":{"path":"/p/console.json","config":{"defaults":{"harness":"claude"},"port":"8788","notes":"hand edit"},"bootOnly":["selection","terminal","port"],"effective":{"port":8787,"terminal":null,"stale":["port"]}},"machine":{"path":"/h/.config/agent-console/defaults.json","defaults":{"harness":"claude","model":"opus","engine":"/repo"},"own":{"harness":"claude","effort":"high","terminal":"herdr"}},"harnesses":["claude","codex","cursor","opencode"]}"#,
    );
    // A hand edit the TypeScript passes through unchecked stays as written.
    assert!(settings.pool.config.parse().is_err());
    round_trip::<RestartResponse>(r#"{"ok":true,"port":null}"#);
    round_trip::<PoolSettingsRequest>(
        r#"{"config":{"title":"","steward":{"budget":3,"mayClose":true}}}"#,
    );
    round_trip::<MachineDefaultsRequest>(r#"{"defaults":{}}"#);
}

#[test]
fn pool_config_as_console_json_writes_it() {
    let config: PoolConfig = round_trip(
        r#"{"defaults":{"harness":"claude","model":"opus","effort":"high","drivers":"implement"},"assign":{"01":{"model":"sonnet","verify":2}},"resolver":{"harness":"codex","model":"gpt-5"},"port":8787,"spawnCaps":{"perRun":10},"selection":"human","terminal":"herdr","reviewer":"Be strict.","checkpoint":"Ask early.","title":"Pool A","steward":{"budget":5,"assign":{"model":"haiku"},"mayClose":false}}"#,
    );
    assert_eq!(
        config.resolver,
        Some(ResolverConfig::Assignment(ResolverAssignment {
            harness: Some("codex".to_string()),
            model: Some("gpt-5".to_string()),
            effort: None,
        }))
    );
    round_trip::<PoolConfig>(r#"{"resolver":"none"}"#);
    round_trip::<PoolConfig>(r#"{}"#);
}

#[test]
fn reassign() {
    let snapshot = compact(SNAPSHOT);
    round_trip::<ReassignResponse>(&format!(
        r#"{{"applied":["01"],"skipped":[],"snapshot":{snapshot}}}"#
    ));
    round_trip::<StewardReassignRequest>(
        r#"{"tickets":["01"],"fields":{"harness":null},"conversation":"conv-1"}"#,
    );
}

#[test]
fn enlist() {
    let requests = [
        r#"{"becomes":"ticket","paneId":"p-1","title":"Found","spec":""}"#,
        r#"{"becomes":"conversation","paneId":"p-2","title":"Talk","opening":"Hi."}"#,
        r#"{"becomes":"steward","paneId":"p-3"}"#,
    ];
    let parsed: Vec<EnlistRequest> = requests.iter().map(|text| round_trip(text)).collect();
    assert!(matches!(parsed[0], EnlistRequest::Ticket(_)));
    assert!(matches!(parsed[1], EnlistRequest::Conversation(_)));
    assert!(matches!(parsed[2], EnlistRequest::Steward(_)));
    refuses::<EnlistRequest>(r#"{"becomes":"crew","paneId":"p-3"}"#);
    round_trip::<EnlistResponse>(r#"{"ticketId":"enlist-1"}"#);
    round_trip::<EnlistResponse>(r#"{"conversationId":"enlist-2"}"#);
    round_trip::<PanesResponse>(r#"{"panes":[]}"#);
}

#[test]
fn the_steward() {
    round_trip::<StewardActionResponse>(r#"{"ok":true,"message":"answered 02: resume"}"#);
    round_trip::<StewardAnswerRequest>(
        r#"{"conversation":"conv-1","ticketId":"02","action":"close","note":"done"}"#,
    );
    round_trip::<StewardEndRequest>(r#"{"conversation":"conv-1"}"#);
    round_trip::<StewardHeldRequest>(
        r#"{"conversation":"conv-1","action":"discard","id":"01-spawn-3"}"#,
    );
    round_trip::<StewardKeepTalkingRequest>(
        r#"{"conversation":"conv-1","ticketId":"02","message":"go on"}"#,
    );
    round_trip::<StewardLeaveRequest>(
        r#"{"conversation":"conv-1","ticketId":"02","note":"yours"}"#,
    );
    round_trip::<StewardStateResponse>(
        r#"{"steward":"conv-1","budget":5,"mayClose":false,"phase":"running","interrupts":[{"ticketId":"02","title":"","kind":"checkpoint","answerable":true,"keepTalking":true,"queued":false,"note":null,"used":1,"remaining":4},{"ticketId":"conv-2","title":null,"kind":"merge-approval","answerable":false,"keepTalking":false,"queued":true,"note":"wait","used":0,"remaining":5}],"mergeQueue":[{"ticketId":"03","state":"queued"}],"pendingSpawns":[{"id":"01-spawn-2","parentId":"01","title":"Tidy up"}],"heldSpawns":[{"id":"01-spawn-3","parentId":"01","title":"Follow up","reason":"per-run"}],"ledger":"/p/runs/spawn-ledger.md"}"#,
    );
    round_trip::<StewardConfig>(r#"{"budget":0}"#);
}

#[test]
fn requests_from_the_console_and_the_cli() {
    round_trip::<StartConversationRequest>(
        r#"{"title":"Child","spawnedBy":"conv-1","id":"conv-1-spawn-1"}"#,
    );
    round_trip::<ResumeRequest>(r#"{"ticketId":"02","action":"resume"}"#);
    round_trip::<KeepTalkingRequest>(r#"{"ticketId":"02"}"#);
    round_trip::<HeldSpawnRequest>(r#"{"id":"x"}"#);
    round_trip::<PendingSpawnRequest>(r#"{"id":"x"}"#);
    round_trip::<EndConversationRequest>(r#"{"id":"conv-1"}"#);
    round_trip::<LogReadRequest>(r#"{"id":"01","offset":0}"#);
    round_trip::<PoolLogReadRequest>(r#"{"before":0}"#);
    round_trip::<CardSubscription>(r#"{"id":"01"}"#);
    round_trip::<Refusal>(r#"{"reason":"pool not started","status":409}"#);
    round_trip::<Grade>(
        r#"{"score":8,"verdict":"pass","reasons":"good","rubric":"jev-grader-rubric/2026-09-20.1","model":"m","evidenceBudget":"widened"}"#,
    );
}

#[test]
fn every_string_union_reads_its_own_strings() {
    for kind in TicketEventKind::ALL {
        assert_eq!(TicketEventKind::parse(kind.as_str()), Some(*kind));
        assert_eq!(
            serde_json::to_value(kind).unwrap(),
            Value::String(kind.as_str().to_string())
        );
    }
    assert_eq!(TicketEventKind::ALL.len(), 36);
    assert_eq!(
        TicketStatus::parse("in-progress"),
        Some(TicketStatus::InProgress)
    );
    assert_eq!(TicketStatus::parse("blocked"), None);
    assert_eq!(InterruptKind::MergeApproval.to_string(), "merge-approval");
}

// ---------------------------------------------------------------------------
// What the Bun server really sent: a two-ticket pool run through a checkpoint, a
// settings save, a Reassign and a resume to its Review gate, captured with the
// conformance harness (testdata/bun).
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
struct StateAnswer {
    snapshot: Option<EnrichedSnapshot>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct GradesAnswer {
    grades: indexmap::IndexMap<String, TicketGradeSummary>,
}

#[test]
fn every_frame_the_bun_server_sent() {
    let frames = include_str!("../testdata/bun/frames.jsonl");
    let mut kinds = std::collections::BTreeSet::new();
    for line in frames.lines().filter(|line| !line.is_empty()) {
        round_trip::<ServerMessage>(line);
        let value: Value = serde_json::from_str(line).unwrap();
        kinds.insert(value["type"].as_str().unwrap().to_string());
    }
    let seen: Vec<&str> = kinds.iter().map(String::as_str).collect();
    assert_eq!(
        seen,
        ["card", "delta", "hello", "live", "reply", "snapshot"]
    );
}

#[test]
fn every_body_the_bun_server_sent() {
    round_trip::<StateAnswer>(include_str!("../testdata/bun/state-checkpoint.json"));
    let settled: StateAnswer = round_trip(include_str!("../testdata/bun/state-settled.json"));
    assert_eq!(settled.snapshot.unwrap().phase, RunPhase::Quiescent);
    round_trip::<SettingsResponse>(include_str!("../testdata/bun/settings.json"));
    round_trip::<TicketEventsResponse>(include_str!("../testdata/bun/events-01.json"));
    round_trip::<TicketEventsResponse>(include_str!("../testdata/bun/events-02.json"));
    round_trip::<TicketActivityResponse>(include_str!("../testdata/bun/activity-01.json"));
    round_trip::<GradesAnswer>(include_str!("../testdata/bun/grades.json"));
    round_trip::<TicketBodyResponse>(include_str!("../testdata/bun/ticket-01.json"));
    round_trip::<PoolLogRange>(include_str!("../testdata/bun/pool-log.json"));
}
