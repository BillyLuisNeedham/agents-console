//! The TypeScript the Console and the conformance suite import, generated from the Rust types: wire.ts
//! and protocol.ts, with the names, shapes, constants and doc comments of engine/wire.ts and
//! engine/protocol.ts and nothing but shapes and constants (ADR-0036). At the flip these files replace
//! the hand-written ones; until then a test holds the two to the same types.

use crate::protocol::*;
use crate::ts::{Decl, DeclBody, TsDecl, print_decl};
use crate::wire::*;

/// One generated file: its name, its text, and what it exports.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedFile {
    pub name: &'static str,
    pub text: String,
    pub exports: Vec<Export>,
}

/// One name a generated file exports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Export {
    pub name: String,
    pub kind: ExportKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportKind {
    /// A type with no parameters.
    Type,
    /// A type with type parameters.
    Generic,
    /// A value.
    Const,
}

impl Export {
    fn of(decl: &Decl) -> Export {
        let kind = match &decl.body {
            DeclBody::Const { .. } => ExportKind::Const,
            DeclBody::Interface { generics, .. } | DeclBody::Alias { generics, .. }
                if !generics.is_empty() =>
            {
                ExportKind::Generic
            }
            DeclBody::Text(text) if text.contains(&format!("{}<", decl.name)) => {
                ExportKind::Generic
            }
            _ => ExportKind::Type,
        };
        Export {
            name: decl.name.clone(),
            kind,
        }
    }
}

/// Every generated file: wire.ts, then protocol.ts, which imports its types from wire.ts.
pub fn generate() -> Vec<GeneratedFile> {
    vec![wire_file(), protocol_file()]
}

const WIRE_HEADER: &str = "/**
 * The wire shapes (CONTEXT.md: Wire shape): every message between engine and
 * Console, declared once. The Console type-imports them (`import type` only),
 * which makes drift between the two a compile error rather than a silent copy.
 *
 * Generated from the Rust types in crates/protocol by
 * `cargo run -p ac-protocol --bin gen-typescript -- <dir>` (ADR-0036): change
 * the Rust, not this file.
 */
";

const PROTOCOL_HEADER: &str = "/**
 * The Console's push protocol (issue #161, ADR-0032): the one WebSocket at
 * `/api/ws` the Console and its pool server talk over, declared once. It holds
 * shapes and constants only; the code that works on them is ui/src/protocol.ts.
 *
 * The socket carries four things. The pool snapshot: whole when the socket
 * opens, then as deltas keyed by ticket and Conversation id, every version
 * numbered by a server-side revision. The live values nothing else pushes
 * (activity, terminal peeks, grades), sent only when they change. The
 * subscribed cards' data (body, events, log tail and its appends). And
 * requests with replies, one per HTTP action or read the Console used to
 * fetch, each answered under its own id with the route's existing response
 * type or one refusal shape.
 *
 * Generated from the Rust types in crates/protocol by
 * `cargo run -p ac-protocol --bin gen-typescript -- <dir>` (ADR-0036): change
 * the Rust, not this file.
 */
";

/// A section banner, as the hand-written files divide themselves.
fn section(title: &str) -> String {
    let rule = "// ---------------------------------------------------------------------------";
    format!("{rule}\n// {title}\n{rule}\n")
}

/// A declaration and whether the file exports it.
type Entry = (Decl, bool);

fn exported<T: TsDecl>() -> Entry {
    (T::decl(), true)
}

fn local<T: TsDecl>() -> Entry {
    (T::decl(), false)
}

