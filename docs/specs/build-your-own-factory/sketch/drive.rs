//! crates/engine/src/drive.rs (sketch, rewritten): the rolling scheduler, one for every pool.
//!
//! There is no super-step. The drive is a loop of ticks. A tick is one actor job that does, in
//! order, what the old boundary did, then launches every eligible Ticket, then waits for the next
//! wake. Anything that can change eligibility or the Line wakes it: an attempt's exit job, a merge
//! landing, an answer accepted, a Pool settings save, a Conversation ending, a plan edit, a
//! grading flow ending, an Adopt, an Enlist, a Reassign, the Merge queue watch seeing a hand merge.
//! A tick with nothing new does nothing, so a spurious wake costs one job.
//!
//!   drive_loop -- tick (job) --> launches --> tokio::spawn(run_launch) --+
//!        ^                                                               | exit job: result, crash
//!        +----------- wake.notified() <-- wake() <-----------------------+ Interrupt, chain merge
//!                                          ^     ^       ^
//!                          merge landed ---+     |       +-- answer / settings / plan edit / end
//!                                   grading flow ended
//!
//! ADR-0014's whole-pool Merge hold becomes per-blocker gating (ADR-0041): a Ticket is eligible
//! once each blocker is Done and merged into the target, and its worktree is cut from the target's
//! tip at launch, which by then holds every blocker. Every Ticket runs in its own worktree; the pool
//! checkout is written only by merges, through the checkout gate (ADR-0027).

use std::sync::Arc;

use tokio::sync::Notify;

use crate::actor::Engine;
use crate::session::Session;
use ac_core::line::run::{Advanced, Blocker, ConversationFact, LineFacts, LineRun, TicketFact, TicketId};
use ac_core::pool::TicketMarker;

// -------------------------------------------------------------------------------------------------
// Session changes
// -------------------------------------------------------------------------------------------------

/// Added to `Session`:
/// - `wake: Arc<Notify>`: `notify_one` stores a permit, so a wake between a tick and the wait is
///   never lost.
/// - `line: Option<LineRun>`: replaces `line: Option<LineState>` and `line_factory`.
/// - `verify_groups: HashMap<String, VerifyGroup>`: replaces the step-wide fan-out tally. Rebuilt
///   at boot from events on disk (`rebuild_verify_groups`).
/// - `grading: usize`: grading flows in flight (verify and Continued), so the drive does not close
///   while one runs.
/// - `max_live: Option<NonZeroU32>`: the Pool setting, falling back to the Machine default;
///   reloads with the assignment slice.
/// Removed: `super_step`, `pool_checkout_planned`, the per-step `StepMerges` queue (the session's
/// `merge_chain` is the only queue), and the whole-pool use of the hold derivation (its memo stays,
/// keyed per branch, behind `merged`).
pub struct SessionAdditions {
    pub wake: Arc<Notify>,
    pub line: Option<LineRun>,
    pub verify_groups: std::collections::HashMap<String, VerifyGroup>,
    pub grading: usize,
    pub max_live: Option<std::num::NonZeroU32>,
}

impl Session {
    /// The one way anything asks the drive to look again. Starts a drive when none is in flight
    /// (today's `kick_processing` idle branch), else leaves a permit. Replaces `kick_processing`.
    pub fn wake(&mut self) {
        todo!("if self.driving { self.wake.notify_one() } else { start_drive(self) }")
    }
}

/// The Candidates of one verify Ticket's round, joined per Ticket instead of per step.
pub struct VerifyGroup {
    /// The round's first attempt number and its size N (`verify: N`).
    pub first: u32,
    pub expected: usize,
    pub ended: Vec<crate::tickets::TicketResult>,
}

/// Restart: a verify Ticket whose marker is in progress gets its group back from its events file.
/// The round is the `spawned` events since its last `scheduled` event; each Candidate's ending is
/// its `exited` event and its Grade its `graded` event.
/// - Every Candidate exited: the group is complete; grading resumes for the ungraded ones and
///   Selection runs (graded ones are not graded again).
/// - Some Candidates are live again (terminal-backed, re-adopted by boot reconcile): the group
///   waits for their exits as if nothing had happened.
/// - Some Candidate neither exited nor came back: today's rule, the marker returns to Ready and
///   the next launch fans out again with continued attempt numbers.
/// Continued grades owed are derived the same way, by `owed_continued_grade` (unchanged), and run
/// as a grading flow at the first tick.
pub fn rebuild_verify_groups(session: &mut Session) -> anyhow::Result<()> {
    todo!()
}

