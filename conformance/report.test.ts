/**
 * The runner's report over the JUnit file Bun 1.3 writes: the shape below
 * is one `bun test --reporter=junit` wrote, a describe block, an escaped
 * name, a skip and a timeout included.
 */

import { describe, expect, it } from "bun:test";
import { areaOf, countByArea, formatReport, parseJunit, SUITE_AREA } from "./report.ts";

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="6" assertions="3" failures="2" skipped="1" time="0.08">
  <testsuite name="cases/http.test.ts" file="cases/http.test.ts" tests="4" assertions="2" failures="2" skipped="0" time="0.05" hostname="h">
    <testcase name="[socket] fails &lt;here&gt; &amp; &quot;there&quot;" classname="" time="0.0001" file="cases/http.test.ts" line="2" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testsuite name="group" file="cases/http.test.ts" line="3" tests="1" assertions="0" failures="0" skipped="0" time="0" hostname="h">
      <testcase name="[disk] nested pass" classname="group" time="0.00002" file="cases/http.test.ts" line="3" assertions="0" />
    </testsuite>
    <testcase name="[http] times out" classname="" time="0.05" file="cases/http.test.ts" line="4" assertions="0">
      <failure type="TimeoutError" />
    </testcase>
    <testcase name="[http] passes" classname="" time="0.0001" file="cases/http.test.ts" line="5" assertions="1" />
  </testsuite>
  <testsuite name="boundary.test.ts" file="boundary.test.ts" tests="2" assertions="1" failures="0" skipped="1" time="0" hostname="h">
    <testcase name="holds for every file" classname="the conformance boundary" time="0.001" file="boundary.test.ts" line="9" assertions="1" />
    <testcase name="[http] not built" classname="" time="0" file="boundary.test.ts" line="12" assertions="0">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>
`;

describe("the conformance report", () => {
  it("reads every testcase, nested and escaped ones included", () => {
    expect(parseJunit(JUNIT)).toEqual([
      { name: '[socket] fails <here> & "there"', file: "cases/http.test.ts", outcome: "fail" },
      { name: "[disk] nested pass", file: "cases/http.test.ts", outcome: "pass" },
      { name: "[http] times out", file: "cases/http.test.ts", outcome: "fail" },
      { name: "[http] passes", file: "cases/http.test.ts", outcome: "pass" },
      { name: "holds for every file", file: "boundary.test.ts", outcome: "pass" },
      { name: "[http] not built", file: "boundary.test.ts", outcome: "skip" },
    ]);
  });

  it("takes a test's area from its tag, and an untagged test as the suite's own", () => {
    expect(areaOf("[http] GET /api/state")).toBe("http");
    expect(areaOf("holds for every file")).toBe(SUITE_AREA);
    expect(areaOf("[Not An Area] x")).toBe(SUITE_AREA);
  });

  it("counts per area, the suite's own last, and names what failed", () => {
    const results = parseJunit(JUNIT);
    const counts = countByArea(results);
    expect(counts).toEqual([
      { area: "disk", pass: 1, fail: 0, skip: 0 },
      { area: "http", pass: 1, fail: 1, skip: 1 },
      { area: "socket", pass: 0, fail: 1, skip: 0 },
      { area: SUITE_AREA, pass: 1, fail: 0, skip: 0 },
    ]);
    expect(formatReport("conformance", counts, results)).toBe(
      [
        "conformance",
        "  disk    1/1 passed (100%)",
        "  http    1/3 passed (33%, 1 failed, 1 not run)",
        "  socket  0/1 passed (0%, 1 failed)",
        "  suite   1/1 passed (100%)",
        "  all     3/6 passed (50%, 2 failed, 1 not run)",
        "",
        "failed:",
        '  [socket] fails <here> & "there" (cases/http.test.ts)',
        "  [http] times out (cases/http.test.ts)",
      ].join("\n"),
    );
  });
});
