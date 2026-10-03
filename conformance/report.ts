/**
 * The runner's report (run.ts): every test's result read out of the JUnit
 * file `bun test` writes, counted per contract area. A case's area is the
 * tag that opens its name, `[http] GET /api/state ...`, which
 * harness/case.ts puts there; a test with no tag is one of the suite's own
 * checks, the boundary test say, and counts under `suite`.
 */

export type Outcome = "pass" | "fail" | "skip";

export interface TestResult {
  name: string;
  file: string;
  outcome: Outcome;
}

export interface AreaCount {
  area: string;
  pass: number;
  fail: number;
  skip: number;
}

/** The area untagged tests count under. */
export const SUITE_AREA = "suite";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity.toLowerCase()]!;
  });
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]!) : "";
}

/**
 * Every testcase in a Bun JUnit report, nested suites (describe blocks)
 * included. A case that failed carries a `<failure>` (an assertion or a
 * timeout alike) or an `<error>`; one that was skipped, a `<skipped>`.
 */
export function parseJunit(xml: string): TestResult[] {
  const results: TestResult[] = [];
  const testcase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(testcase)) {
    const tag = match[1]!;
    const body = match[3] ?? "";
    const outcome: Outcome = /<(failure|error)\b/.test(body) ? "fail" : /<skipped\b/.test(body) ? "skip" : "pass";
    results.push({ name: attribute(tag, "name"), file: attribute(tag, "file"), outcome });
  }
  return results;
}

/** A test's area: the tag its name opens with, or SUITE_AREA. */
export function areaOf(name: string): string {
  return /^\[([a-z][a-z0-9-]*)\] /.exec(name)?.[1] ?? SUITE_AREA;
}

/** The counts per area, areas in name order and the suite's own last. */
export function countByArea(results: TestResult[]): AreaCount[] {
  const counts = new Map<string, AreaCount>();
  for (const result of results) {
    const area = areaOf(result.name);
    const count = counts.get(area) ?? { area, pass: 0, fail: 0, skip: 0 };
    count[result.outcome] += 1;
    counts.set(area, count);
  }
  return [...counts.values()].sort((a, b) =>
    a.area === SUITE_AREA ? 1 : b.area === SUITE_AREA ? -1 : a.area.localeCompare(b.area),
  );
}

function share(count: { pass: number; fail: number; skip: number }): string {
  const total = count.pass + count.fail + count.skip;
  const percent = total === 0 ? 0 : Math.floor((count.pass / total) * 100);
  const notRun = count.skip > 0 ? `, ${count.skip} not run` : "";
  const failed = count.fail > 0 ? `, ${count.fail} failed` : "";
  return `${count.pass}/${total} passed (${percent}%${failed}${notRun})`;
}

/** The report as printed: one line per area, the total under them, then
 *  each failed test by name and file. */
export function formatReport(title: string, counts: AreaCount[], results: TestResult[] = []): string {
  const width = Math.max(5, ...counts.map((count) => count.area.length));
  const total = counts.reduce(
    (sum, count) => ({ pass: sum.pass + count.pass, fail: sum.fail + count.fail, skip: sum.skip + count.skip }),
    { pass: 0, fail: 0, skip: 0 },
  );
  const failed = results.filter((result) => result.outcome === "fail");
  return [
    title,
    ...counts.map((count) => `  ${count.area.padEnd(width)}  ${share(count)}`),
    `  ${"all".padEnd(width)}  ${share(total)}`,
    ...(failed.length > 0 ? ["", "failed:", ...failed.map((result) => `  ${result.name} (${result.file})`)] : []),
  ].join("\n");
}