// -------------------------------------------------------------------------------------------------
// Eligibility: the scheduler's one rule
// -------------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Eligibility {
    Start,
    /// Not now; the reason shows on the card ("waiting for prove-1 to merge").
    Wait(WaitWhy),
    /// Cannot start without the operator: raise this checkpoint (today's Config interrupt and
    /// held-branch checkpoint, unchanged).
    Checkpoint(CheckpointWhy),
}

#[derive(Debug, PartialEq)]
pub enum WaitWhy {
    NotReady,
    /// A hold Ticket: answered, never run.
    Hold,
    Live,
    BlockerNotDone(String),
    BlockerNotMerged(String),
    /// `maxLive` Attempts are already live.
    PoolFull { live: u32, max: u32 },
}

#[derive(Debug, PartialEq)]
pub enum CheckpointWhy {
    MissingAssignment(&'static str),
    BranchHeldAt(String),
}

/// A Ticket starts the moment this says Start. A Line's per-node caps are not here: copies past a
/// cap are never written (they wait in the pass queue in `line.json`), so the scheduler never needs
/// to know what a node is. `maxLive` is here, because it bounds the machine, not the plan.
pub fn eligibility(session: &mut Session, marker: &TicketMarker) -> Eligibility {
    // TODO, in order:
    // status != Ready                                   -> Wait(NotReady)
    // marker.hold                                       -> Wait(Hold)
    // live attempt / Continued / adopted has it         -> Wait(Live)
    // any blocker b: status != Done                     -> Wait(BlockerNotDone(b))
    //                                                      (Closed: the deadlock reconcile raised it)
    // any blocker b: !merged(b)                         -> Wait(BlockerNotMerged(b))
    //   where merged(b) is, explicitly and in this order:
    //     b is a hold Ticket                            -> true (it never has a branch)
    //     b is engine-run (grader, head-to-head)        -> true (ADR-0014's engine-ticket rule)
    //     the pool is outside git                       -> true
    //     else git is_ancestor(branch(b), target) through the memo, a missing branch reading as
    //     landed (ADR-0014's hand-merge path, kept for the operator)
    // live + need > max_live && live > 0                -> Wait(PoolFull)
    //   need = N for a verify: N Ticket, else 1. Live = Ticket Attempts the engine runs (every
    //   Candidate, resolver and Continued attempt); Conversations and enlisted panes do not count.
    //   A resolver is never withheld (ADR-0014: it is the escape path), only counted.
    // missing harness/model                             -> Checkpoint(MissingAssignment)
    // branch checked out elsewhere                      -> Checkpoint(BranchHeldAt)
    // else                                              -> Start
    todo!()
}

// -------------------------------------------------------------------------------------------------
// The loop
// -------------------------------------------------------------------------------------------------

pub struct Launch {
    pub marker: TicketMarker,
    pub plan: crate::tickets::TicketPlan,
    /// What the prompt reads upstream Outcomes from, frozen at this launch (was: per step). A
    /// blocker's Outcome is final once it is Done, so nothing it reads can change under it.
    pub snapshot: Arc<crate::session::PoolState>,
}

pub enum Next {
    Wait,
    /// Nothing runs, merges, grades or can start: settle the drive.
    Close,
}

pub async fn drive_loop(engine: &Engine) -> anyhow::Result<()> {
    // TODO
    // wait for terminal_reconcile (unchanged).
    // let wake = engine.call(|s| s.wake.clone()).await?;
    // loop {
    //     if engine.call(|s| s.children.stopping).await? { break }
    //     let (launches, next) = engine.call(tick).await??;
    //     for l in launches { tokio::spawn(run_launch(engine.clone(), l)); }
    //     match next { Next::Close => break, Next::Wait => wake.notified().await }
    // }
    // close_drive(engine).await   // Review gate unless the pool runs a Line, then the phase
    todo!()
}

/// One tick, one actor job. Each step is idempotent, so a tick after a crash or a spurious wake is
/// safe. The order is the old boundary's, because each step can create work for the next.
pub fn tick(session: &mut Session) -> anyhow::Result<(Vec<Launch>, Next)> {
    // TODO
    // 1. reload_config_if_changed: console.json's stamp moved -> today's all-or-nothing reload of
    //    the assignment slice, Spawn caps and maxLive. A live Attempt keeps its Assignment.
    // 2. drain_answers: every Queued answer, in order. A Line hold's answer re-runs
    //    `line.check_answer`; one refused now (the Finish gained a blocker since acceptance) is
    //    dropped with a pool-log line and an event, and its Interrupt stays. A Resume of a hold
    //    writes it Done (never Ready) with the note on its events: `TicketFact::Answered`.
    // 3. reconcile_deadlocks (once).
    // 4. advance_line (below).
    // 5. land_pending_spawns: ADR-0029's landing, now per tick. A `blocks` naming a Ticket that is
    //    no longer Ready (live, done, closed) holds the spawn with HeldSpawnReason::Started instead
    //    of adding a blocker under work already running. A proposal from a Line Ticket follows its
    //    node's SpawnPolicy (Hold unless the plan says Land).
    // 6. owed Continued grades and complete verify groups with no grading flow: spawn the flow,
    //    grading += 1.
    // 7. for each marker in load order: match eligibility(..) {
    //        Start => plan_launch: ALWAYS a worktree cut from the merge target's tip now; attempt
    //                 numbers; marker in-progress; a `scheduled` event; pool log
    //                 "start {id} at {sha7}",
    //        Checkpoint(why) => raise it,
    //        Wait(_) => {} }
    // 8. if anything changed: write_markers, persist (a checkpoint row), emit.
    // 9. Next::Close iff no launch && no live attempt && merge_chain idle && grading == 0 &&
    //    no Pending spawn waiting to land; else Next::Wait.
    todo!()
}

/// Step 4. Save first, project second (see run.rs's header).
fn advance_line(session: &mut Session) -> anyhow::Result<()> {
    // TODO
    // let Some(mut run) = session.line.take() else { return Ok(()) };
    // let Advanced { changed, log, effects } = run.advance(&SessionFacts(session));
    // if changed { save_line_atomic(pool_dir, &run)? }               // tmp + rename
    // for t in effects.tickets { write_ticket_if_absent(t)? }       // node=, spawn-assign=
    // for h in effects.holds   { write_ticket_if_absent(h as `checkpoint ... hold`)?;
    //                            raise_interrupt_if_absent(h)? }
    // for c in effects.conversations { open_conversation_if_absent(c)? }   // id "{node}-{pass}"
    // if let Some(end) = effects.ended { the pool's phase settles at close_drive: Done | Closed }
    // session.line = Some(run); log lines into the pool log.
    todo!()
}

/// The pool as the Line reads it, rebuilt from durable sources at every call.
struct SessionFacts<'a>(&'a Session);
impl LineFacts for SessionFacts<'_> {
    fn ticket(&self, _: &TicketId) -> TicketFact<'_> {
        // marker status + Outcome (verdict, items) + merged (the rule in `eligibility`).
        todo!()
    }
    fn conversation(&self, _: &TicketId) -> ConversationFact {
        // The Conversation record's state. Ended: parse the Line brief from the Conversation's
        // branch tip (`git show <branch>:docs/specs/<line>.<id>.brief.json`), or from the merge
        // target once the branch has merged and been deleted; `merged` = ancestor of the target.
        // Read again at every call until the run absorbs it; never cached in memory.
        todo!()
    }
    fn outside_blockers(&self) -> Vec<Blocker> {
        todo!()
    }
}

