import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error("Run this check through `npm run test:package`");

function runNode(args, cwd, label) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${label} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { cause: result.error },
    );
  return result;
}

function runNpm(args, cwd, label) {
  return runNode([npmCli, ...args], cwd, label);
}

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "update-pilot-package-smoke-"),
);

try {
  const packResult = runNpm(
    ["pack", "--json", "--pack-destination", temporaryDirectory],
    root,
    "npm pack",
  );
  const [packageInfo] = JSON.parse(packResult.stdout);
  const packageFiles = packageInfo.files.map(({ path }) => path);
  const requiredFiles = [
    "src/index.js",
    "src/types/index.d.ts",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
  ];
  for (const file of requiredFiles)
    assert.ok(packageFiles.includes(file), `Package is missing ${file}`);
  assert.ok(
    packageFiles.every(
      (file) =>
        !/^(?:test|tests|type-tests|scripts|notes|\.github)\//.test(file),
    ),
    "Package contains test, verification, private-note, or CI files",
  );

  const consumerDirectory = join(temporaryDirectory, "consumer");
  await mkdir(consumerDirectory);
  runNpm(
    [
      "install",
      "--prefix",
      consumerDirectory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temporaryDirectory, packageInfo.filename),
    ],
    root,
    "fresh tarball install",
  );

  runNode(
    [
      "-e",
      [
        'const assert = require("node:assert/strict");',
        'const api = require("update-pilot");',
        'const health = require("update-pilot/adapters/health");',
        'assert.equal(typeof api.UpdatePilot, "function");',
        'assert.equal(typeof health.HealthAdapter, "function");',
        "assert.ok(new api.HookBus() instanceof api.HookBus);",
        'assert.equal("default" in api, false);',
      ].join("\n"),
    ],
    consumerDirectory,
    "fresh CommonJS require smoke",
  );
  runNode(
    [
      "--input-type=module",
      "-e",
      [
        'import assert from "node:assert/strict";',
        'import * as api from "update-pilot";',
        'import { HealthAdapter } from "update-pilot/adapters/health";',
        'assert.equal(typeof api.UpdatePilot, "function");',
        'assert.equal(typeof HealthAdapter, "function");',
        "assert.ok(new api.HookBus() instanceof api.HookBus);",
        'assert.equal("default" in api, false);',
      ].join("\n"),
    ],
    consumerDirectory,
    "fresh ESM import smoke",
  );

  console.log(
    `Fresh ESM/CommonJS install passed: ${packageFiles.length} files, ${Math.round(packageInfo.size / 1024)} KB compressed`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
