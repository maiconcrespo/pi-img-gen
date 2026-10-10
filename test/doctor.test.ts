/**
 * Behavior tests for the settings.json doctor (src/doctor.ts).
 *
 * Contract under test: the `/imagen` workflow depends on the exact
 * `"extensions": ["-builtin:codemode"]` entry in the Pi host settings.json
 * (README warning). The doctor must detect every way that dependency can be
 * broken and fail EARLY with an actionable message naming the file, the
 * required entry, and the minimal fix — and it must never throw while doing
 * so. Unit tests never touch the real filesystem: the reader and the home
 * directory are injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REQUIRED_EXTENSION_ENTRY,
  checkSettingsJson,
  defaultSettingsCandidates,
  loadSettingsJson,
  runDoctor,
  type DoctorFinding,
} from "../src/doctor.ts";

const FIX_SNIPPET = '"extensions": ["-builtin:codemode"]';

function assertActionable(findings: DoctorFinding[]): void {
  assert.ok(findings.length > 0, "expected at least one finding");
  for (const finding of findings) {
    assert.match(finding.message, /settings\.json/i, "must name the file concept");
    assert.match(finding.message, /"-builtin:codemode"/, "must name the exact required entry");
    assert.match(finding.message, /"extensions"/, "must name the extensions array");
    assert.ok(
      finding.message.includes(FIX_SNIPPET),
      `must include the minimal fix ${FIX_SNIPPET}: got ${finding.message}`,
    );
    assert.ok(finding.message.length > 0);
  }
}

// ---------------------------------------------------------------------------
// checkSettingsJson — pure content checks
// ---------------------------------------------------------------------------

test("a settings object without extensions is a finding, not a crash", () => {
  const findings = checkSettingsJson({});
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "extensions-missing");
  assertActionable(findings);
});

test("an extensions value that is not an array is a finding", () => {
  const findings = checkSettingsJson({ extensions: "-builtin:codemode" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "extensions-not-array");
  assertActionable(findings);
});

test("an extensions array without -builtin:codemode is a finding", () => {
  const findings = checkSettingsJson({ extensions: ["-builtin:mcp", "./some-ext.ts"] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "required-entry-missing");
  assertActionable(findings);
});

test("the exact single-entry array passes with no findings", () => {
  assert.deepEqual(checkSettingsJson({ extensions: ["-builtin:codemode"] }), []);
});

test("extra array entries are fine as long as -builtin:codemode is present", () => {
  assert.deepEqual(
    checkSettingsJson({ extensions: ["-builtin:mcp", "-builtin:codemode", "./extra.ts"] }),
    [],
  );
});

test("malformed settings shapes produce findings, never throws", () => {
  for (const malformed of [null, undefined, "settings", 42, true, []]) {
    const findings = checkSettingsJson(malformed);
    assert.ok(findings.length > 0, `expected findings for ${JSON.stringify(malformed)}`);
    assertActionable(findings);
  }
});

test("near-miss spellings of the entry do not count as present", () => {
  for (const near of ["-builtin:codemode ", " -builtin:codemode", "-builtin:CodeMode", "codemode"]) {
    const findings = checkSettingsJson({ extensions: [near] });
    assert.equal(findings.length, 1, `expected a finding for ${JSON.stringify(near)}`);
    assert.equal(findings[0].code, "required-entry-missing");
  }
});

test("findings name the settings file path when one is known", () => {
  const findings = checkSettingsJson({}, "/home/someone/.pi/agent/settings.json");
  assert.match(findings[0].message, /\/home\/someone\/\.pi\/agent\/settings\.json/);
});

// ---------------------------------------------------------------------------
// loadSettingsJson — candidate resolution and IO safety (injected IO only)
// ---------------------------------------------------------------------------

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
}

function eacces(): NodeJS.ErrnoException {
  return Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
}

test("the explicit path argument is read first and wins", async () => {
  const calls: string[] = [];
  const result = await loadSettingsJson({
    settingsPath: "/explicit/settings.json",
    homedir: () => "/home/tester",
    readFile: async (path) => {
      calls.push(path);
      return '{"extensions": ["-builtin:codemode"]}';
    },
  });
  assert.deepEqual(calls, ["/explicit/settings.json"], "home candidates must not be read");
  assert.equal(result.findings.length, 0);
  assert.equal(result.loaded?.path, "/explicit/settings.json");
});

test("resolution falls through missing candidates to the documented host homes", async () => {
  const candidates = defaultSettingsCandidates("/home/tester");
  const calls: string[] = [];
  const result = await loadSettingsJson({
    settingsPath: "/explicit/gone.json",
    homedir: () => "/home/tester",
    readFile: async (path) => {
      calls.push(path);
      if (path !== candidates[1]) throw enoent();
      return '{"extensions": ["-builtin:codemode"]}';
    },
  });
  assert.deepEqual(calls, ["/explicit/gone.json", candidates[0], candidates[1]]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.loaded?.path, candidates[1]);
});

test("host home candidates are the gentle-shell and pi agent homes", () => {
  assert.deepEqual(defaultSettingsCandidates("/home/tester"), [
    "/home/tester/.gentle-shell/agent/settings.json",
    "/home/tester/.pi/agent/settings.json",
  ]);
});

test("no settings file anywhere is an actionable finding naming the searched paths", async () => {
  const result = await loadSettingsJson({
    homedir: () => "/home/tester",
    readFile: async () => {
      throw enoent();
    },
  });
  assert.equal(result.loaded, undefined);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "settings-not-found");
  assert.match(result.findings[0].message, /\.gentle-shell\/agent\/settings\.json/);
  assert.match(result.findings[0].message, /\.pi\/agent\/settings\.json/);
  assertActionable(result.findings);
});

test("an unreadable settings file is an actionable finding, not a throw", async () => {
  const result = await loadSettingsJson({
    settingsPath: "/explicit/settings.json",
    homedir: () => "/home/tester",
    readFile: async () => {
      throw eacces();
    },
  });
  assert.equal(result.loaded, undefined);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "settings-unreadable");
  assert.match(result.findings[0].message, /\/explicit\/settings\.json/);
  assertActionable(result.findings);
});

test("an unparseable settings file is an actionable finding, not a throw", async () => {
  const result = await loadSettingsJson({
    settingsPath: "/explicit/settings.json",
    homedir: () => "/home/tester",
    readFile: async () => "{ this is not json",
  });
  assert.equal(result.loaded, undefined);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "settings-unparseable");
  assert.match(result.findings[0].message, /\/explicit\/settings\.json/);
  assertActionable(result.findings);
});

// ---------------------------------------------------------------------------
// runDoctor — load + check combined, still never throwing
// ---------------------------------------------------------------------------

test("runDoctor passes when the second home candidate holds the required entry", async () => {
  const candidates = defaultSettingsCandidates("/home/tester");
  const findings = await runDoctor({
    homedir: () => "/home/tester",
    readFile: async (path) => {
      if (path !== candidates[1]) throw enoent();
      return JSON.stringify({ extensions: ["-builtin:mcp", "-builtin:codemode"] });
    },
  });
  assert.deepEqual(findings, []);
});

test("runDoctor reports content findings that name the file that was checked", async () => {
  const candidates = defaultSettingsCandidates("/home/tester");
  const findings = await runDoctor({
    homedir: () => "/home/tester",
    readFile: async (path) => {
      if (path !== candidates[0]) throw enoent();
      return JSON.stringify({ extensions: ["-builtin:mcp"] });
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "required-entry-missing");
  assert.match(findings[0].message, /\.gentle-shell\/agent\/settings\.json/);
  assertActionable(findings);
});

test("runDoctor converts unexpected reader failures into findings", async () => {
  const findings = await runDoctor({
    settingsPath: "/explicit/settings.json",
    homedir: () => "/home/tester",
    readFile: async () => {
      throw new Error("disk on fire");
    },
  });
  assert.equal(findings.length, 1);
  assertActionable(findings);
});

test("the required entry constant matches the documented settings line", () => {
  assert.equal(REQUIRED_EXTENSION_ENTRY, "-builtin:codemode");
});