fn wire_sections() -> Vec<(&'static str, Vec<Entry>)> {
    vec![
        (
            "Ticket events",
            vec![exported::<TicketEvent>(), exported::<TicketEventKind>()],
        ),
        (
            "Conversations",
            vec![
                exported::<ConversationStatus>(),
                exported::<TurnSide>(),
                exported::<ConversationRole>(),
                exported::<ConversationView>(),
                exported::<NoticeDelivery>(),
                exported::<StartConversationRequest>(),
            ],
        ),
        (
            "The run, Interrupts, Outcomes and Grades",
            vec![
                exported::<EvidenceBudget>(),
                exported::<Grade>(),
                exported::<Interrupt>(),
                exported::<InterruptKind>(),
                exported::<Outcome>(),
                exported::<OutcomeStatus>(),
                local::<SpawnProposal>(),
                local::<SpawnAssignRequest>(),
                exported::<RunPhase>(),
                exported::<SpawnUsage>(),
                exported::<PoolConfig>(),
                local::<AssignmentDefaults>(),
                local::<TicketAssignment>(),
                local::<SpawnCapsConfig>(),
            ],
        ),
        (
            "Tickets, Assignments and live Attempts",
            vec![
                exported::<TicketStatus>(),
                exported::<AssignmentView>(),
                exported::<AttemptRole>(),
                exported::<LiveAttemptRecord>(),
                exported::<HeldPaneRecord>(),
            ],
        ),
        (
            "Spawn proposals",
            vec![
                exported::<HeldSpawnReason>(),
                exported::<PendingSpawnView>(),
                exported::<HeldSpawnView>(),
            ],
        ),
        (
            "The Merge queue and Queued answers",
            vec![
                exported::<MergeQueueEntry>(),
                exported::<MergeQueueState>(),
                exported::<QueuedAnswer>(),
                exported::<AnswerBy>(),
            ],
        ),
        (
            "Enlist",
            vec![
                exported::<EnlistPane>(),
                exported::<PanesResponse>(),
                exported::<EnlistRequest>(),
                local::<EnlistTicketRequest>(),
                local::<EnlistConversationWireRequest>(),
                exported::<EnlistStewardWireRequest>(),
                exported::<EnlistResponse>(),
            ],
        ),
        (
            "The Steward",
            vec![
                exported::<StewardActionResponse>(),
                exported::<StewardAnswerRequest>(),
                exported::<StewardAssign>(),
                exported::<StewardBudgetView>(),
                exported::<StewardConfig>(),
                exported::<StewardEndRequest>(),
                exported::<StewardHeldRequest>(),
                exported::<StewardKeepTalkingRequest>(),
                exported::<StewardLeaveRequest>(),
                exported::<StewardNote>(),
                exported::<StewardReassignRequest>(),
                exported::<StewardStateInterrupt>(),
                exported::<StewardStateResponse>(),
            ],
        ),
        (
            "The Settings pane",
            vec![
                exported::<MachineDefaultsRequest>(),
                exported::<MachineDefaultsView>(),
                exported::<MachineDefaults>(),
                exported::<PoolSettingsRequest>(),
                exported::<PoolSettingsView>(),
                exported::<RestartResponse>(),
                exported::<SettingsResponse>(),
            ],
        ),
        (
            "Reassign",
            vec![
                exported::<AssignmentSource>(),
                exported::<AssignmentSources>(),
                exported::<ReassignRequest>(),
                exported::<ReassignResponse>(),
                exported::<TicketReassignView>(),
            ],
        ),
        (
            "Resume (POST /api/resume)",
            vec![exported::<ResumeAction>()],
        ),
        (
            "The snapshot (GET /api/state, POST /api/start and /api/resume, the socket)",
            vec![
                exported::<EnrichedTicketState>(),
                exported::<EnrichedSnapshot>(),
            ],
        ),
        (
            "Ticket events (GET /api/events)",
            vec![
                exported::<ReconstructedAttempt>(),
                exported::<TicketEventsResponse>(),
            ],
        ),
        (
            "Ticket log (GET /api/log)",
            vec![
                exported::<LogAttemptInfo>(),
                exported::<TicketLogResponse>(),
            ],
        ),
        (
            "Ticket activity (GET /api/activity)",
            vec![exported::<TicketActivityResponse>()],
        ),
        (
            "Grades (GET /api/grades)",
            vec![exported::<TicketGradeSummary>()],
        ),
        (
            "Ticket body (GET /api/ticket)",
            vec![exported::<TicketBodyResponse>()],
        ),
        (
            "Keep talking (POST /api/keep-talking)",
            vec![
                exported::<KeepTalkingRequest>(),
                exported::<KeepTalkingResponse>(),
            ],
        ),
        (
            "Close finished terminals (POST /api/terminals/close-finished)",
            vec![exported::<CloseFinishedTerminalsResponse>()],
        ),
        (
            "Held spawns (POST /api/spawns/held/adopt, /api/spawns/held/discard)",
            vec![
                exported::<HeldSpawnRequest>(),
                exported::<HeldSpawnResponse>(),
            ],
        ),
        (
            "Pending spawns (POST /api/spawns/pending/hold, /api/spawns/pending/discard)",
            vec![
                exported::<PendingSpawnRequest>(),
                exported::<PendingSpawnResponse>(),
            ],
        ),
        (
            "Terminal peek (GET /api/terminal/peek)",
            vec![exported::<TerminalPeekResponse>()],
        ),
    ]
}

