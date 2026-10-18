/**
 * The Line's Finish (ADR-0039), seen from outside the server: Prove keeps its evidence in the
 * pool's runs directory, Decide writes the report for its pass, the Finish hold links the latest
 * one and GET /api/line/report serves it. Approval is the operator's, refused while anything in the
 * pool still runs, and only then does the Finish Ticket `finish-1-act` carry out the act: nothing
 * leaves the pool before it. A Line pool's Review is its Finish.
 */

import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conformance } from "../harness/case.ts";
import { answer, resume, settle, snapshot, statuses, ticketOf } from "../harness/pool-run.ts";
import { readStateLine, until } from "../harness/pool-files.ts";
import {
  REPORT_HTML,
  SHIP,
  approveFinish,
  atCheckpoint,
  begun,
  interruptOn,
  issue,
  launches,
  lineWorld,
  passPath,
  reportOf,
  verdict,
} from "./line-support.ts";

const URL = "https://github.com/o/r/pull/7";

conformance("line", "Finish none: Prove's evidence stays in the runs directory, Decide writes its pass's report, the Finish hold links it, GET /api/line/report serves it, and approval ends the run with no Review", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  const server = await t.start(world);
  const none = await server.http.get("/api/line/report?node=decide&pass=1");
  expect(none.status).toBe(404);
  expect(none.json<{ reason: string }>().reason).toBe("the pool runs no Line");
  const vacuous = await settle(server, (s) => s.state.interrupts.some((i) => i.kind === "review"), { what: "the empty pool's Review" });
  expect(vacuous.state.interrupts.map((i) => i.ticketId)).toEqual(["REVIEW"]);
  await begun(server);

  const report = reportOf(world, 1);
  const atFinish = await atCheckpoint(server, "finish-1");
  expect(issue(world, "decide-1")).toContain(
    `## The report\n\nBefore you record your Outcome, write the report with /html to \`${report}\`: every Prove's evidence, linked at its path in the pool's runs directory beside the report (\`<prove ticket>.evidence/\`, so a relative link works), every Review finding`,
  );
  const prove = issue(world, "prove-1");
  expect(prove).toContain(
    `Write the evidence to \`${join(world.pool, "runs", "prove-1.evidence")}/\`, and name that path in your verdict's "evidence".`,
  );
  expect(prove).toContain("this one path is yours to write despite the rule against writing into the pool directory. Never commit the evidence.");
  expect(readFileSync(report, "utf8")).toBe(REPORT_HTML);
  expect(interruptOn(atFinish, "finish-1")).toContain(`The report: ${report} (open it in the Console's Detail).`);
  expect(interruptOn(atFinish, "finish-1")).toContain('Resume with "approved" (or no note) to approve the Line and end it;');

  const served = await server.http.get("/api/line/report?node=decide&pass=1");
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("text/html;charset=utf-8");
  expect(served.headers.get("cache-control")).toBe("no-store");
  expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-popups");
  expect(served.text).toBe(REPORT_HTML);
  const unknown = await server.http.get("/api/line/report?node=nope&pass=1");
  expect(unknown.status).toBe(404);
  expect(unknown.json<{ reason: string }>().reason).toBe("the Line has no node nope");

  expect(atFinish.line).toMatchObject({ status: "finishing", waitingFor: [] });
  expect(atFinish.state.interrupts.map((i) => i.ticketId)).toEqual(["finish-1"]);
  const done = await approveFinish(server, "finish-1");
  expect(done.state.interrupts).toEqual([]);
  expect(done.line?.status).toBe("done");
  const from = done.state.log.findIndex((l) => l.startsWith("line: began on the Plan"));
  expect(from).toBeGreaterThan(-1);
  expect(done.state.log.slice(from).some((l) => l.includes("REVIEW"))).toBe(false);
});

conformance("line", "Finish draft-pr: approval writes finish-1-act, which opens the draft PR from the Line's branch and whose Outcome must carry the PR's url, and the Line is done once it merges", async (t) => {
  const world = lineWorld(t, { spec: "docs/specs/line.md", finish: "draft-pr" });
  world.git(["checkout", "-q", "-b", "line/x"]);
  passPath(world);
  world.stubs.launches("finish-1-act", [verdict(null), verdict({ url: URL })]);
  const server = await t.start(world);
  await begun(server);

  const atFinish = await atCheckpoint(server, "finish-1");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "review-1", "decide-1"]);
  expect(issue(world, "review-1")).toContain(
    "Review the work on the Line's branch (the changes since it left main) against the spec",
  );
  expect(issue(world, "decide-1")).not.toContain("gh pr");
  expect(interruptOn(atFinish, "finish-1")).toContain(`The report: ${reportOf(world, 1, "x")}`);
  expect(interruptOn(atFinish, "finish-1")).toContain(
    "to approve the Line, after which `finish-1-act` carries out the Finish (`draft-pr`);",
  );

  await answer(server, { ticketId: "finish-1", note: "approved" });
  const unverdicted = await atCheckpoint(server, "finish-1-act");
  expect(launches(world)).toEqual(["implement-1", "prove-1", "review-1", "decide-1", "finish-1-act"]);
  expect(interruptOn(unverdicted, "finish-1-act")).toStartWith("no verdict\n\nthe verdict has no url: give the PR's url.");
  expect(unverdicted.line).toMatchObject({ status: "acting", act: "finish-1-act" });
  expect(readStateLine(world.pool, "finish-1-act.md").line).toStartWith(
    "<!-- state: id=finish-1-act blocked-by=finish-1 status=checkpoint node=finish",
  );
  expect(ticketOf(unverdicted, "finish-1-act").assignment).toMatchObject({ harness: "claude", model: "m" });
  const act = issue(world, "finish-1-act");
  expect(act).toContain("# finish-1-act: Finish: draft-pr\n");
  expect(act).toContain(
    "`draft-pr`: open a draft PR for the Line. First delete the Line's spec and briefs (`docs/specs/x*`) and any `.verify/` directory committed on the Line's branch (Prove's evidence belongs in the pool, never in the PR), in one final commit on your branch. Then push your HEAD as the Line's branch (`git push origin HEAD:line/x`).",
  );
  expect(act).toContain("`gh pr create --draft --base main --head line/x`");
  expect(act).not.toContain("pushBase");

  await answer(server, { ticketId: "finish-1-act", note: "record the url" });
  const done = await settle(server, (s) => s.phase === "done", { what: "the run to be done" });
  expect(statuses(done)["finish-1-act"]).toBe("done");
  expect(done.state.outcomes["finish-1-act"]?.verdict).toEqual({ url: URL });
  expect(done.line?.status).toBe("done");
  expect(done.state.interrupts).toEqual([]);
});

