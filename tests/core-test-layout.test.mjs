// tests/core-test-layout.test.mjs — a suite that is not under tests/ does not run.
//
// test-all.mjs discovers `tests/**/*.test.mjs` and nothing else (#1440), and
// that limit is deliberate: it keeps the runner away from standalone files at
// the repository root. The cost is that a suite written anywhere else is
// invisible in the quietest possible way: the file exists, it is committed,
// `--only <name>` says "no test files matched", and the suite prints green
// assertions the moment somebody runs it by hand.
//
// lib/context-budget.test.mjs sat there with the #2234 guard that every
// modes/_shared.md heading is classified in SECTION_PRIORITY, so a
// scoring-critical section cannot silently become compressible. That guard
// had never run in CI. The sibling check for web/'s own discovery glob is
// tests/web-test-layout.test.mjs; this is the core half, kept in tests/
// rather than inline in test-all.mjs so `--only` can reach it.
import { pass, fail, warn, ROOT } from './helpers.mjs';
import { collectMjsFiles } from '../lib/mjs-files.mjs';
import { existsSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';

console.log('\ncore test layout — every suite lives where a runner can find it');

// The roots a runner actually discovers: test-all.mjs's discoverTests() over
// tests/, web/'s own `npm test` glob over web/tests/, and the private MCP
// project's separate test command under sites/career-ops-mcp/tests/.
const DISCOVERED_ROOTS = ['tests/', 'web/tests/', 'sites/career-ops-mcp/tests/'];

// collectMjsFiles() skips node_modules, output/, data/ and any nested checkout
// (a linked worktree marks itself with a `.git` FILE, #3499), so a developer
// with a worktree open is not graded on somebody else's tree.
const suites = collectMjsFiles(ROOT)
  .map((f) => relative(ROOT, f).split(sep).join('/'))
  .filter((rel) => rel.endsWith('.test.mjs'));

if (suites.length === 0) {
  // An empty walk means the walk is broken, not that the repo has no tests;
  // passing here would report health while checking nothing.
  fail('collectMjsFiles() found no *.test.mjs at all: the walk is broken, not the repo');
} else {
  const orphans = suites.filter((rel) => !DISCOVERED_ROOTS.some((dir) => rel.startsWith(dir)));
  if (orphans.length === 0) {
    pass(`all ${suites.length} *.test.mjs files live under ${DISCOVERED_ROOTS.join(' or ')}`);
  } else {
    for (const rel of orphans) {
      fail(`${rel} is a *.test.mjs outside ${DISCOVERED_ROOTS.join(' and ')}: no runner discovers it, move it under tests/`);
    }
  }
}

// Sites is a separate private project, so test-all.mjs invokes its discovered
// suites in a separate Node test process instead of mixing them into tests/.
// If the project is present, its own manifest must declare the same discovery
// glob and at least one suite; absence is an explicit core-only checkout case.
const SITES_ROOT = join(ROOT, 'sites', 'career-ops-mcp');
const sitesPackagePath = join(SITES_ROOT, 'package.json');
if (!existsSync(sitesPackagePath)) {
  warn('private MCP Sites project is absent — its separate test command is not applicable in this checkout');
} else {
  try {
    const pkg = JSON.parse(readFileSync(sitesPackagePath, 'utf8'));
    const projectSuites = suites.filter((rel) => rel.startsWith('sites/career-ops-mcp/tests/'));
    if (pkg.scripts?.test !== 'node --test tests/*.test.mjs') {
      fail(`Sites project test script no longer matches its standalone test discovery contract: ${pkg.scripts?.test ?? '(missing)'}`);
    } else if (projectSuites.length === 0) {
      fail('Sites project declares node --test tests/*.test.mjs but contains no *.test.mjs suites');
    } else {
      pass(`Sites project has ${projectSuites.length} suite(s) for its standalone test command`);
    }
  } catch (error) {
    fail(`could not inspect the private MCP Sites test project: ${error.message}`);
  }
}
