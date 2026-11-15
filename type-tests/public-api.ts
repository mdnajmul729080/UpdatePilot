import { HOOKS, HookBus, UpdatePilot } from "update-pilot";
import { DockerAdapter } from "update-pilot/adapters/docker";
import { GitHubAdapter } from "update-pilot/adapters/github";
import { HealthAdapter } from "update-pilot/adapters/health";

const hooks: HookBus = new HookBus();
hooks.on(HOOKS.BEFORE_CHECK, (payload) => payload);

const engine = new UpdatePilot({
  repo: "owner/repository",
  currentVersion: "1.2.3",
  docker: { image: "ghcr.io/owner/repository" },
  health: { url: "http://127.0.0.1:8080/health" },
});

void engine;
void new DockerAdapter({ image: "ghcr.io/owner/repository" });
void new GitHubAdapter({ repo: "owner/repository", currentVersion: "1.2.3" });
void new HealthAdapter({ url: "http://127.0.0.1:8080/health" });
