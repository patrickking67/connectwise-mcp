#!/usr/bin/env node
// Pack the MCPB bundle from a staging directory that holds only what the
// installable needs: the manifest, the icon, the server, and the production
// dependencies.
//
// Why not `mcpb pack .` on the checkout: it takes everything under the tree
// that .mcpbignore does not exclude, and that includes devDependencies — the
// mcpb CLI itself and TypeScript among them — which turns a small server into
// an 8 MB bundle. Pruning devDependencies in place would remove the toolchain
// from the checkout, so the production install happens in a scratch copy.
//
// What is staged: manifest.json, package.json, package-lock.json, LICENSE,
// README.md, every icon the manifest names, the directory that holds the
// manifest's entry_point, and any extra paths given on the command line.
//
// Usage: node scripts/pack-mcpb.mjs [--manifest <file>] <output.mcpb> [extra paths to ship...]
//
// --manifest stages that file as the bundle's manifest.json instead of the
// root one, which is how the per-product bundles under manifests/ are built
// from the same server.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const manifestFlag = argv.indexOf('--manifest');
const manifestPath = manifestFlag === -1 ? join(ROOT, 'manifest.json') : resolve(ROOT, argv[manifestFlag + 1] ?? '');
if (manifestFlag !== -1) argv.splice(manifestFlag, 2);
const [outputArg, ...extra] = argv;
if (!outputArg) throw new Error('usage: pack-mcpb.mjs [--manifest <file>] <output.mcpb> [extra paths...]');
const output = resolve(ROOT, outputArg);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = manifest.server?.entry_point;
if (!entry || !existsSync(join(ROOT, entry))) {
  throw new Error(`manifest entry_point ${entry ?? '(unset)'} does not exist — build first`);
}
const icons = [manifest.icon, ...(manifest.icons ?? []).map((i) => i.src)].filter(Boolean);
const shipped = new Set(['package.json', 'package-lock.json', 'LICENSE', 'README.md', ...icons, entry.split('/')[0], ...extra]);

const stage = mkdtempSync(join(tmpdir(), `${manifest.name}-mcpb-`));
try {
  cpSync(manifestPath, join(stage, 'manifest.json'));
  for (const item of shipped) {
    const from = join(ROOT, item);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(stage, item)), { recursive: true });
    cpSync(from, join(stage, item), {
      recursive: true,
      filter: (source) => !/\.(mcpb|map)$/.test(source) && !source.endsWith('.DS_Store'),
    });
  }

  // Production dependencies only, from the lockfile when there is one, so the
  // bundle carries exactly what package.json says the server needs. The
  // npm_config_* variables are dropped so a nested install under `npm run`
  // does not inherit the outer npm's project-scoped settings.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_config_')),
  );
  const hasLock = existsSync(join(stage, 'package-lock.json'));
  execFileSync('npm', [hasLock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: stage,
    stdio: 'inherit',
    env: cleanEnv,
  });

  // Validate the staged manifest, not the source: icon paths are relative to
  // the manifest's own directory, which for manifests/*.json is the wrong one.
  execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@^2', 'validate', join(stage, 'manifest.json')], { cwd: ROOT, stdio: 'inherit' });
  mkdirSync(dirname(output), { recursive: true });
  execFileSync('npx', ['--yes', '@anthropic-ai/mcpb@^2', 'pack', stage, output], { cwd: ROOT, stdio: 'inherit' });
} finally {
  rmSync(stage, { recursive: true, force: true });
}