fn protocol_sections() -> Vec<(&'static str, Vec<Entry>)> {
    let constants = |decls: Vec<Decl>| {
        decls
            .into_iter()
            .map(|decl| (decl, true))
            .collect::<Vec<_>>()
    };
    let mut requests = vec![
        exported::<Empty>(),
        exported::<ResumeRequest>(),
        exported::<TerminalFocusRequest>(),
        exported::<TerminalFocusResponse>(),
        exported::<EndConversationRequest>(),
        exported::<LogReadRequest>(),
        exported::<LogFollow>(),
        exported::<LogFollowRequest>(),
        exported::<LogFollowResult>(),
        exported::<PoolLogReadRequest>(),
        exported::<PoolLogRange>(),
        exported::<RequestsDecl>(),
        exported::<RequestKind>(),
    ];
    requests.extend(ts_request_aliases());
    requests.extend(constants(ts_request_constants()));
    requests.push(exported::<Refusal>());
    let mut messages = vec![
        exported::<CardSubscription>(),
        exported::<LogPush>(),
        exported::<PeekFailure>(),
        exported::<ClientMessage>(),
        exported::<ServerMessage>(),
    ];
    let mut seam = Vec::new();
    for (decl, export) in ts_socket_declarations() {
        if decl.name == "Reply" {
            messages.push((decl, export));
        } else {
            seam.push((decl, export));
        }
    }
    vec![
        ("Constants", constants(ts_constants())),
        ("The snapshot as pushed", vec![exported::<PushedSnapshot>()]),
        (
            "The delta",
            vec![
                exported::<EntityDeltaDecl>(),
                exported::<PoolLogDelta>(),
                exported::<SnapshotDelta>(),
            ],
        ),
        ("Requests and replies", requests),
        ("Messages", messages),
        (
            "The first snapshot, embedded in the page",
            vec![exported::<EmbeddedBoot>()],
        ),
        ("The socket seam", seam),
    ]
}

fn render(header: &str, imports: &str, sections: &[(&'static str, Vec<Entry>)]) -> String {
    let mut text = header.to_string();
    if !imports.is_empty() {
        text.push('\n');
        text.push_str(imports);
    }
    for (title, entries) in sections {
        text.push('\n');
        text.push_str(&section(title));
        for (decl, export) in entries {
            text.push('\n');
            text.push_str(&print_decl(decl, *export));
        }
    }
    text
}

fn exports_of(sections: &[(&'static str, Vec<Entry>)]) -> Vec<Export> {
    sections
        .iter()
        .flat_map(|(_, entries)| {
            entries
                .iter()
                .filter(|(_, export)| *export)
                .map(|(decl, _)| Export::of(decl))
        })
        .collect()
}

fn wire_file() -> GeneratedFile {
    let sections = wire_sections();
    GeneratedFile {
        name: "wire.ts",
        text: render(WIRE_HEADER, "", &sections),
        exports: exports_of(&sections),
    }
}

fn protocol_file() -> GeneratedFile {
    let sections = protocol_sections();
    let body = render("", "", &sections);
    // Import exactly the wire names the body uses, so a strict `noUnusedLocals` build stays clean.
    let mut names: Vec<String> = wire_file()
        .exports
        .into_iter()
        .map(|export| export.name)
        .filter(|name| mentions(&body, name))
        .collect();
    names.sort();
    let imports = format!(
        "import type {{\n{}}} from \"./wire.ts\";\n",
        names
            .iter()
            .map(|name| format!("  {name},\n"))
            .collect::<String>()
    );
    GeneratedFile {
        name: "protocol.ts",
        text: render(PROTOCOL_HEADER, &imports, &sections),
        exports: exports_of(&sections),
    }
}

/// Whether `text` names `name` as a whole identifier.
fn mentions(text: &str, name: &str) -> bool {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
    text.match_indices(name).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + name.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declares_each_name_once() {
        for file in generate() {
            let mut names: Vec<&str> = file
                .exports
                .iter()
                .map(|export| export.name.as_str())
                .collect();
            names.sort();
            names.dedup();
            assert_eq!(
                names.len(),
                file.exports.len(),
                "{} exports a name twice",
                file.name
            );
        }
    }

    #[test]
    fn imports_only_what_protocol_uses() {
        let protocol = &generate()[1];
        assert!(protocol.text.contains("  EnrichedSnapshot,\n"));
        assert!(!protocol.text.contains("  StewardHeldRequest,\n"));
        assert!(mentions("a: Foo;", "Foo"));
        assert!(!mentions("a: FooBar;", "Foo"));
    }
}
