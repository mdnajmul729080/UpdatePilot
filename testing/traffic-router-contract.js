import assert from "node:assert/strict";
import { describe, it } from "node:test";

const scenarioAssertions = [
  "verifyCandidateHealth",
  "assertOldRouteActive",
  "assertCandidateRouteActive",
  "assertPreparationCleaned",
  "cleanup",
];

function assertScenario(scenario) {
  if (!scenario || typeof scenario !== "object")
    throw new TypeError("createScenario() must return a scenario object");
  if (!scenario.trafficRouter || !scenario.deployment)
    throw new TypeError("Scenario must provide trafficRouter and deployment");
  for (const method of ["prepare", "switch", "rollback"])
    if (typeof scenario.trafficRouter[method] !== "function")
      throw new TypeError(`trafficRouter must implement ${method}()`);
  for (const assertion of scenarioAssertions)
    if (typeof scenario[assertion] !== "function")
      throw new TypeError(`Scenario must implement ${assertion}()`);
}

async function withScenario(createScenario, verify) {
  const scenario = await createScenario();
  assertScenario(scenario);
  try {
    await verify(scenario);
  } finally {
    await scenario.cleanup();
  }
}

async function prepareCandidate(scenario) {
  const { deployment, trafficRouter } = scenario;
  const preparation = await trafficRouter.prepare(deployment);
  assert.ok(
    preparation && typeof preparation.healthUrl === "string",
    "prepare() must return a candidate healthUrl",
  );

  const candidateUrl = new URL(preparation.healthUrl);
  const configuredUrl = new URL(deployment.healthUrl);
  assert.ok(
    candidateUrl.protocol === "http:" || candidateUrl.protocol === "https:",
    "candidate healthUrl must use HTTP or HTTPS",
  );
  assert.notEqual(
    candidateUrl.href,
    configuredUrl.href,
    "candidate healthUrl must not probe the live deployment endpoint",
  );
  return preparation;
}

/**
 * Register provider-specific Node.js tests against the shared TrafficRouter contract.
 * Each scenario must target isolated infrastructure and assert actual route state.
 * @param {{ providerName: string, createScenario: () => object | Promise<object> }} options
 */
export function defineTrafficRouterContractTests({
  providerName,
  createScenario,
}) {
  if (typeof providerName !== "string" || providerName.trim().length === 0)
    throw new TypeError("providerName must be a non-empty string");
  if (typeof createScenario !== "function")
    throw new TypeError("createScenario must be a function");

  describe(`${providerName} TrafficRouter contract`, () => {
    it("probes a candidate-only health URL while keeping the old route active", async () => {
      await withScenario(createScenario, async (scenario) => {
        const preparation = await prepareCandidate(scenario);
        await scenario.verifyCandidateHealth(preparation, scenario.deployment);
        await scenario.assertOldRouteActive();
      });
    });

    it("switches only after candidate health and restores the old route on rollback", async () => {
      await withScenario(createScenario, async (scenario) => {
        const preparation = await prepareCandidate(scenario);
        await scenario.verifyCandidateHealth(preparation, scenario.deployment);
        await scenario.assertOldRouteActive();
        await scenario.trafficRouter.switch(
          scenario.deployment,
          preparation.context,
        );
        await scenario.assertCandidateRouteActive();
        await scenario.trafficRouter.rollback(
          scenario.deployment,
          preparation.context,
          "contract-test",
        );
        await scenario.assertOldRouteActive();
      });
    });

    it("cleans prepared state and preserves the old route without switching", async () => {
      await withScenario(createScenario, async (scenario) => {
        const preparation = await prepareCandidate(scenario);
        await scenario.trafficRouter.rollback(
          scenario.deployment,
          preparation.context,
          "health-check-failed",
        );
        await scenario.assertOldRouteActive();
        await scenario.assertPreparationCleaned();
      });
    });
  });
}
