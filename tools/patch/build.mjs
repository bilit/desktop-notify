// Builds, and checks, ONE checked-in patch that recreates the whole project when applied to an empty folder. It lets
// someone get the code without cloning or downloading a zip:
//
//   mkdir desktop-notify && cd desktop-notify
//   git apply ../desktop-notify.patch                              (or: curl -L <raw url of the file> | git apply)
//
//   npm run patch          regenerate patches/desktop-notify.patch (run it before committing code changes)
//   npm run patch:check    fail if the committed patch no longer recreates the current files exactly
//
// What goes in: exactly the files git would publish (tracked, plus untracked-but-not-ignored), minus patches/ itself.
// Anything in .gitignore (node_modules, build output, local demos, keys) cannot end up in it. What stays out:
// authorship. It is a plain diff, not `git format-patch`, so it carries no author name, email or dates.
//
// The check applies the patch to an empty folder and compares files, rather than comparing patch text: the compressed
// binary sections are not guaranteed to be byte-identical between machines, but the files they produce are.
// Needs `git` on the PATH (the patch contains binary files, so plain `patch` cannot apply it).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const OWN_DIR = 'patches/'; // the patch is never part of itself
const outFile = path.join(root, 'patches', 'desktop-notify.patch');
const checkOnly = process.argv.includes('--check');

// Git's well-known empty tree: diffing against it makes every file show up as "new".
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BINARY_EXT = new Set(['.png', '.ico', '.icns', '.jpg', '.jpeg', '.gif', '.exe', '.dll', '.zip']);

// Ignore the user's own git configuration (CRLF conversion, global ignore rules, hooks) so the output is the same on every
// machine: LF line endings, no host-specific behaviour.
const ISOLATED = ['-c', 'core.autocrlf=input', '-c', 'core.safecrlf=false', '-c', 'core.excludesfile=', '-c', 'core.hooksPath=',
  '-c', 'user.name=patch', '-c', 'user.email=patch@invalid'];

function git(cwd, args, { buffer = false } = {}) {
  return execFileSync('git', [...ISOLATED, ...args], {
    cwd,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const normalize = (buf) => Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'); // compare text ignoring CRLF vs LF
const rel = (p) => path.relative(root, p).split(path.sep).join('/');

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  git(root, ['--version']);
} catch {
  fail('git was not found on the PATH; it is needed to build and apply the patch');
}
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' });
} catch {
  fail(
    'This folder is not a git repository. The list of files comes from git (so nothing in .gitignore can leak into the\n' +
      'patch). If you got this code by applying the patch, run `git init` here first.'
  );
}

// The files to publish, straight from git's own view of the repository.
const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\0').filter(Boolean);
const files = [...new Set(listed)]
  .filter((f) => !f.startsWith(OWN_DIR))
  .filter((f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile())
  .sort();
if (files.length === 0) fail('no files to put in the patch');

/** Apply `patchFile` to a brand-new empty folder and compare with the working copy. Returns a list of problems. */
function applyAndCompare(patchFile, work) {
  const applied = path.join(work, 'applied');
  fs.mkdirSync(applied);
  try {
    git(applied, ['apply', '--whitespace=nowarn', patchFile]);
  } catch (e) {
    return [`git apply failed: ${String(e.stderr || e.message).trim().split('\n')[0]}`];
  }

  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else found.push(path.relative(applied, p).split(path.sep).join('/'));
    }
  };
  walk(applied);
  found.sort();

  const problems = [];
  const missing = files.filter((f) => !found.includes(f));
  const extra = found.filter((f) => !files.includes(f));
  if (missing.length) problems.push(`new in the working copy, not in the patch: ${missing.join(', ')}`);
  if (extra.length) problems.push(`in the patch, no longer in the working copy: ${extra.join(', ')}`);
  for (const f of files.filter((x) => found.includes(x))) {
    const a = fs.readFileSync(path.join(root, f));
    const b = fs.readFileSync(path.join(applied, f));
    const same = BINARY_EXT.has(path.extname(f).toLowerCase()) ? a.equals(b) : normalize(a).equals(normalize(b));
    if (!same) problems.push(`changed since the patch was made: ${f}`);
  }
  return problems;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-notify-patch-'));
try {
  if (checkOnly) {
    if (!fs.existsSync(outFile)) fail(`${rel(outFile)} does not exist. Run: npm run patch`);
    const problems = applyAndCompare(outFile, work);
    if (problems.length) {
      fail(`${rel(outFile)} is OUT OF DATE:\n  ${problems.join('\n  ')}\nRegenerate it with: npm run patch`);
    }
    console.log(`${rel(outFile)} is up to date: applying it to an empty folder recreates all ${files.length} files exactly`);
  } else {
    // Stage the files in a throwaway repository and diff against the empty tree.
    const staging = path.join(work, 'staging');
    for (const f of files) {
      const to = path.join(staging, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(root, f), to);
    }
    git(staging, ['init', '-q']);
    git(staging, ['add', '-A', '-f']);
    const diff = git(staging, ['diff', '--cached', '--binary', '--no-renames', '--full-index', EMPTY_TREE], { buffer: true });

    // `git apply` skips any text before the first "diff --git" line, so the file can explain itself.
    const header = Buffer.from(
      [
        `desktop-notify ${version}`,
        '',
        'A literal patch: applied to an EMPTY folder it creates every file and folder of this project.',
        '',
        '    mkdir desktop-notify && cd desktop-notify && git apply ../desktop-notify.patch',
        '',
        'Needs git (it contains binary files). Generated by `npm run patch`; do not edit by hand.',
        '',
        '',
      ].join('\n')
    );
    const patch = Buffer.concat([header, diff]);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, patch);

    const problems = applyAndCompare(outFile, work);
    if (problems.length) fail(`${rel(outFile)} was written but FAILED verification:\n  ${problems.join('\n  ')}`);

    console.log(`wrote ${rel(outFile)}`);
    console.log(`  ${files.length} files, ${(patch.length / 1024).toFixed(0)} KB, sha256 ${sha256(patch)}`);
    console.log('  verified: applied to an empty folder, all files identical to the working copy');
    console.log('\nit is meant to be committed:  git add patches/desktop-notify.patch');
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}
