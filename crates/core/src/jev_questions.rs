//! Jev's question and Judgement shapes (ADR-0020): what the TypeScript took from TypeSafe's SDK
//! (`@typesafe-ai/sdk` 0.6.0) and re-exported through engine/jev.ts. They live in the pure core because
//! the rubric (`jev_rubric`) builds questions and composes Judgements, and the Evidence builder
//! (`jev_evidence`) builds the Evidence; the HTTP client in `ac_io::jev` sends and reads them.
//!
//! A question goes on the wire as `{"type":..,"instructions":..,"criteria":..}`, the object the SDK's
//! `noul`, `choice` and `score` helpers build. A Judgement is one typed answer to one question: a Noul
//! (the probability that a condition holds), a Choice (one label with a probability per label and a
//! confidence) or a Jev Score (an expected position on an ordered rubric, with probabilities and a
//! confidence).
//!
//! [`answer_for`] is the answer the scripted fakes give (conformance/fixtures/jev-fake.ts): the wire
//! fake in `ac_io`'s tests, the port fake, and the rubric's own tests all build their Judgements
//! through it, so the wording a test scripts is the wording the wire would carry.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::js;

/// The named JSON object a call site hands Jev: only the context the questions need.
pub type Evidence = Map<String, Value>;

/// Questions keyed by the names that identify their answers, in the order they were written.
pub type Questions = IndexMap<String, Question>;

/// Judgements keyed by question name, one per question asked, in the questions' order.
pub type Answers = IndexMap<String, Judgement>;

/// One question Jev answers over the Evidence. Instructions and descriptions are text, a JSON object
/// or array, or null, as the SDK's `EntryType` allows.
#[derive(Debug, Clone, PartialEq)]
pub enum Question {
    /// A yes/no question: `criteria` describes the yes and no outcomes (`{"true":..,"false":..}`), and
    /// is left out of the JSON when `None`.
    Noul {
        instructions: Value,
        criteria: Option<Value>,
    },
    /// A pick between named labels, each mapped to its description (null for an undescribed label).
    Choice {
        instructions: Value,
        criteria: Map<String, Value>,
    },
    /// An ordered rubric: one description per level, indexed by score from zero.
    Score {
        instructions: Value,
        criteria: Vec<Value>,
    },
}

/// `noul(instructions, criteria)`: a yes/no question.
pub fn noul(instructions: impl Into<Value>, criteria: Option<Value>) -> Question {
    Question::Noul {
        instructions: instructions.into(),
        criteria,
    }
}

/// `choice(instructions, criteria)`: a question that picks one of the labels.
pub fn choice(instructions: impl Into<Value>, criteria: Map<String, Value>) -> Question {
    Question::Choice {
        instructions: instructions.into(),
        criteria,
    }
}

/// `score(instructions, criteria)`: a question scored on an ordered rubric.
pub fn score(instructions: impl Into<Value>, criteria: Vec<Value>) -> Question {
    Question::Score {
        instructions: instructions.into(),
        criteria,
    }
}

impl Question {
    /// The question's `type` on the wire: `noul`, `choice` or `score`.
    pub fn kind(&self) -> &'static str {
        match self {
            Question::Noul { .. } => "noul",
            Question::Choice { .. } => "choice",
            Question::Score { .. } => "score",
        }
    }

    /// A question read back from its JSON, as a request carries it; `None` for an unknown type or
    /// criteria not of the type's shape. A missing `instructions` reads as null.
    pub fn from_value(value: &Value) -> Option<Question> {
        let instructions = value.get("instructions").cloned().unwrap_or(Value::Null);
        let criteria = value.get("criteria");
        Some(match value.get("type")?.as_str()? {
            "noul" => Question::Noul {
                instructions,
                criteria: criteria.cloned(),
            },
            "choice" => Question::Choice {
                instructions,
                criteria: criteria?.as_object()?.clone(),
            },
            "score" => Question::Score {
                instructions,
                criteria: criteria?.as_array()?.clone(),
            },
            _ => return None,
        })
    }

    /// The question as the SDK's helpers build it: `type`, `instructions`, then `criteria`.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("type".to_owned(), Value::from(self.kind()));
        match self {
            Question::Noul {
                instructions,
                criteria,
            } => {
                out.insert("instructions".to_owned(), instructions.clone());
                if let Some(criteria) = criteria {
                    out.insert("criteria".to_owned(), criteria.clone());
                }
            }
            Question::Choice {
                instructions,
                criteria,
            } => {
                out.insert("instructions".to_owned(), instructions.clone());
                out.insert("criteria".to_owned(), Value::Object(criteria.clone()));
            }
            Question::Score {
                instructions,
                criteria,
            } => {
                out.insert("instructions".to_owned(), instructions.clone());
                out.insert("criteria".to_owned(), Value::Array(criteria.clone()));
            }
        }
        Value::Object(out)
    }
}

