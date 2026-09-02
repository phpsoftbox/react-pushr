import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = await mkdtemp(join(packageRoot, '.package-smoke-'));
const consumerRoot = join(temporaryRoot, 'consumer');

const run = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}.`);
  }

  return result.stdout ?? '';
};

try {
  run('yarn', ['build'], packageRoot);

  const packOutput = run(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot],
    packageRoot,
    true,
  );
  const packResult = JSON.parse(packOutput);
  const tarball = join(temporaryRoot, packResult[0].filename);

  await mkdir(consumerRoot, { recursive: true });
  await writeFile(
    join(consumerRoot, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2),
  );

  run(
    'npm',
    ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', tarball],
    consumerRoot,
  );

  const consumerReact = join(consumerRoot, 'node_modules', 'react');
  try {
    await lstat(consumerReact);
  } catch {
    await symlink(join(packageRoot, 'node_modules', 'react'), consumerReact, 'junction');
  }

  await writeFile(
    join(consumerRoot, 'native-smoke.mjs'),
    [
      "const core = await import('@phpsoftbox/pushr');",
      "const react = await import('@phpsoftbox/pushr/react');",
      "if (typeof core.PushrClient !== 'function' || typeof react.usePushrEvent !== 'function') {",
      "  throw new Error('Published entrypoints do not expose the expected API.');",
      '}',
      '',
    ].join('\n'),
  );
  await copyFile(
    join(packageRoot, 'tests', 'consumer', 'smoke.test.ts'),
    join(consumerRoot, 'smoke.test.ts'),
  );

  run(process.execPath, ['native-smoke.mjs'], consumerRoot);
  run(
    process.execPath,
    [join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'smoke.test.ts', '--root', consumerRoot],
    consumerRoot,
  );

  const installedRoot = join(consumerRoot, 'node_modules', '@phpsoftbox', 'pushr');
  for (const file of ['dist/index.js', 'dist/react.js', 'dist/index.d.ts', 'dist/react.d.ts']) {
    const contents = await readFile(join(installedRoot, file), 'utf8');
    const extensionlessImport = /from ['"]\.\.?\/[^'"]+(?<!\.js)['"]/u;
    if (extensionlessImport.test(contents)) {
      throw new Error(`Published file ${file} contains an extensionless relative import.`);
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