// -------------------------------------------------------------------------------------------------
// Per-Ticket joins: everything that used to wait for the step's join
// -------------------------------------------------------------------------------------------------

async fn run_launch(engine: Engine, launch: Launch) {
    // TODO: let result = run_ticket(&engine, ...).await;
    //       engine.call(move |s| { on_exit(s, result); s.wake() }).await
    todo!()
}

/// One Attempt's exit, in its own job:
/// - Spawn proposals taken (ADR-0029: Pending or Held at once, as today);
/// - a verify Candidate joins its `VerifyGroup`; the last to exit makes the group complete, and
///   the next tick spawns its grading flow, whose end job merges the winner through the chain;
/// - done -> chain `merge_ticket` onto `merge_chain`; the merge flow's end job is `after_merge`;
/// - checkpoint -> its Interrupt now;
/// - crashed (no Outcome) -> the crash Interrupt now (was: at the step's join);
/// - then persist (a checkpoint row) and emit.
fn on_exit(session: &mut Session, result: crate::tickets::TicketResult) {
    todo!()
}

/// A merge flow ended, in its own job. Clean -> the `merged` event, log, persist; this is the
/// fact both `CopySettled` and `BlockerNotMerged` read at the next tick. Conflict -> the Ticket's
/// policy: `plan.conflict_for(node)` for a Line Ticket (its merger's Resolver(assign) or Wait),
/// else console.json's `resolver` (today's `handle_merge_conflict`, now per Ticket; the chain
/// already serialises). A conflict pauses only the conflicted Ticket's dependents. Its Interrupt
/// shows how many Tickets have started since it was raised, counted from `scheduled` events
/// after it, derived at every emit and never stored. Then wake.
fn after_merge(session: &mut Session, ticket: &str, result: ac_io::git::MergeResult) {
    todo!()
}

