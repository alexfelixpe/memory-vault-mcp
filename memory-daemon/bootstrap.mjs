#!/usr/bin/env node
// Bootstraps memory-daemon in one command. Before this script existed, a new
// user had to run four commands by hand, and one of them has a Windows-only
// trap: plain `npm install` tries to compile better-sqlite3 from source with
// node-gyp, which needs the Visual Studio C++ tools and usually fails without
// them. This script makes the platform call, runs install, build, link and
// doctor in order, and reports each step as it happens. It spawns npm as
// npm-cli.js through the current node binary rather than as the npm command
// itself, because Node no longer allows spawning the Windows npm.cmd shim
// without a shell.
//
// Usage: npm run bootstrap   (from memory-daemon/)
//        node bootstrap.mjs [--dry-run]
//
// It does not run `memory init --hooks`. That step picks a vault folder and
// edits the user's global Claude Code settings, so it stays a manual, seen
// step. See README.md Quickstart for the full picture and the manual
// fallback commands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Resolve memory-daemon/ from this file's own location, never from
// process.cwd(). That way the script works the same whether it runs as
// `npm run bootstrap` inside memory-daemon/, or as
// `node memory-daemon/bootstrap.mjs` from the repo root.
const memoryDaemonDir = path.dirname(fileURLToPath(import.meta.url));

const dryRun = process.argv.includes('--dry-run');

// The platform decision this whole script exists for: on Windows, skip the
// native compile that usually fails, and make it up with a mandatory build
// step later.
const isWindows = process.platform === 'win32';
const npmInstallArgs = isWindows ? ['install', '--ignore-scripts'] : ['install'];
const doctorArgs = [path.join('dist', 'cli', 'memory.js'), 'doctor'];

console.log(`memory-daemon bootstrap${dryRun ? ' (dry run)' : ''}`);
console.log(`working directory: ${memoryDaemonDir}`);

// Step 1: node version. package.json's engines field is the one source of
// truth for the minimum version, so this reads it instead of hardcoding 22 a
// second time in a second file.
const nodeCheck = checkNodeVersion();
if (!nodeCheck.ok && !dryRun) {
  process.exit(1);
}

// npm itself is a .cmd shim on Windows, not a .exe. Since the Node
// CVE-2024-27980 fix, spawning a .cmd file directly with no shell fails with
// EINVAL, and shell:true brings back the deprecation warning and the
// path-quoting problem. Spawning npm-cli.js with the same node that is
// running this script avoids the shim and the shell on every platform. If
// npm-cli.js cannot be found, nothing later in this script can work, so this
// check runs before the dry-run branch too and stops the run either way.
const npmCli = resolveNpmCli();
if (!npmCli.path) {
  console.error('FAILED: could not find npm-cli.js.');
  for (const checked of npmCli.checked) {
    console.error(`    checked: ${checked}`);
  }
  console.error('    run the manual commands in README.md Quickstart instead.');
  process.exit(1);
}

if (dryRun) {
  printPlan(nodeCheck);
  console.log('\ndry run: nothing was changed.');
  process.exit(0);
}

// Step 2: install. This is the step with the Windows trap; npmInstallArgs
// above already carries the platform decision.
const install = runStep('npm install', process.execPath, [npmCli.path, ...npmInstallArgs]);
if (!install.ok) {
  process.exit(install.code);
}

// Step 3: build. Mandatory on every platform, not only Windows: on Windows,
// --ignore-scripts also skipped the `prepare` script above, which is what
// normally builds the project, so without this step there is no dist/
// folder at all. On other platforms the build already ran once during
// install; running it again here is cheap and idempotent, so it is simplest
// to just always do it.
const build = runStep('npm run build', process.execPath, [npmCli.path, 'run', 'build']);
if (!build.ok) {
  process.exit(build.code);
}

// Step 4: link. A failure here is usually a permissions problem on macOS or
// Linux, and it must not stop the rest of the run: the CLI still works
// without it, just under a longer command.
const link = runStep('npm link', process.execPath, [npmCli.path, 'link']);
if (!link.ok) {
  console.log('    the memory command will not be on your PATH.');
  console.log('    fallback: run node dist/cli/memory.js <command> instead of memory <command>.');
}

// Step 5: doctor. Its output is shown as is, inherited straight to this
// terminal. If it says hybrid search is off, that message is doctor's own
// and is printed here unchanged; this script does not write a second,
// competing version of that fix text. Doctor checks an install that is
// already configured, and memory init is the command that writes that
// config, so on a machine where init has never run, doctor's config check
// always fails. That failure is expected here, not a build problem, so
// doctor never sets the exit code and never stops the run: only the node
// check, install and build do that.
const doctor = runStep('memory doctor', process.execPath, doctorArgs);
if (!doctor.ok) {
  console.log('\na config FAIL above is expected before memory init has ever run.');
  console.log('memory init is the command that creates the config doctor checks.');
}

// Step 6: the one step this script deliberately does not do. It changes
// global Claude Code settings, so the user runs it themselves and sees the
// result. Always printed, whether doctor passed or not.
printNextStep();

// Reads the minimum node version from package.json and compares it to the
// node that is running this script right now. Never throws; a bad
// package.json is reported as a failed check, not a crash.
function checkNodeVersion() {
  const pkgPath = path.join(memoryDaemonDir, 'package.json');
  let required = '>=22';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.engines && pkg.engines.node) {
      required = pkg.engines.node;
    }
  } catch (e) {
    console.error(`WARN: could not read ${pkgPath}, assuming node ${required}.`);
  }
  const minMajor = Number((required.match(/\d+/) ?? ['22'])[0]);
  const currentMajor = Number(process.versions.node.split('.')[0]);
  const ok = currentMajor >= minMajor;
  if (ok) {
    console.log(`ok: node ${process.versions.node} (needs ${required})`);
  } else {
    console.error(`FAILED: node ${process.versions.node} is too old. This project needs node ${required}.`);
    console.error('    install node 22 or newer, then run this again.');
  }
  return { ok, required };
}