/// The questions as one JSON object, keyed by name: the `questions` a request carries.
pub fn questions_value(questions: &Questions) -> Value {
    Value::Object(
        questions
            .iter()
            .map(|(id, question)| (id.clone(), question.to_value()))
            .collect(),
    )
}

/// The questions in the order JavaScript walks an object's keys (`Object.entries`): names that are
/// array indices first, ascending, then the rest in the order they were written.
pub fn ordered_questions(questions: &Questions) -> Vec<(&String, &Question)> {
    let mut indices: Vec<(u32, (&String, &Question))> = Vec::new();
    let mut others = Vec::with_capacity(questions.len());
    for entry in questions {
        match js::array_index(entry.0) {
            Some(index) => indices.push((index, entry)),
            None => others.push(entry),
        }
    }
    indices.sort_by_key(|(index, _)| *index);
    indices
        .into_iter()
        .map(|(_, entry)| entry)
        .chain(others)
        .collect()
}

/// One typed answer from Jev to one question.
#[derive(Debug, Clone, PartialEq)]
pub enum Judgement {
    Noul(NoulJudgement),
    Choice(ChoiceJudgement),
    Score(ScoreJudgement),
}

/// A yes/no answer.
#[derive(Debug, Clone, PartialEq)]
pub struct NoulJudgement {
    /// The probability of yes, from zero to one.
    pub noul: f64,
}

/// A picked label and its probabilities.
#[derive(Debug, Clone, PartialEq)]
pub struct ChoiceJudgement {
    /// The picked label.
    pub choice: String,
    /// The confidence in the picked label.
    pub confidence: f64,
    /// The probability of each label, as the response carried it.
    pub probabilities: Value,
}

/// An expected score on a rubric, with its probabilities.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreJudgement {
    /// The expected score, which may fall between whole levels.
    pub score: f64,
    /// The confidence in the score.
    pub confidence: f64,
    /// The probability of each level, keyed by level, as the response carried it.
    pub probabilities: Value,
}

impl Judgement {
    /// The answer object as the response carries it, read as the question's type. `None` when a field
    /// that type needs is missing or not of its kind; `ac_io::jev` checks the full shape first, so a
    /// Judgement it hands back always reads.
    pub fn from_value(question: &Question, answer: &Value) -> Option<Judgement> {
        let field = |name: &str| answer.get(name);
        let number = |name: &str| field(name).and_then(js::number_of);
        Some(match question {
            Question::Noul { .. } => Judgement::Noul(NoulJudgement {
                noul: number("noul")?,
            }),
            Question::Choice { .. } => Judgement::Choice(ChoiceJudgement {
                choice: field("choice")?.as_str()?.to_owned(),
                confidence: number("confidence")?,
                probabilities: field("probabilities")?.clone(),
            }),
            Question::Score { .. } => Judgement::Score(ScoreJudgement {
                score: number("score")?,
                confidence: number("confidence")?,
                probabilities: field("probabilities")?.clone(),
            }),
        })
    }

    /// The probability of yes, for a Noul.
    pub fn noul(&self) -> Option<f64> {
        match self {
            Judgement::Noul(noul) => Some(noul.noul),
            _ => None,
        }
    }

    /// The Choice, for a Choice.
    pub fn as_choice(&self) -> Option<&ChoiceJudgement> {
        match self {
            Judgement::Choice(choice) => Some(choice),
            _ => None,
        }
    }

    /// The Jev Score, for a Score.
    pub fn as_score(&self) -> Option<&ScoreJudgement> {
        match self {
            Judgement::Score(score) => Some(score),
            _ => None,
        }
    }

    /// The reported confidence, for a Choice or a Score.
    pub fn confidence(&self) -> Option<f64> {
        match self {
            Judgement::Noul(_) => None,
            Judgement::Choice(choice) => Some(choice.confidence),
            Judgement::Score(score) => Some(score.confidence),
        }
    }
}

