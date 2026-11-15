import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DockerAdapter } from "../src/adapters/docker.js";
import { DockerError } from "../src/utils/errors.js";

function makeFakeDocker(overrides = {}) {
  const calls = { pull: [], created: [], removed: [], stopped: 0, started: 0 };
  const docker = {
    calls,
    pull: async (image) => {
      calls.pull.push(image);
      return new EventEmitter();
    },
    modem: {
      followProgress: (stream, callback, onProgress) =>
        setTimeout(() => {
          onProgress?.({ status: "done" });
          callback(null, []);
        }, 10),
    },
    listContainers: async () => [],
    createContainer: async (options) => {
      calls.created.push(options);
      return {
        id: "new-id",
        start: async () => {
          calls.started += 1;
        },
        stop: async () => {
          calls.stopped += 1;
        },
        remove: async () => {
          calls.removed.push(options.name);
        },
      };
    },
    getContainer: (id) => ({
      id,
      stop: async () => {
        calls.stopped += 1;
      },
      start: async () => {
        calls.started += 1;
      },
      remove: async () => {
        calls.removed.push(id);
      },
    }),
    listImages: async () => [],
    getImage: () => ({ remove: async () => {} }),
    ...overrides,
  };
  return docker;
}

function makeAdapter(dockerClient, options = {}) {
  return new DockerAdapter({
    image: "ghcr.io/org/app",
    containerName: "app",
    dockerClient,
    ...options,
  });
}

test("constructor requires a non-empty image", () => {
  assert.throws(() => new DockerAdapter({}), DockerError);
  assert.throws(() => new DockerAdapter({ image: "" }), DockerError);
});

test("pull requests the configured image and tag", async () => {
  const docker = makeFakeDocker();
  const adapter = makeAdapter(docker, { tag: "1.2.3" });
  assert.deepEqual(await adapter.pull(), {
    pulled: true,
    image: "ghcr.io/org/app:1.2.3",
  });
  assert.deepEqual(docker.calls.pull, ["ghcr.io/org/app:1.2.3"]);
});

test("pull waits for followProgress completion", async () => {
  let completed = false;
  const docker = makeFakeDocker({
    modem: {
      followProgress: (stream, callback) =>
        setTimeout(() => {
          completed = true;
          callback(null, []);
        }, 10),
    },
  });
  const adapter = makeAdapter(docker);
  await adapter.pull();
  assert.equal(completed, true);
});

test("pull retries transient stream failures", async () => {
  let calls = 0;
  const docker = makeFakeDocker({
    pull: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return new EventEmitter();
    },
  });
  await makeAdapter(docker).pull();
  assert.equal(calls, 2);
});

test("getCurrentContainer returns null when no containers match", async () => {
  assert.equal(await makeAdapter(makeFakeDocker()).getCurrentContainer(), null);
});

test("getCurrentContainer returns the matching container info", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old-image",
        State: "running",
        Status: "Up",
      },
    ],
  });
  assert.deepEqual(await makeAdapter(docker).getCurrentContainer(), {
    id: "old-id",
    name: "app",
    image: "old-image",
    state: "running",
    status: "Up",
  });
});

test("deploy retains the previous container without stopping it", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old",
        State: "running",
        Status: "Up",
        Ports: [],
      },
    ],
  });
  await makeAdapter(docker).deploy("2.0.0");
  assert.equal(docker.calls.stopped, 0);
});

test("deploy creates and starts a temporary blue-green container", async () => {
  const docker = makeFakeDocker();
  const before = Date.now();
  await makeAdapter(docker).deploy("2.0.0");
  const name = docker.calls.created[0].name;
  assert.match(name, /^app-new-\d+$/);
  assert.ok(Number(name.slice("app-new-".length)) >= before);
  assert.equal(docker.calls.started, 1);
});

