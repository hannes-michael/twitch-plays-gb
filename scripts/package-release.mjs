#!/usr/bin/env node
/**
 * Bundle versioned release artifacts without running the E2E suite.
 *
 * Builds the web/server/desktop bundles and runs electron-builder for the
 * requested platform(s), writing everything to release/<version>/ so builds of
 * different versions never mix. This command never invokes Playwright; use
 * `npm run test:e2e` when you want the E2E suite.
 *
 * Usage:
 *   node scripts/package-release.mjs                 # host platform
 *   node scripts/package-release.mjs --linux         # AppImage + .deb
 *   node scripts/package-release.mjs --win           # NSIS + portable .exe
 *   node scripts/package-release.mjs --all           # Linux + Windows
 *   node scripts/package-release.mjs --skip-build    # reuse dist/
 *   node scripts/package-release.mjs --clean         # empty release/<version>/
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const releaseRoot = join(repoRoot, 'release');
const outputDir = join(releaseRoot, version);

const platforms = [];
let skipBuild = false;
let clean = false;

for (const arg of process.argv.slice(2)) {
  switch (arg) {
    case '--linux':
      platforms.push('--linux');
      break;
    case '--win':
      platforms.push('--win');
      break;
    case '--all':
      platforms.push('--linux', '--win');
      break;
    case '--skip-build':
      skipBuild = true;
      break;
    case '--clean':
      clean = true;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
      break;
    default:
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(2);
  }
}

if (platforms.length === 0) {
  platforms.push(process.platform === 'win32' ? '--win' : '--linux');
}

function printHelp() {
  console.log(`Usage: node scripts/package-release.mjs [platforms] [options]

Platforms:
  --linux       Build Linux AppImage + .deb (default on Linux)
  --win         Build Windows NSIS installer + portable .exe (default on Windows)
  --all         Build both Linux and Windows targets

Options:
  --skip-build  Reuse the existing dist/ bundles instead of rebuilding
  --clean       Remove release/${version}/ before packaging
  -h, --help    Show this help

Artifacts are written to release/${version}/.
This command never runs the E2E suite; use npm run test:e2e for that.
`);
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    console.error(`Failed to ${label}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(result.status ?? 1);
  }
}

if (clean && existsSync(outputDir)) {
  console.log(`Removing ${relative(repoRoot, outputDir)}/`);
  rmSync(outputDir, { recursive: true, force: true });
}

if (!skipBuild) {
  console.log('Building web, server, and desktop bundles (no E2E tests).');
  run('build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
    shell: process.platform === 'win32',
  });
}

const builderCli = join(repoRoot, 'node_modules', 'electron-builder', 'cli.js');
if (!existsSync(builderCli)) {
  console.error('electron-builder is not installed. Run npm install first.');
  process.exit(1);
}

const outputArg = `--config.directories.output=${outputDir}`;

for (const platform of platforms) {
  const platformName = platform === '--win' ? 'Windows' : 'Linux';
  console.log(`Packaging ${platformName} artifacts into ${relative(repoRoot, outputDir)}/`);
  run('electron-builder', process.execPath, [
    builderCli,
    platform,
    '--publish',
    'never',
    outputArg,
  ]);
}

function consolidateArtifacts() {
  const versionTag = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionPattern = new RegExp(`(^|[^0-9.])${versionTag}([^0-9.]|$)`);
  const metadataFiles = new Set(['latest.yml', 'latest-linux.yml', 'builder-debug.yml']);

  let entries;
  try {
    entries = readdirSync(releaseRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!versionPattern.test(name) && !metadataFiles.has(name)) continue;

    const source = join(releaseRoot, name);
    const destination = join(outputDir, name);
    if (existsSync(destination)) continue;

    renameSync(source, destination);
    console.log(`Moved ${name} into ${relative(repoRoot, outputDir)}/`);
  }
}

consolidateArtifacts();

const platformArgs = platforms
  .map((platform) => (platform === '--win' ? '--win' : '--linux'))
  .join(' ');

console.log(`\nRelease artifacts written to ${relative(repoRoot, outputDir)}/.`);
console.log('Smoke test them with:');
console.log(
  `  npm run smoke:packaged -- ${platformArgs} --release-dir ${relative(repoRoot, outputDir)}`,
);