/// How a test scripts one answer: a number for a Noul (the probability of yes) or a Score (the level,
/// given 0.9 of the mass), a string for a Choice (the label, given 0.9 of the mass), or a full answer
/// object to use as is.
#[derive(Debug, Clone, PartialEq)]
pub enum ScriptedAnswer {
    Number(f64),
    Label(String),
    Object(Map<String, Value>),
}

impl From<f64> for ScriptedAnswer {
    fn from(value: f64) -> Self {
        ScriptedAnswer::Number(value)
    }
}

impl From<i32> for ScriptedAnswer {
    fn from(value: i32) -> Self {
        ScriptedAnswer::Number(f64::from(value))
    }
}

impl From<&str> for ScriptedAnswer {
    fn from(value: &str) -> Self {
        ScriptedAnswer::Label(value.to_owned())
    }
}

impl From<Value> for ScriptedAnswer {
    /// A number, a string, or an object; anything else scripts nothing and reads as an object with no
    /// fields.
    fn from(value: Value) -> Self {
        match value {
            Value::Number(number) => ScriptedAnswer::Number(number.as_f64().unwrap_or(f64::NAN)),
            Value::String(text) => ScriptedAnswer::Label(text),
            Value::Object(fields) => ScriptedAnswer::Object(fields),
            _ => ScriptedAnswer::Object(Map::new()),
        }
    }
}

/// The mass a scripted label or level gets; the rest is spread evenly.
const SCRIPTED_MASS: f64 = 0.9;

/// One answer of the question's type, scripted or uniform: the fakes' `answerFor`.
pub fn answer_for(question: &Question, scripted: Option<&ScriptedAnswer>) -> Value {
    if let Some(ScriptedAnswer::Object(fields)) = scripted {
        // `{ type: question.type, ...scripted }`: a scripted `type` overwrites the value in place.
        let mut out = Map::new();
        out.insert("type".to_owned(), Value::from(question.kind()));
        for (key, value) in fields {
            out.insert(key.clone(), value.clone());
        }
        return Value::Object(out);
    }
    let mut out = Map::new();
    out.insert("type".to_owned(), Value::from(question.kind()));
    match question {
        Question::Noul { .. } => {
            let noul = match scripted {
                Some(ScriptedAnswer::Number(n)) => *n,
                _ => 0.5,
            };
            out.insert("noul".to_owned(), js::number_value(noul));
        }
        Question::Choice { criteria, .. } => {
            let labels: Vec<String> = js::own_entries(criteria)
                .into_iter()
                .map(|(label, _)| label.clone())
                .collect();
            let (picked, scripted_label) = match scripted {
                Some(ScriptedAnswer::Label(label)) => (Some(label.clone()), Some(label.as_str())),
                _ => (labels.first().cloned(), None),
            };
            let probabilities = spread(&labels, scripted_label);
            if let Some(picked) = picked {
                out.insert("choice".to_owned(), Value::from(picked));
            }
            out.insert(
                "confidence".to_owned(),
                js::number_value(confidence_of(&probabilities)),
            );
            out.insert(
                "probabilities".to_owned(),
                probabilities_value(&probabilities),
            );
        }
        Question::Score { criteria, .. } => {
            let levels: Vec<String> = (0..criteria.len()).map(|i| i.to_string()).collect();
            let picked = match scripted {
                Some(ScriptedAnswer::Number(n)) => Some(js::number_string(*n)),
                _ => None,
            };
            let probabilities = spread(&levels, picked.as_deref());
            let expected = probabilities
                .iter()
                .fold(0.0, |sum, (level, p)| sum + js::number_from_text(level) * p);
            let legend: Map<String, Value> = criteria
                .iter()
                .enumerate()
                .map(|(i, text)| (i.to_string(), text.clone()))
                .collect();
            out.insert("score".to_owned(), js::number_value(expected));
            out.insert(
                "confidence".to_owned(),
                js::number_value(confidence_of(&probabilities)),
            );
            out.insert("legend".to_owned(), Value::Object(legend));
            out.insert(
                "probabilities".to_owned(),
                probabilities_value(&probabilities),
            );
        }
    }
    Value::Object(out)
}

fn spread(keys: &[String], picked: Option<&str>) -> Vec<(String, f64)> {
    let count = keys.len() as f64;
    match picked {
        Some(picked) if keys.len() != 1 => {
            let rest = (1.0 - SCRIPTED_MASS) / (count - 1.0);
            keys.iter()
                .map(|key| {
                    let mass = if key == picked { SCRIPTED_MASS } else { rest };
                    (key.clone(), mass)
                })
                .collect()
        }
        _ => keys.iter().map(|key| (key.clone(), 1.0 / count)).collect(),
    }
}