test("deploy carries forward published port mappings", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old",
        State: "running",
        Status: "Up",
        Ports: [
          { PrivatePort: 3000, PublicPort: 8080, Type: "tcp", IP: "127.0.0.1" },
        ],
      },
    ],
  });
  await makeAdapter(docker).deploy("2.0.0");
  assert.deepEqual(docker.calls.created[0].HostConfig.PortBindings, {
    "3000/tcp": [{ HostPort: "8080", HostIp: "127.0.0.1" }],
  });
});

test("deploy removes the new container when starting it fails", async () => {
  const docker = makeFakeDocker({
    createContainer: async (options) => ({
      id: "bad-id",
      start: async () => {
        throw new Error("start failed");
      },
      remove: async () => {
        docker.calls.removed.push(options.name);
      },
    }),
  });
  await assert.rejects(makeAdapter(docker).deploy("2.0.0"), DockerError);
  assert.equal(docker.calls.removed.length, 1);
});

test("finalize stops and removes the previous container", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old",
        State: "running",
        Status: "Up",
        Ports: [],
      },
    ],
  });
  const adapter = makeAdapter(docker);
  await adapter.deploy("2.0.0");
  await adapter.finalize();
  assert.equal(docker.calls.stopped, 1);
  assert.ok(docker.calls.removed.includes("old-id"));
});

test("finalize is safe when called twice", async () => {
  const adapter = makeAdapter(makeFakeDocker());
  await adapter.deploy("2.0.0");
  assert.deepEqual(await adapter.finalize(), { finalized: true });
  assert.deepEqual(await adapter.finalize(), { finalized: true });
});

test("rollback removes the new container and restarts a stopped previous container", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old",
        State: "exited",
        Status: "Exited",
        Ports: [],
      },
    ],
  });
  const adapter = makeAdapter(docker);
  await adapter.deploy("2.0.0");
  const result = await adapter.rollback();
  assert.deepEqual(result, { rolledBack: true, restoredContainerId: "old-id" });
  assert.equal(docker.calls.started, 2);
  assert.ok(
    docker.calls.removed.includes(
      "app-new-" + docker.calls.created[0].name.split("app-new-")[1],
    ),
  );
});

test("rollback does not restart a still-running previous container", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old",
        State: "running",
        Status: "Up",
        Ports: [],
      },
    ],
  });
  const adapter = makeAdapter(docker);
  await adapter.deploy("2.0.0");
  await adapter.rollback();
  assert.equal(docker.calls.started, 1);
});

test("rollback wraps previous-container restart failure as DockerError", async () => {
  const docker = makeFakeDocker({
    listContainers: async () => [
      {
        Id: "old-id",
        Names: ["/app"],
        Image: "old",
        State: "exited",
        Status: "Exited",
        Ports: [],
      },
    ],
    getContainer: () => ({
      start: async () => {
        throw new Error("restart failed");
      },
      stop: async () => {},
      remove: async () => {},
    }),
  });
  const adapter = makeAdapter(docker);
  await adapter.deploy("2.0.0");
  await assert.rejects(
    adapter.rollback(new Error("health failed")),
    (error) => {
      if (!(error instanceof DockerError)) return false;
      const originalError = error.context.originalError;
      return (
        error.message ===
          "CRITICAL: rollback failed — manual intervention required" &&
        originalError instanceof Error &&
        originalError.message === "health failed"
      );
    },
  );
});

test("compose deploy uses pull and up while retaining previous container", async () => {
  const calls = [];
  const compose = {
    pull: async () => {
      calls.push("pull");
    },
    up: async () => {
      calls.push("up");
      return { id: "compose-new" };
    },
  };
  const adapter = makeAdapter(makeFakeDocker(), {
    composeFile: "compose.yml",
    dockerComposeClient: compose,
  });
  const result = await adapter.deploy("2.0.0");
  assert.deepEqual(calls, ["pull", "up"]);
  assert.equal(result.newContainerId, "compose-new");
});