// Finds npm-cli.js so npm can be spawned as a plain node script instead of
// through a platform-specific shim. Tries four places, in order, first hit
// wins:
//   1. npm_execpath, but only when it really points at npm-cli.js. Other
//      package managers set this same variable to their own launcher (pnpm
//      sets it to pnpm.cjs, Yarn to yarn.js or a Yarn Berry release file,
//      corepack to its own shim), so a plain existence check would run the
//      wrong tool under a step that still says npm.
//   2. The Windows layout, npm bundled next to node.exe under node_modules.
//   3. The Unix prefix layout: node in <prefix>/bin, npm under
//      <prefix>/lib/node_modules. This is what the official tarball, nvm,
//      fnm, volta and homebrew all use. None of them place npm next to the
//      node binary the way Windows does; that comment used to say
//      otherwise and was wrong.
//   4. A PATH walk that resolves each candidate with fs.realpathSync. This
//      is what Debian and Ubuntu need, where the npm binary on PATH is a
//      chain of symlinks ending at npm-cli.js somewhere neither layout
//      above predicts. A broken link is skipped, not thrown.
// Never throws; a full miss is reported by the caller with every path this
// function checked.
function resolveNpmCli() {
  const checked = [];

  const fromEnv = process.env.npm_execpath;
  if (fromEnv) {
    if (path.basename(fromEnv) === 'npm-cli.js' && fs.existsSync(fromEnv)) {
      return { path: fromEnv, source: 'npm_execpath' };
    }
    console.error(`WARN: npm_execpath does not point at npm-cli.js, ignoring it: ${fromEnv}`);
    checked.push(`npm_execpath (ignored, not npm-cli.js): ${fromEnv}`);
  } else {
    checked.push('npm_execpath is not set');
  }

  const windowsLayout = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(windowsLayout)) {
    return { path: windowsLayout, source: 'windows layout, next to node.exe' };
  }
  checked.push(windowsLayout);

  const unixPrefixLayout = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(unixPrefixLayout)) {
    return { path: unixPrefixLayout, source: 'unix prefix layout' };
  }
  checked.push(unixPrefixLayout);

  const pathNames = isWindows ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of pathNames) {
      const candidate = path.join(dir, name);
      if (!fs.existsSync(candidate)) continue;
      try {
        const real = fs.realpathSync(candidate);
        if (path.basename(real) === 'npm-cli.js') {
          return { path: real, source: `PATH search (${candidate})` };
        }
        checked.push(`${candidate} -> ${real} (not npm-cli.js)`);
      } catch (e) {
        checked.push(`${candidate} (broken link, skipped)`);
      }
    }
  }

  return { path: null, checked };
}

// Runs one command from memory-daemon/, prints what it is running, and
// streams its real output straight to this terminal so stderr is never
// swallowed. Returns a pass or fail result instead of throwing, so the
// caller decides whether that step should stop the whole run.
function runStep(label, cmd, args) {
  const shown = [cmd, ...args].join(' ');
  console.log(`\n==> ${label}`);
  console.log(`    running: ${shown}`);
  const result = spawnSync(cmd, args, { cwd: memoryDaemonDir, stdio: 'inherit' });
  if (result.error) {
    console.error(`FAILED: ${shown}`);
    console.error(`    ${result.error.message}`);
    return { ok: false, code: 1 };
  }
  if (result.status !== 0) {
    console.error(`FAILED: ${shown} (exit code ${result.status})`);
    return { ok: false, code: result.status ?? 1 };
  }
  console.log(`ok: ${label}`);
  return { ok: true, code: 0 };
}

// Prints the plan for --dry-run: every command that would run, in order,
// with the platform decision already made, and nothing executed.
function printPlan(nodeStatus) {
  console.log(`platform: ${process.platform}`);
  console.log(`node check: ${nodeStatus.ok ? 'pass' : 'FAIL'} (needs ${nodeStatus.required})`);
  console.log(`npm-cli.js resolved via ${npmCli.source}: ${npmCli.path}`);
  console.log(`all commands below would run from: ${memoryDaemonDir}`);
  console.log('planned commands, in order:');
  console.log(`  1. ${process.execPath} ${npmCli.path} ${npmInstallArgs.join(' ')}`);
  if (isWindows) {
    console.log('     windows: --ignore-scripts skips the native compile of better-sqlite3.');
  }
  console.log(`  2. ${process.execPath} ${npmCli.path} run build`);
  console.log(`  3. ${process.execPath} ${npmCli.path} link`);
  console.log('     if this fails, the run continues. fallback: node dist/cli/memory.js <command>.');
  console.log(`  4. ${process.execPath} ${doctorArgs.join(' ')}`);
  printNextStep();
}

// Names the one setup step this script will not run for the user, and why.
// Always printed, whether doctor passed or not: doctor is not a build gate,
// so its result does not change what the user does next.
function printNextStep() {
  console.log('\nnext step, not run by this script:');
  console.log('  memory init --hooks');
  console.log('  this picks your vault folder and edits ~/.claude/settings.json.');
  console.log('  run it yourself, so you see what it changes.');
  console.log('  then run memory doctor again to check the result.');
}