// -------------------------------------------------------------------------------------------------
// Verbs that reach the Line
// -------------------------------------------------------------------------------------------------

/// `line.plan.edit {baseRev, edits}` (HTTP twin `POST /api/line/plan`), operator; the Steward's
/// `POST /api/steward/plan` arrives here with `Editor::Steward`. Applied in the receiving job,
/// saved, then a wake: the projection runs at the tick, like everything else.
pub fn edit_plan(
    session: &mut Session,
    by: ac_core::line::run::Editor,
    base_rev: u64,
    edits: Vec<ac_core::plan::PlanEdit>,
) -> Result<u64, crate::error::EngineError> {
    todo!()
}

/// `conversations.end` on a Conversation node's Conversation (in place of `start_line_from_grill`).
/// `close: false`: parse its Line brief on its branch; a missing or invalid one refuses the End with
/// the problems and changes nothing. A valid one ends the Conversation and chains its branch's merge
/// onto `merge_chain`. `close: true`: end it with nothing merged; it hands on `closed`. Then wake.
/// Nothing is recorded in memory: `SessionFacts::conversation` reads the brief again each tick.
pub fn end_node_conversation(
    session: &mut Session,
    conversation: &str,
    close: bool,
) -> Result<(), crate::error::EngineError> {
    todo!()
}

// -------------------------------------------------------------------------------------------------
// Boot and restart
// -------------------------------------------------------------------------------------------------

/// `POST /api/line {plan, work | brief}`, sent once by Boot (`agent-console boot --plan <slug>`).
/// The engine parses the plan again (the boundary is the engine's), checks its harness names
/// against the machine, builds `LineRun::start`, saves `line.json` and wakes. A second call while a
/// Line exists is refused. `POST /api/line/start` and Start the Line are gone.
pub fn begin_line(
    session: &mut Session,
    plan_json: &str,
    start: ac_core::line::run::LineStart,
) -> Result<(), crate::error::EngineError> {
    todo!()
}

/// Rehydrate, unchanged except:
/// - `line.json` loads as `LineRun` (an old `LineState` file refuses with a message to start a
///   new Line; there is no migration);
/// - `rebuild_verify_groups` runs after the in-progress reset;
/// - nothing else Line-specific is rebuilt: the first tick's `advance` re-observes every fact, and
///   the projection writes whatever a crash left unwritten;
/// - an in-progress marker with no Interrupt resets to Ready as today and relaunches into its
///   existing branch (its blockers were merged when it first started, so the old cut stands).
pub fn rehydrate_line(session: &mut Session) -> anyhow::Result<()> {
    todo!()
}