conformance("line", "approving the Finish is refused with what it waits for while a Ticket outside the Line runs, and accepted once it is done", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  const first = await t.start(world);
  await begun(first);
  await atCheckpoint(first, "finish-1");
  await first.stop();

  writeFileSync(
    join(world.pool, "issues", "tidy.md"),
    "<!-- state: id=tidy blocked-by=none status=ready -->\n\n# tidy: Tidy the pool log\n\nTidy the pool log lines the Line writes, they repeat.\n",
  );
  const tidy = world.stubs.hold("tidy");
  const second = await t.start(world);
  await until(
    () => readStateLine(world.pool, "tidy.md").line,
    (line) => line.includes("status=in-progress"),
    { what: "tidy to launch" },
  );
  const refused = await resume(second, { ticketId: "finish-1", note: "approved" });
  expect(refused.status).toBe(409);
  expect(refused.json<{ error: string }>().error).toBe("answer: the Finish is waiting for: tidy");
  const still = await snapshot(second);
  expect(statuses(still)["finish-1"]).toBe("checkpoint");
  expect(still.state.interrupts.map((i) => i.ticketId)).toEqual(["finish-1"]);
  expect(still.line?.waitingFor).toEqual(["tidy"]);

  await tidy.release();
  await settle(second, (s) => statuses(s).tidy === "done", { what: "tidy to be done" });
  const done = await approveFinish(second, "finish-1");
  expect(done.line?.status).toBe("done");
});

conformance("line", "a Decide that ships without writing its report is the no-verdict checkpoint, and the Resume that writes it reaches the Finish", async (t) => {
  const world = lineWorld(t);
  passPath(world);
  world.stubs.launches("decide-1", [verdict({ decide: "ship" }), SHIP]);
  const server = await t.start(world);
  await begun(server);

  const report = reportOf(world, 1);
  const decide = await atCheckpoint(server, "decide-1");
  expect(interruptOn(decide, "decide-1")).toStartWith(
    `no verdict\n\nthe report is not at ${report}: write the report there, then record the verdict.`,
  );
  const missing = await server.http.get("/api/line/report?node=decide&pass=1");
  expect(missing.status).toBe(404);
  expect(missing.json<{ reason: string }>().reason).toBe("no report yet: decide pass 1 has written none");
  await answer(server, { ticketId: "decide-1", note: "write the report first" });
  await atCheckpoint(server, "finish-1");
  expect((await server.http.get("/api/line/report?node=decide&pass=1")).text).toBe(REPORT_HTML);
});

conformance("line", "a PR Finish on a pool whose branch is no Line branch tells finish-1-act to push nothing, and its checkpoint is the operator's to Close", async (t) => {
  const world = lineWorld(t, { spec: "docs/specs/line.md", finish: "pr" });
  passPath(world);
  world.stubs.script("finish-1-act", { status: "checkpoint", brief: "the Finish was not carried out: main is no Line branch" });
  const server = await t.start(world);
  await begun(server);

  await atCheckpoint(server, "finish-1");
  await answer(server, { ticketId: "finish-1" });
  const stopped = await atCheckpoint(server, "finish-1-act");
  const act = issue(world, "finish-1-act");
  expect(act).toContain(
    "`pr`: but the pool's branch `main` is not a Line branch (line/...), so push nothing and open no PR, and record a checkpoint Outcome whose brief says the Finish was not carried out, and why.",
  );
  expect(act).not.toContain("git push");
  expect(interruptOn(stopped, "finish-1-act")).toContain("the Finish was not carried out: main is no Line branch");

  await answer(server, { ticketId: "finish-1-act", action: "close" });
  const closed = await settle(server, (s) => s.phase === "done", { what: "the run to be done" });
  expect(closed.line?.status).toBe("closed");
  expect(closed.state.interrupts).toEqual([]);
});
