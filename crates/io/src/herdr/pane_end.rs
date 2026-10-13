//! The wait on a pane's end over herdr's `events.subscribe`, the daemon's only event channel.

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{Herdr, rpc};

/// How a pane's end was observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PaneEnd {
    /// The pane's process ended (`pane_exited`), the Terminal-backed attempt's normal ending.
    Exited,
    /// The pane vanished without exiting (`pane_closed`, or its tab closed): the attempt is gone either
    /// way.
    Closed,
    /// The subscription could not be kept (a daemon restart, or a daemon without `events.subscribe`).
    /// Says only that this observation is over, never that the attempt is.
    Lost,
}

impl PaneEnd {
    /// The TypeScript name of the end: `exited`, `closed` or `lost`.
    pub fn as_str(self) -> &'static str {
        match self {
            PaneEnd::Exited => "exited",
            PaneEnd::Closed => "closed",
            PaneEnd::Lost => "lost",
        }
    }
}

/// See [`Herdr::wait_for_pane_end`].
pub(super) async fn wait(
    herdr: &Herdr,
    pane_id: &str,
    release: Option<&CancellationToken>,
) -> PaneEnd {
    let Some(release) = release else {
        return watch(herdr, pane_id).await;
    };
    if release.is_cancelled() {
        return PaneEnd::Lost;
    }
    tokio::select! {
        biased;
        // Dropping the watch closes its connection wherever it had got to, a connect still in flight
        // included, so the daemon sees the subscriber leave.
        () = release.cancelled() => PaneEnd::Lost,
        end = watch(herdr, pane_id) => end,
    }
}

/// What one line on the subscription asks of the wait.
#[derive(Debug, PartialEq, Eq)]
enum Heard {
    /// Nothing for this wait: unparseable, or another pane's event.
    Nothing,
    /// The pane's end may have gone unannounced: settle with this end if the listing no longer holds it.
    CheckListing(PaneEnd),
    /// This pane's own end.
    End(PaneEnd),
}

async fn watch(herdr: &Herdr, pane_id: &str) -> PaneEnd {
    let Ok(mut stream) = rpc::connect(herdr.socket_path()).await else {
        return PaneEnd::Lost;
    };
    let subscribe = rpc::request_line(
        "events.subscribe",
        json!({
            "subscriptions": [
                { "type": "pane.exited" },
                { "type": "pane.closed" },
                { "type": "tab.closed" },
            ],
        }),
    );
    if stream.write_all(subscribe.as_bytes()).await.is_err() {
        return PaneEnd::Lost;
    }
    let (unlisted_tx, mut unlisted) = mpsc::unbounded_channel();
    let mut received = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        tokio::select! {
            biased;
            Some(end) = unlisted.recv() => return end,
            read = stream.read(&mut chunk) => {
                // A hang-up (a plain FIN), a reset and an error all end the observation: whatever does
                // not settle the wait parks it, as a wait over an attempt that had already finished
                // once stayed parked for 98 minutes.
                let read = match read {
                    Ok(0) | Err(_) => return PaneEnd::Lost,
                    Ok(read) => read,
                };
                received.extend_from_slice(&chunk[..read]);
                while let Some(newline) = received.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = received.drain(..=newline).collect();
                    match hear(&String::from_utf8_lossy(&line[..newline]), pane_id) {
                        Heard::Nothing => {}
                        Heard::CheckListing(end) => {
                            settle_if_unlisted(herdr, pane_id, end, unlisted_tx.clone());
                        }
                        Heard::End(end) => return end,
                    }
                }
            }
        }
    }
}

/// Classify one line the daemon pushed down the subscription.
fn hear(line: &str, pane_id: &str) -> Heard {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Heard::Nothing;
    };
    match message.get("event").and_then(Value::as_str) {
        // The subscription's acknowledgement (or anything else that is not an event): from here the
        // daemon pushes this pane's ends, so only an end that predated the subscription can be missed,
        // and the listing is what can still see it.
        None => Heard::CheckListing(PaneEnd::Exited),
        // A closed tab takes its panes silently and names none of them, so the listing says whether
        // this pane went with it.
        Some("tab_closed") => Heard::CheckListing(PaneEnd::Closed),
        Some(event) => {
            let about = message
                .get("data")
                .and_then(|data| data.get("pane_id"))
                .and_then(Value::as_str);
            if about != Some(pane_id) {
                return Heard::Nothing;
            }
            Heard::End(if event == "pane_closed" {
                PaneEnd::Closed
            } else {
                PaneEnd::Exited
            })
        }
    }
}

// The pane's absence from the daemon-wide listing is the end the subscription cannot report. The check
// runs on its own task, as the TypeScript's floating promise did, so a wait settled meanwhile still
// lets its listing finish; a listing the daemon cannot answer says nothing.
fn settle_if_unlisted(
    herdr: &Herdr,
    pane_id: &str,
    end: PaneEnd,
    unlisted: mpsc::UnboundedSender<PaneEnd>,
) {
    let herdr = herdr.clone();
    let pane_id = pane_id.to_owned();
    tokio::spawn(async move {
        if let Ok(ids) = herdr.list_pane_ids(None).await
            && !ids.contains(&pane_id)
        {
            let _ = unlisted.send(end);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hears_the_pane_own_ends_and_checks_the_listing_otherwise() {
        let pane = "pane-1";
        assert_eq!(
            hear(r#"{"id":"1","result":{}}"#, pane),
            Heard::CheckListing(PaneEnd::Exited)
        );
        assert_eq!(
            hear(r#"{"id":"1","error":{"code":-32601}}"#, pane),
            Heard::CheckListing(PaneEnd::Exited)
        );
        assert_eq!(
            hear(
                r#"{"event":"tab_closed","data":{"type":"tab_closed","tab_id":"t1"}}"#,
                pane
            ),
            Heard::CheckListing(PaneEnd::Closed)
        );
        assert_eq!(
            hear(
                r#"{"event":"pane_exited","data":{"pane_id":"pane-1"}}"#,
                pane
            ),
            Heard::End(PaneEnd::Exited)
        );
        assert_eq!(
            hear(
                r#"{"event":"pane_closed","data":{"pane_id":"pane-1"}}"#,
                pane
            ),
            Heard::End(PaneEnd::Closed)
        );
        assert_eq!(
            hear(
                r#"{"event":"pane_exited","data":{"pane_id":"pane-2"}}"#,
                pane
            ),
            Heard::Nothing
        );
        assert_eq!(hear(r#"{"event":"pane_exited"}"#, pane), Heard::Nothing);
        assert_eq!(hear("not json", pane), Heard::Nothing);
        assert_eq!(hear("", pane), Heard::Nothing);
    }
}
