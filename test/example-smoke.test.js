import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverFile = resolve(root, "examples/basic-express/server.js");
const children = [];

after(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolveExit();
          child.once("exit", resolveExit);
          child.kill("SIGTERM");
          const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_500);
          forceKill.unref();
        }),
    ),
  );
});

test(
  "demo Express API returns valid JSON for status, check, rollback, and update",
  {
    timeout: 15_000,
    skip: process.env.CI_SKIP_EXAMPLE === "1",
  },
  async () => {
    const child = spawn(process.execPath, [serverFile], {
      cwd: dirname(serverFile),
      env: { ...process.env, PORT: "0", UPDATE_PILOT_DEMO: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const port = await new Promise((resolvePort, reject) => {
      let stdout = "";
      const timeout = setTimeout(
        () =>
          reject(new Error(`Example server did not start. stderr: ${stderr}`)),
        10_000,
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const match = stdout.match(/Listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolvePort(Number(match[1]));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Example server exited (${code}). stdout: ${stdout}; stderr: ${stderr}`,
          ),
        );
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    const statusResponse = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.running, false);
    assert.equal(status.repo, "nodejs/node");

    const checkResponse = await fetch(`${baseUrl}/api/check`);
    assert.equal(checkResponse.status, 200);
    const check = await checkResponse.json();
    assert.equal(typeof check.updateAvailable, "boolean");
    assert.equal(check.latestVersion, "1.0.1");

    const rollbackResponse = await fetch(`${baseUrl}/api/rollback`, {
      method: "POST",
    });
    assert.ok([400, 409].includes(rollbackResponse.status));
    assert.equal(typeof (await rollbackResponse.json()).error, "string");

    const updateResponse = await fetch(`${baseUrl}/api/update`, {
      method: "POST",
    });
    assert.equal(updateResponse.status, 200);
    const update = await updateResponse.json();
    assert.equal(update.status, "updated");
    assert.equal(update.from, "1.0.0");
    assert.equal(update.to, "1.0.1");
  },
);
