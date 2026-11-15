import assert from "node:assert/strict";
import { test } from "node:test";
import { UpdatePilot } from "../src/core/engine.js";
import {
  ConfigError,
  DockerError,
  HealthCheckError,
  RollbackError,
  UpdateInProgressError,
  UpdatePilotError,
} from "../src/utils/errors.js";
import { HookBus, HOOKS } from "../src/utils/events.js";

function makeFakeGitHub({
  updateAvailable = true,
  latestVersion = "1.3.0",
  check = null,
} = {}) {
  return {
    check:
      check ??
      (async () => ({
        updateAvailable,
        currentVersion: "1.2.3",
        currentVersionRaw: "1.2.3",
        latestVersion,
        latestVersionRaw: `v${latestVersion}`,
        releaseUrl: "https://github.com/x/y/releases/tag/v1.3.0",
        releaseNotes: "notes",
        publishedAt: new Date().toISOString(),
        isPrerelease: false,
        fromCache: false,
        rateLimit: null,
      })),
  };
}

function makeFakeDocker({
  deployFails = false,
  rollbackFails = false,
  finalizeFails = false,
} = {}) {
  const calls = { deploy: 0, rollback: 0, finalize: 0 };
  return {
    calls,
    deploy: async () => {
      calls.deploy += 1;
      if (deployFails) throw new DockerError("deploy failed");
      return {
        success: true,
        newContainerId: "new-id",
        previousContainerId: "prev-id",
      };
    },
    finalize: async () => {
      calls.finalize += 1;
      if (finalizeFails) throw new DockerError("finalize failed");
      return { finalized: true };
    },
    rollback: async () => {
      calls.rollback += 1;
      if (rollbackFails) throw new DockerError("rollback failed");
      return { rolledBack: true, restoredContainerId: "prev-id" };
    },
  };
}

function makeFakeHealth({ healthy = true } = {}) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    check: async () => {
      calls += 1;
      if (!healthy) {
        const error = new HealthCheckError("health failed");
        error.context = {
          url: "http://x/health",
          attempts: 5,
          lastStatus: 500,
        };
        throw error;
      }
      return {
        healthy: true,
        url: "http://x/health",
        status: 200,
        attempts: 1,
        latencyMs: 42,
        checkedAt: new Date().toISOString(),
      };
    },
  };
}

/** @param {{ github?: any, docker?: any, health?: any, hooks?: Record<string, Function>, config?: any }} [options] */
function makePilot(options = {}) {
  const {
    github = makeFakeGitHub(),
    docker = makeFakeDocker(),
    health = makeFakeHealth(),
    hooks,
    config = {},
  } = options;
  const userConfig = {
    repo: "org/app",
    currentVersion: "1.2.3",
    docker: { image: "ghcr.io/org/app" },
    health: { url: "http://x/health" },
    hooks,
    ...config,
  };
  return {
    pilot: new UpdatePilot(userConfig, {
      githubAdapter: github,
      dockerAdapter: docker,
      healthAdapter: health,
    }),
    github,
    docker,
    health,
  };
}

function observingBus(events) {
  const bus = new HookBus();
  for (const event of Object.values(HOOKS))
    bus.on(event, () => {
      events.push(event);
    });
  return bus;
}

test("runUpdate returns updated on the happy path", async () => {
  const { pilot } = makePilot();
  assert.equal((await pilot.runUpdate()).status, "updated");
});

test("success result includes version, container, latency, and duration", async () => {
  const { pilot } = makePilot();
  const result = await pilot.runUpdate();
  if (result.status !== "updated") throw new Error("Expected updated result");
  const updated =
    /** @type {{ from: string, to: string | null, newContainerId: string | null, healthLatencyMs: number, durationMs: number }} */ (
      result
    );
  assert.deepEqual(
    [updated.from, updated.to, updated.newContainerId, updated.healthLatencyMs],
    ["1.2.3", "1.3.0", "new-id", 42],
  );
  assert.ok(updated.durationMs >= 0);
});

