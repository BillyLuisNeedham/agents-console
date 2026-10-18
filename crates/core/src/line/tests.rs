use super::*;
use ac_protocol::FindingSeverity;
use serde_json::json;

const CUT: &str = "0123456789abcdef0123456789abcdef01234567";

#[test]
fn prove_needs_pass_or_fail_and_evidence() {
    assert!(prove_verdict(Some(&json!({"prove": "pass", "evidence": "e"}))).is_ok());
    assert_eq!(
        prove_verdict(None).unwrap_err(),
        "the Outcome has no verdict"
    );
    assert!(
        prove_verdict(Some(&json!({"prove": "passed", "evidence": "e"})))
            .unwrap_err()
            .contains("unknown variant `passed`")
    );
    assert!(
        prove_verdict(Some(&json!({"prove": "fail", "evidence": " "})))
            .unwrap_err()
            .contains("evidence is blank")
    );
}

#[test]
fn review_findings_parse_with_their_severity() {
    let verdict = review_verdict(Some(&json!({"findings": [
        {"severity": "must", "title": "t", "detail": "d"},
        {"severity": "nit", "title": "n", "detail": ""}
    ]})))
    .unwrap();
    assert_eq!(verdict.findings[0].severity, FindingSeverity::Must);
    assert!(review_verdict(Some(&json!({"findings": []}))).is_ok());
    assert!(
        review_verdict(Some(
            &json!({"findings": [{"severity": "blocker", "title": "t", "detail": ""}]})
        ))
        .unwrap_err()
        .contains("unknown variant `blocker`")
    );
    assert_eq!(
        review_verdict(Some(
            &json!({"findings": [{"severity": "must", "title": "", "detail": ""}]})
        ))
        .unwrap_err(),
        "finding 1 has a blank title"
    );
}

#[test]
fn approval_is_no_note_or_approved() {
    assert!(approves(None));
    assert!(approves(Some("  ")));
    assert!(approves(Some("Approved.")));
    assert!(!approves(Some("approved, but rename the flag")));
}

#[test]
fn a_line_is_named_after_its_branch() {
    assert_eq!(line_name_of("line/186"), "186");
    assert_eq!(line_name_of("line/a/b"), "a-b");
    assert_eq!(line_name_of("feature/x"), "feature-x");
    assert_eq!(line_name_of("line/"), "line");
}

#[test]
fn a_malformed_line_base_is_refused_never_read_as_main() {
    let good = json!({"ref": "experiment/x", "commit": CUT});
    assert_eq!(
        line_base_of(&good),
        Ok(LineBase {
            base_ref: "experiment/x".into(),
            commit: CUT.into(),
        })
    );
    for (bad, why) in [
        (
            json!("experiment/x"),
            "invalid type: string \"experiment/x\", expected",
        ),
        (json!(null), "invalid type: null"),
        (json!({"ref": "experiment/x"}), "missing field `commit`"),
        (
            json!({"ref": "", "commit": CUT}),
            "its ref \"\" names no branch",
        ),
        (
            json!({"ref": "origin/", "commit": CUT}),
            "its ref \"origin/\" names no branch",
        ),
        (
            json!({"ref": "experiment/x", "commit": " "}),
            "its commit is blank",
        ),
    ] {
        let err = line_base_of(&bad).unwrap_err();
        assert!(err.contains(why), "{bad}: {err}");
    }
}
