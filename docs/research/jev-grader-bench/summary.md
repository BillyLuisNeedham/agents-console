| Attempt | Budget | n | mean 0-10 | spread | verdicts | conf fit/claim/log | gates contradicted/untouched/failing (mean) | fired | usage tok (mean) | est ev tok | ms | failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| badges-01-large | full-diff-20k-tail | 3/3 | 8.3 | 0.1 | pass | 0.90/0.45/0.91 | 0.14/0.13/0.11 | none | 33985 | 27630 | 848 | none |
| badges-01-large | hunks-10k-tail | 1/1 | 8.3 | 0.0 | pass | 0.94/0.45/0.92 | 0.14/0.11/0.10 | none | 21655 | 16142 | 1086 | none |
| badges-01-large | hunks-5k-tail | 3/3 | 8.4 | 0.0 | pass | 0.96/0.57/0.90 | 0.10/0.13/0.11 | none | 15275 | 10974 | 331 | none |
| badges-01-large | log-only | 3/3 | 7.0 | 0.6 | pass | 0.09/0.32/0.87 | 0.14/0.23/0.11 | none | 33134 | 26233 | 476 | none |
| badges-01-large | two-pass | 0/3 | - | - | - | -/-/- | -/-/- | none | - | - | 264 | invalid-question: pass 1: HTTP 400: 400 {"detail":{"error_type":"max_tokens_exceeded"}} |
| badges-02-large-clean | hunks-5k-tail | 3/3 | 7.2 | 0.4 | pass | 0.86/0.09/0.82 | 0.36/0.17/0.15 | none | 19511 | 13770 | 595 | none |
| badges-03-attempt-1-mid | full-diff-20k-tail | 3/3 | 4.7 | 0.2 | flag | 0.45/0.62/0.71 | 0.80/0.47/0.10 | contradicted_claim | 24506 | 19876 | 396 | none |
| badges-03-attempt-1-mid | hunks-10k-tail | 1/1 | 4.9 | 0.0 | flag | 0.32/0.61/0.80 | 0.76/0.51/0.16 | contradicted_claim | 19642 | 15245 | 354 | none |
| badges-03-attempt-1-mid | hunks-5k-tail | 3/3 | 5.1 | 0.2 | flag | 0.24/0.53/0.80 | 0.70/0.50/0.11 | contradicted_claim | 13973 | 10126 | 327 | none |
| badges-03-attempt-1-mid | log-only | 3/3 | 3.4 | 0.1 | flag | 0.00/0.65/0.77 | 0.86/0.48/0.09 | contradicted_claim | 20522 | 16101 | 365 | none |
| badges-03-attempt-1-mid | two-pass | 3/3 | 4.4 | 0.1 | flag | 0.56/0.65/0.73 | 0.75/0.63/0.15 | contradicted_claim, untouched_criterion | 37774 | 11355 | 796 | none |
| badges-03-spawn-1-small | full-diff-20k-tail | 3/3 | 8.4 | 0.0 | pass | 0.93/0.54/0.92 | 0.13/0.18/0.03 | none | 10386 | 6436 | 353 | none |
| badges-03-spawn-1-small | hunks-10k-tail | 1/1 | 8.2 | 0.0 | pass | 0.92/0.38/0.92 | 0.14/0.21/0.03 | none | 10047 | 6120 | 297 | none |
| badges-03-spawn-1-small | hunks-5k-tail | 3/3 | 8.1 | 0.0 | pass | 0.89/0.31/0.92 | 0.15/0.20/0.03 | none | 10047 | 6120 | 309 | none |
| badges-03-spawn-1-small | log-only | 3/3 | 8.2 | 0.1 | pass | 0.81/0.45/0.94 | 0.12/0.23/0.04 | none | 9661 | 5806 | 294 | none |
| badges-03-spawn-1-small | two-pass | 3/3 | 7.9 | 0.1 | pass | 0.86/0.08/0.95 | 0.13/0.22/0.04 | none | 18120 | 6161 | 658 | none |
| probe-constructed-fail-then-claim | full-diff-20k-tail | 1/1 | 2.5 | 0.0 | flag | 0.71/0.78/0.85 | 0.92/0.66/0.96 | contradicted_claim, untouched_criterion, failing_at_end | 21995 | 17706 | 1108 | none |
| probe-constructed-fail-then-claim | hunks-5k-tail | 1/1 | 2.5 | 0.0 | flag | 0.62/0.83/0.82 | 0.90/0.74/0.96 | contradicted_claim, untouched_criterion, failing_at_end | 13906 | 10160 | 325 | none |
| probe-constructed-fail-then-claim | log-only | 1/1 | 1.3 | 0.0 | flag | 0.19/0.92/0.92 | 0.95/0.72/0.97 | contradicted_claim, untouched_criterion, failing_at_end | 18011 | 13931 | 348 | none |
| probe-constructed-fail-then-claim | two-pass | 1/1 | 3.7 | 0.0 | flag | 0.54/0.74/0.47 | 0.74/0.79/0.31 | contradicted_claim, untouched_criterion | 31038 | 7712 | 795 | none |

| Attempt | budgets compared | max mean-score gap | verdict agreement |
|---|---|---|---|
| badges-01-large | full-diff-20k-tail, hunks-10k-tail, hunks-5k-tail, log-only | 1.4 | all agree: pass |
| badges-02-large-clean | hunks-5k-tail | 0.0 | all agree: pass |
| badges-03-attempt-1-mid | full-diff-20k-tail, hunks-10k-tail, hunks-5k-tail, log-only, two-pass | 1.6 | all agree: flag |
| badges-03-spawn-1-small | full-diff-20k-tail, hunks-10k-tail, hunks-5k-tail, log-only, two-pass | 0.5 | all agree: pass |
| probe-constructed-fail-then-claim | full-diff-20k-tail, hunks-5k-tail, log-only, two-pass | 2.4 | all agree: flag |

Live requests recorded across results, results-extra, results-probe, results-smoke: 54