test("checkOnly returns update information without touching Docker", async () => {
  const { pilot, docker } = makePilot();
  assert.equal((await pilot.checkOnly()).updateAvailable, true);
  assert.deepEqual(docker.calls, { deploy: 0, rollback: 0, finalize: 0 });
});

test("runUpdate returns up-to-date when no release is newer", async () => {
  const { pilot } = makePilot({
    github: makeFakeGitHub({ updateAvailable: false }),
  });
  assert.equal((await pilot.runUpdate()).status, "up-to-date");
});

test("force proceeds when no release is newer", async () => {
  const { pilot, docker } = makePilot({
    github: makeFakeGitHub({ updateAvailable: false }),
  });
  assert.equal((await pilot.runUpdate({ force: true })).status, "updated");
  assert.equal(docker.calls.deploy, 1);
});

test("dry run does not deploy, finalize, or check health", async () => {
  const { pilot, docker, health } = makePilot();
  assert.equal((await pilot.runUpdate({ dryRun: true })).status, "dry-run");
  assert.deepEqual(docker.calls, { deploy: 0, rollback: 0, finalize: 0 });
  assert.equal(health.calls, 0);
});

test("health failure rolls back and returns structured status", async () => {
  const { pilot } = makePilot({ health: makeFakeHealth({ healthy: false }) });
  const result = await pilot.runUpdate();
  assert.equal(result.status, "rolled-back");
  assert.equal(result.reason, "health-check-failed");
  assert.equal(result.healthError.message, "health failed");
});

test("health failure calls rollback and skips finalize", async () => {
  const { pilot, docker } = makePilot({
    health: makeFakeHealth({ healthy: false }),
  });
  await pilot.runUpdate();
  assert.equal(docker.calls.rollback, 1);
  assert.equal(docker.calls.finalize, 0);
});

test("rollback failure is catastrophic", async () => {
  const { pilot } = makePilot({
    docker: makeFakeDocker({ rollbackFails: true }),
    health: makeFakeHealth({ healthy: false }),
  });
  await assert.rejects(
    pilot.runUpdate(),
    (error) =>
      error instanceof RollbackError &&
      error.message.includes("manual intervention"),
  );
});

test("Docker deploy failure is wrapped with deploy phase and skips rollback", async () => {
  const { pilot, docker } = makePilot({
    docker: makeFakeDocker({ deployFails: true }),
  });
  await assert.rejects(
    pilot.runUpdate(),
    (error) =>
      error instanceof UpdatePilotError && error.context.phase === "deploy",
  );
  assert.equal(docker.calls.rollback, 0);
});

test("GitHub check failure is wrapped with check phase", async () => {
  const { pilot } = makePilot({
    github: makeFakeGitHub({
      check: async () => {
        throw new Error("github down");
      },
    }),
  });
  await assert.rejects(
    pilot.runUpdate(),
    (error) =>
      error instanceof UpdatePilotError && error.context.phase === "check",
  );
});

test("finalize failure is wrapped with finalize phase", async () => {
  const { pilot } = makePilot({
    docker: makeFakeDocker({ finalizeFails: true }),
  });
  await assert.rejects(
    pilot.runUpdate(),
    (error) =>
      error instanceof DockerError && error.context.phase === "finalize",
  );
});

test("parallel update call is rejected as already in progress", async () => {
  let release = /** @type {any} */ (() => {});
  const waiting = new Promise((resolve) => {
    release = () => resolve();
  });
  const github = makeFakeGitHub({
    check: async () => {
      await waiting;
      return makeFakeGitHub().check();
    },
  });
  const { pilot } = makePilot({ github });
  const first = pilot.runUpdate();
  await assert.rejects(pilot.runUpdate(), UpdateInProgressError);
  release();
  await first;
});

test("a later update is allowed after the previous run completes", async () => {
  const { pilot, docker } = makePilot();
  await pilot.runUpdate();
  await pilot.runUpdate();
  assert.equal(docker.calls.deploy, 2);
});

