import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { defineTrafficRouterContractTests } from "../../testing/traffic-router-contract.js";

/** @param {{ candidateHealthUrl?: string }} [options] */
function createScenarioFactory({ candidateHealthUrl } = {}) {
  return async () => {
    const state = { route: "old", prepared: false };
    const deployment = {
      from: "1.2.3",
      to: "1.3.0",
      healthUrl: "http://app.test/health",
      previousContainerId: "previous",
      newContainerId: "candidate",
      candidatePorts: {
        "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
      },
    };
    const trafficRouter = {
      prepare: async () => {
        state.prepared = true;
        return {
          healthUrl: candidateHealthUrl ?? "http://127.0.0.1:49152/ready",
          context: { routeId: "candidate-route" },
        };
      },
      switch: async () => {
        assert.equal(state.prepared, true);
        state.route = "candidate";
      },
      rollback: async () => {
        state.route = "old";
        state.prepared = false;
      },
    };

    return {
      trafficRouter,
      deployment,
      verifyCandidateHealth: async (preparation) => {
        assert.equal(
          preparation.healthUrl,
          candidateHealthUrl ?? "http://127.0.0.1:49152/ready",
        );
        assert.equal(state.route, "old");
      },
      assertOldRouteActive: async () => assert.equal(state.route, "old"),
      assertCandidateRouteActive: async () =>
        assert.equal(state.route, "candidate"),
      assertPreparationCleaned: async () => assert.equal(state.prepared, false),
      cleanup: async () => {
        state.route = "old";
        state.prepared = false;
      },
    };
  };
}

describe("defineTrafficRouterContractTests", () => {
  defineTrafficRouterContractTests({
    providerName: "instrumented fake provider",
    createScenario: createScenarioFactory(),
  });

  it("fails when prepare switches away from the old route", () => {
    const moduleUrl = new URL(
      "../../testing/traffic-router-contract.js",
      import.meta.url,
    ).href;
    const source = `
      import assert from "node:assert/strict";
      import { defineTrafficRouterContractTests } from ${JSON.stringify(moduleUrl)};
      defineTrafficRouterContractTests({
        providerName: "broken provider",
        createScenario: async () => {
          const state = { route: "candidate" };
          const deployment = { healthUrl: "http://app.test/health" };
          return {
            deployment,
            trafficRouter: {
              prepare: async () => ({ healthUrl: "http://candidate.test/ready" }),
              switch: async () => {},
              rollback: async () => {},
            },
            verifyCandidateHealth: async () => {},
            assertOldRouteActive: async () => assert.equal(state.route, "old", "prepare must preserve the old route"),
            assertCandidateRouteActive: async () => {},
            assertPreparationCleaned: async () => {},
            cleanup: async () => {},
          };
        },
      });
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 10_000 },
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ERR_ASSERTION/);
  });
});
