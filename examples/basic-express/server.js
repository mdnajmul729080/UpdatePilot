// SECURITY: This demo has NO authentication.
// In production, add authentication middleware (e.g., express-basic-auth,
// session-based auth, or an SSO provider) BEFORE deploying this to a
// public server. See the "Production Security" section of the README.
import express from "express";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  RollbackError,
  UpdateInProgressError,
  UpdatePilot,
  defineConfig,
  isUpdatePilotError,
} from "../../src/index.js";

const userConfig = {
  repo: "nodejs/node",
  currentVersion: process.env.APP_VERSION ?? "1.0.0",
  github: { token: process.env.GITHUB_TOKEN },
  docker: {
    image: process.env.DOCKER_IMAGE ?? "node:20-alpine",
    tag: "latest",
    containerName: "update-pilot-demo",
    composeFile: process.env.COMPOSE_FILE,
  },
  health: {
    url: process.env.HEALTH_URL ?? "http://127.0.0.1:3000/health",
    retries: 3,
    timeout: 2_000,
    interval: 500,
  },
  rollback: { enabled: true, keepImages: 3 },
  logger: { level: "info" },
};
const config = defineConfig(userConfig);

const demoMode = process.env.UPDATE_PILOT_DEMO !== "0";
const demoAdapters = demoMode
  ? {
      githubAdapter: {
        check: async () => ({
          updateAvailable: true,
          currentVersion: config.currentVersion,
          currentVersionRaw: config.currentVersionRaw,
          latestVersion: "1.0.1",
          latestVersionRaw: "v1.0.1",
          releaseUrl: "https://github.com/nodejs/node/releases",
          releaseNotes: "Demo release notes. No real deployment is performed.",
          publishedAt: new Date().toISOString(),
          isPrerelease: false,
          fromCache: false,
          rateLimit: null,
        }),
      },
      dockerAdapter: {
        deploy: async (tag) => ({
          success: true,
          newContainerId: `demo-${tag}`,
          previousContainerId: "demo-previous",
        }),
        finalize: async () => ({ finalized: true }),
        rollback: async () => ({
          rolledBack: true,
          restoredContainerId: "demo-previous",
        }),
      },
      healthAdapter: {
        check: async () => ({
          healthy: true,
          url: config.health.url,
          status: 200,
          attempts: 1,
          latencyMs: 8,
          checkedAt: new Date().toISOString(),
        }),
      },
    }
  : {};

const engine = new UpdatePilot(userConfig, demoAdapters);
const app = express();
app.disable("x-powered-by");
app.get("/health", (_request, response) => response.sendStatus(200));

function sendError(response, error) {
  const status =
    error instanceof UpdateInProgressError
      ? 409
      : error instanceof ConfigError
        ? 400
        : error instanceof RollbackError &&
            error.message === "No successful update to roll back"
          ? 400
          : 500;
  response.status(status).json({
    error: error instanceof Error ? error.message : String(error),
    ...(isUpdatePilotError(error)
      ? { code: error.code, context: error.context }
      : {}),
  });
}

app.get("/", async (_request, response, next) => {
  try {
    response.sendFile(
      fileURLToPath(new URL("./public/index.html", import.meta.url)),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/api/status", (_request, response) => {
  try {
    response.json(engine.getStatus());
  } catch (error) {
    sendError(response, error);
  }
});
app.get("/api/check", async (_request, response) => {
  try {
    response.json(await engine.checkOnly());
  } catch (error) {
    sendError(response, error);
  }
});
app.post("/api/update", async (_request, response) => {
  try {
    response.json(await engine.runUpdate());
  } catch (error) {
    sendError(response, error);
  }
});
app.post("/api/rollback", async (_request, response) => {
  try {
    response.json(await engine.rollback());
  } catch (error) {
    sendError(response, error);
  }
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  if (demoMode) {
    console.log(
      "[update-pilot-example] Running in DEMO MODE (fake adapters). Set UPDATE_PILOT_DEMO=0 to use real Docker/GitHub/HTTP.",
    );
  } else {
    console.log(
      "[update-pilot-example] Running against REAL infrastructure. Update endpoint will pull Docker images and restart containers.",
    );
  }
  console.log(
    `[update-pilot-example] Listening on http://127.0.0.1:${actualPort}`,
  );
});

export { app, engine };