test("running state is released after errors", async () => {
  const { pilot } = makePilot({
    github: makeFakeGitHub({
      check: async () => {
        throw new Error("failed");
      },
    }),
  });
  await assert.rejects(pilot.runUpdate());
  assert.equal(pilot.getStatus().running, false);
});

test("lifecycle hooks fire in order on the happy path", async () => {
  const order = [];
  const config = {
    repo: "org/app",
    currentVersion: "1.2.3",
    docker: { image: "ghcr.io/org/app" },
    health: { url: "http://x/health" },
  };
  await new UpdatePilot(config, {
    githubAdapter: makeFakeGitHub(),
    dockerAdapter: makeFakeDocker(),
    healthAdapter: makeFakeHealth(),
    hookBus: observingBus(order),
  }).runUpdate();
  assert.deepEqual(order, [
    HOOKS.BEFORE_CHECK,
    HOOKS.AFTER_CHECK,
    HOOKS.BEFORE_DEPLOY,
    HOOKS.AFTER_DEPLOY,
    HOOKS.BEFORE_VERIFY,
    HOOKS.AFTER_VERIFY,
  ]);
});

test("rollback hooks fire on health failure", async () => {
  const order = [];
  const config = {
    repo: "org/app",
    currentVersion: "1.2.3",
    docker: { image: "ghcr.io/org/app" },
    health: { url: "http://x/health" },
  };
  await new UpdatePilot(config, {
    githubAdapter: makeFakeGitHub(),
    dockerAdapter: makeFakeDocker(),
    healthAdapter: makeFakeHealth({ healthy: false }),
    hookBus: observingBus(order),
  }).runUpdate();
  assert.ok(order.includes(HOOKS.BEFORE_ROLLBACK));
  assert.ok(order.includes(HOOKS.AFTER_ROLLBACK));
});

test("ON_ERROR fires on deploy failure", async () => {
  const order = [];
  const config = {
    repo: "org/app",
    currentVersion: "1.2.3",
    docker: { image: "ghcr.io/org/app" },
    health: { url: "http://x/health" },
  };
  await assert.rejects(
    new UpdatePilot(config, {
      githubAdapter: makeFakeGitHub(),
      dockerAdapter: makeFakeDocker({ deployFails: true }),
      healthAdapter: makeFakeHealth(),
      hookBus: observingBus(order),
    }).runUpdate(),
  );
  assert.ok(order.includes(HOOKS.ON_ERROR));
});

test("throwing user hooks do not fail update", async () => {
  const { pilot } = makePilot({
    hooks: {
      beforeCheck: async () => {
        throw new Error("hook broken");
      },
    },
  });
  assert.equal((await pilot.runUpdate()).status, "updated");
});

test("getStatus reports the idle engine state", () => {
  const { pilot } = makePilot();
  const status = pilot.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.lastResult, null);
  assert.equal(status.repo, "org/app");
  assert.ok(Number.isFinite(Date.parse(status.uptime.engineSince)));
});

test("getStatus reports running during an in-flight check", async () => {
  let release = /** @type {any} */ (() => {});
  const waiting = new Promise((resolve) => {
    release = () => resolve();
  });
  const github = makeFakeGitHub({
    check: async () => {
      await waiting;
      return makeFakeGitHub().check();
    },
  });
  const { pilot } = makePilot({ github });
  const running = pilot.runUpdate();
  assert.equal(pilot.getStatus().running, true);
  release();
  await running;
});

test("manual rollback requires a prior successful update", async () => {
  const { pilot } = makePilot();
  await assert.rejects(
    pilot.rollback(),
    (error) =>
      error instanceof RollbackError &&
      error.message === "No successful update to roll back",
  );
});

test("manual rollback succeeds after an update", async () => {
  const { pilot, docker } = makePilot();
  await pilot.runUpdate();
  assert.deepEqual(await pilot.rollback(), {
    status: "rolled-back-manual",
    to: "1.2.3",
  });
  assert.equal(docker.calls.rollback, 1);
});

test("constructor rejects invalid user configuration", () => {
  assert.throws(() => new UpdatePilot({ repo: "bad" }), ConfigError);
});