/// `Math.max(...Object.values(probabilities))`.
fn confidence_of(probabilities: &[(String, f64)]) -> f64 {
    probabilities
        .iter()
        .fold(f64::NEG_INFINITY, |max, (_, p)| max.max(*p))
}

fn probabilities_value(probabilities: &[(String, f64)]) -> Value {
    Value::Object(
        probabilities
            .iter()
            .map(|(key, p)| (key.clone(), js::number_value(*p)))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn labels(names: &[&str]) -> Map<String, Value> {
        names
            .iter()
            .map(|name| (name.to_string(), Value::Null))
            .collect()
    }

    #[test]
    fn a_question_reads_as_the_sdk_helpers_build_it() {
        let yes_no = noul("Waiting?", Some(json!({ "true": "yes", "false": "no" })));
        assert_eq!(
            js::stringify(&yes_no.to_value()),
            r#"{"type":"noul","instructions":"Waiting?","criteria":{"true":"yes","false":"no"}}"#
        );
        // A Noul with no criteria leaves the key out, as JSON.stringify drops an undefined field.
        assert_eq!(
            js::stringify(&noul(Value::Null, None).to_value()),
            r#"{"type":"noul","instructions":null}"#
        );
        let why = choice("Why?", labels(&["finished", "stuck"]));
        assert_eq!(
            js::stringify(&why.to_value()),
            r#"{"type":"choice","instructions":"Why?","criteria":{"finished":null,"stuck":null}}"#
        );
        let brief = score("How complete?", vec![json!("empty"), json!("complete")]);
        assert_eq!(
            js::stringify(&brief.to_value()),
            r#"{"type":"score","instructions":"How complete?","criteria":["empty","complete"]}"#
        );
    }

    #[test]
    fn questions_walk_in_javascripts_key_order() {
        let questions: Questions = [
            ("b".to_owned(), noul("?", None)),
            ("1".to_owned(), noul("?", None)),
            ("a".to_owned(), noul("?", None)),
            ("0".to_owned(), noul("?", None)),
        ]
        .into_iter()
        .collect();
        let order: Vec<&str> = ordered_questions(&questions)
            .into_iter()
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(order, ["0", "1", "b", "a"]);
    }

    #[test]
    fn answer_for_gives_a_scripted_label_or_level_the_mass_and_spreads_the_rest() {
        let why = choice("Why?", labels(&["finished", "stuck", "ceiling"]));
        let picked = answer_for(&why, Some(&"stuck".into()));
        assert_eq!(picked["choice"], "stuck");
        assert_eq!(picked["confidence"], 0.9);
        assert_eq!(picked["probabilities"]["stuck"], 0.9);
        let uniform = answer_for(&why, None);
        assert_eq!(uniform["choice"], "finished");
        assert_eq!(uniform["probabilities"]["ceiling"], 1.0 / 3.0);

        let brief = score("?", vec![json!("empty"), json!("thin"), json!("complete")]);
        let scored = answer_for(&brief, Some(&2.into()));
        assert!((scored["score"].as_f64().unwrap() - 1.85).abs() < 1e-9);
        assert_eq!(scored["probabilities"]["2"], 0.9);
        assert_eq!(
            scored["legend"],
            json!({ "0": "empty", "1": "thin", "2": "complete" })
        );

        let waiting = noul("?", None);
        assert_eq!(
            answer_for(&waiting, Some(&0.93.into())),
            json!({ "type": "noul", "noul": 0.93 })
        );
        assert_eq!(
            answer_for(&waiting, None),
            json!({ "type": "noul", "noul": 0.5 })
        );
        // A full object is used as is, under the question's type.
        let object = ScriptedAnswer::from(json!({ "type": "noul", "noul": 0.2 }));
        assert_eq!(
            answer_for(&why, Some(&object)),
            json!({ "type": "noul", "noul": 0.2 })
        );
    }

    #[test]
    fn a_judgement_reads_from_the_answer_of_its_type() {
        let brief = score("?", vec![json!("a"), json!("b")]);
        let read = Judgement::from_value(&brief, &answer_for(&brief, Some(&1.into()))).unwrap();
        assert_eq!(read.as_score().unwrap().confidence, 0.9);
        assert_eq!(read.confidence(), Some(0.9));
        assert_eq!(read.noul(), None);
        assert!(Judgement::from_value(&brief, &json!({ "type": "score" })).is_none());
    }
}
