import { DockerAdapter } from "../adapters/docker.js";
import { GitHubAdapter } from "../adapters/github.js";
import { HealthAdapter } from "../adapters/health.js";
import {
  ConfigError,
  DockerError,
  HealthCheckError,
  RollbackError,
  UpdateInProgressError,
  UpdatePilotError,
} from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import { defineConfig } from "./config.js";
import { HookBus, HOOKS } from "./events.js";

/** @typedef {{ status: "up-to-date", currentVersion: string, latestVersion: string | null, checkedAt: string }} UpToDateResult */
/** @typedef {{ status: "updated", from: string, to: string | null, newContainerId: string | null, healthLatencyMs: number, durationMs: number, checkedAt: string }} UpdatedResult */
/** @typedef {{ status: "rolled-back", reason: "health-check-failed", from: string, to: string | null, healthError: { message: string, context: Record<string, unknown> }, durationMs: number }} RolledBackResult */
/** @typedef {{ status: "dry-run", wouldDeploy: { from: string, to: string | null }, checkedAt: string }} DryRunResult */
/** @typedef {UpToDateResult | UpdatedResult | RolledBackResult | DryRunResult} UpdateResult */
/** @typedef {{ githubAdapter?: Object, dockerAdapter?: Object, healthAdapter?: Object, logger?: Object, hookBus?: HookBus }} UpdatePilotDependencies */
/** @typedef {{ running: boolean, lastResult: UpdateResult | null, currentVersion: string, repo: string, uptime: { startedAt: string, engineSince: string } }} EngineStatus */

/**
 * Coordinate release checks, Docker deployment, health verification, and rollback.
 * @example
 * const pilot = new UpdatePilot({ repo: "acme/app", currentVersion: "1.2.3", docker: { image: "ghcr.io/acme/app" }, health: { url: "http://localhost:3000/health" } });
 * await pilot.runUpdate();
 */
export class UpdatePilot {
  /**
   * Validate configuration and prepare an update engine with injectable adapters.
   * @param {Record<string, any>} userConfig User configuration passed to defineConfig.
   * @param {UpdatePilotDependencies} [deps] Optional adapters, logger, and hook bus.
   * @example
   * new UpdatePilot(config, { githubAdapter, dockerAdapter, healthAdapter });
   */
  constructor(userConfig, deps = {}) {
    this._config = defineConfig(userConfig);
    this._logger = deps.logger || createLogger(this._config.logger);
    this._hooks = deps.hookBus || new HookBus();
    this._github = deps.githubAdapter;
    this._docker = deps.dockerAdapter;
    this._health = deps.healthAdapter;
    this._engineSince = new Date().toISOString();
    this._runStartedAt = null;
    this._running = false;
    this._lastResult = null;
    for (const [name, handler] of Object.entries(this._config.hooks)) {
      this._hooks.on(
        HOOKS[name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()],
        handler,
      );
    }
  }

  /**
   * @returns {Record<string, any>} Frozen resolved configuration.
   * @example
   * const repository = pilot.config.repo;
   */
  get config() {
    return this._config;
  }
  /**
   * @returns {Object} Logger used by this engine.
   * @example
   * pilot.logger.info("Engine ready");
   */
  get logger() {
    return this._logger;
  }
  /**
   * @returns {HookBus} Lifecycle hook bus.
   * @example
   * pilot.hooks.listenerCount(HOOKS.BEFORE_CHECK);
   */
  get hooks() {
    return this._hooks;
  }

  /**
   * Check for a release without deploying it.
   * @returns {Promise<import("../adapters/github.js").GitHubCheckResult>} Latest release comparison.
   * @example
   * const check = await pilot.checkOnly();
   */
  async checkOnly() {
    if (this._running)
      throw new UpdateInProgressError("An update is already in progress");
    const startedAt = Date.now();
    try {
      this._ensureAdapters({ docker: false, health: false });
      await this._emitSafe(HOOKS.BEFORE_CHECK, {
        currentVersion: this._config.currentVersion,
      });
      const result = await this._github.check();
      await this._emitSafe(HOOKS.AFTER_CHECK, { result });
      return result;
    } catch (error) {
      const wrapped = this._wrapError(error, "check", startedAt);
      await this._emitSafe(HOOKS.ON_ERROR, wrapped);
      throw wrapped;
    }
  }

  /**
   * Run the complete check, deploy, verify, finalize, or rollback lifecycle.
   * @param {{ dryRun?: boolean, force?: boolean }} [options] Avoid deployment or redeploy regardless of version comparison.
   * @returns {Promise<UpdateResult>} Structured update outcome.
   * @example
   * const result = await pilot.runUpdate({ dryRun: false, force: false });
   */
  async runUpdate({ dryRun = false, force = false } = {}) {
    if (this._running)
      throw new UpdateInProgressError("An update is already in progress");
    this._running = true;
    this._runStartedAt = Date.now();
    const startedAt = this._runStartedAt;
    let phase = "check";
    try {
      this._ensureAdapters({ docker: false, health: false });
      await this._emitSafe(HOOKS.BEFORE_CHECK, {
        currentVersion: this._config.currentVersion,
      });
      const checkResult = await this._github.check();
      await this._emitSafe(HOOKS.AFTER_CHECK, { result: checkResult });
      const { currentVersion } = this._config;
      const latestVersion = checkResult.latestVersion;
      const checkedAt = new Date().toISOString();
      if (!checkResult.updateAvailable && !force) {
        /** @type {UpToDateResult} */
        const result = {
          status: "up-to-date",
          currentVersion,
          latestVersion,
          checkedAt,
        };
        this._lastResult = result;
        return result;
      }
      await this._emitSafe(HOOKS.BEFORE_DEPLOY, {
        from: currentVersion,
        to: latestVersion,
      });
      if (dryRun) {
        /** @type {DryRunResult} */
        const result = {
          status: "dry-run",
          wouldDeploy: { from: currentVersion, to: latestVersion },
          checkedAt,
        };
        this._lastResult = result;
        return result;
      }

      phase = "deploy";
      this._ensureAdapters({ github: false, health: false });
      const deployResult = await this._docker.deploy(latestVersion);
      await this._emitSafe(HOOKS.AFTER_DEPLOY, {
        from: currentVersion,
        to: latestVersion,
        deployResult,
        durationMs: Date.now() - startedAt,
      });

      phase = "verify";
      this._ensureAdapters({ github: false, docker: false });
      await this._emitSafe(HOOKS.BEFORE_VERIFY, {
        url: this._config.health.url,
      });
      let healthResult;
      try {
        healthResult = await this._health.check();
      } catch (healthError) {
        if (!(healthError instanceof HealthCheckError)) throw healthError;
        await this._emitSafe(HOOKS.BEFORE_ROLLBACK, {
          reason: "health-failed",
          healthError,
        });
        try {
          await this._docker.rollback();
          await this._emitSafe(HOOKS.AFTER_ROLLBACK, { success: true });
        } catch (rollbackError) {
          const catastrophic = new RollbackError(
            "CRITICAL: health check failed AND rollback failed — manual intervention required",
            {
              cause: rollbackError,
              context: { healthError, rollbackError },
            },
          );
          await this._emitSafe(HOOKS.ON_ERROR, catastrophic);
          throw catastrophic;
        }
        /** @type {RolledBackResult} */
        const result = {
          status: "rolled-back",
          reason: "health-check-failed",
          from: currentVersion,
          to: latestVersion,
          healthError: {
            message: healthError.message,
            context: healthError.context ?? {},
          },
          durationMs: Date.now() - startedAt,
        };
        this._lastResult = result;
        return result;
      }
      await this._emitSafe(HOOKS.AFTER_VERIFY, { healthResult });

      phase = "finalize";
      await this._docker.finalize();
      /** @type {UpdatedResult} */
      const result = {
        status: "updated",
        from: currentVersion,
        to: latestVersion,
        newContainerId: deployResult.newContainerId ?? null,
        healthLatencyMs: healthResult.latencyMs,
        durationMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      };
      this._lastResult = result;
      return result;
    } catch (error) {
      if (
        error instanceof RollbackError &&
        error.message.startsWith("CRITICAL:")
      )
        throw error;
      const wrapped = this._wrapError(error, phase, startedAt);
      await this._emitSafe(HOOKS.ON_ERROR, wrapped);
      throw wrapped;
    } finally {
      this._running = false;
      this._runStartedAt = null;
    }
  }

  /**
   * Return current engine activity and the most recent result.
   * @returns {EngineStatus} Read-only engine status.
   * @example
   * const status = pilot.getStatus();
   */
  getStatus() {
    return {
      running: this._running,
      lastResult: this._lastResult,
      currentVersion: this._config.currentVersion,
      repo: this._config.repo,
      uptime: {
        startedAt: this._runStartedAt
          ? new Date(this._runStartedAt).toISOString()
          : this._engineSince,
        engineSince: this._engineSince,
      },
    };
  }

  /**
   * Manually roll back the most recent successful update.
   * @returns {Promise<{ status: "rolled-back-manual", to: string }>} Manual rollback result.
   * @example
   * const result = await pilot.rollback();
   */
  async rollback() {
    if (this._running)
      throw new UpdateInProgressError("An update is already in progress");
    if (this._lastResult?.status !== "updated")
      throw new RollbackError("No successful update to roll back");
    const previousResult = this._lastResult;
    this._running = true;
    this._runStartedAt = Date.now();
    try {
      this._ensureAdapters({ github: false, health: false });
      await this._emitSafe(HOOKS.BEFORE_ROLLBACK, {
        reason: "manual",
        to: previousResult.from,
      });
      await this._docker.rollback();
      await this._emitSafe(HOOKS.AFTER_ROLLBACK, {
        success: true,
        manual: true,
      });
      const result = { status: "rolled-back-manual", to: previousResult.from };
      this._lastResult = result;
      return result;
    } catch (error) {
      const wrapped =
        error instanceof RollbackError
          ? error
          : new RollbackError(
              "CRITICAL: manual rollback failed — manual intervention required",
              {
                cause: error,
                context: { operation: "manual-rollback", error },
              },
            );
      await this._emitSafe(HOOKS.ON_ERROR, wrapped);
      throw wrapped;
    } finally {
      this._running = false;
      this._runStartedAt = null;
    }
  }

  async _emitSafe(event, payload) {
    try {
      const { errors = [] } = await this._hooks.emitSafe(event, payload);
      for (const error of errors) {
        try {
          this._logger.warn("Update lifecycle hook failed", {
            event,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Hook logging must never interrupt the update lifecycle.
        }
      }
    } catch (error) {
      try {
        this._logger.warn("Could not emit update lifecycle hook", {
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Hook logging must never interrupt the update lifecycle.
      }
    }
  }

  _wrapError(error, phase, startedAt) {
    const context = {
      ...(error instanceof UpdatePilotError ? error.context : {}),
      phase,
      durationMs: Date.now() - startedAt,
    };
    const options = {
      cause: error instanceof UpdatePilotError ? (error.cause ?? error) : error,
      context,
    };
    if (error instanceof ConfigError)
      return new ConfigError(error.message, options);
    if (error instanceof UpdateInProgressError)
      return new UpdateInProgressError(error.message, options);
    if (error instanceof HealthCheckError)
      return new HealthCheckError(error.message, options);
    if (error instanceof DockerError)
      return new DockerError(error.message, options);
    if (error instanceof RollbackError)
      return new RollbackError(error.message, options);
    if (error instanceof UpdatePilotError)
      return new UpdatePilotError(error.message, options);
    return new UpdatePilotError(
      error instanceof Error ? error.message : String(error),
      { cause: error, context },
    );
  }

  _ensureAdapters({ github = true, docker = true, health = true } = {}) {
    if (github && !this._github)
      this._github = new GitHubAdapter({
        ...this._config.github,
        repo: this._config.repo,
        currentVersion: this._config.currentVersion,
        logger: this._logger,
      });
    if (docker && !this._docker)
      this._docker = new DockerAdapter({
        ...this._config.docker,
        logger: this._logger,
      });
    if (health && !this._health)
      this._health = new HealthAdapter({
        ...this._config.health,
        logger: this._logger,
      });
  }
}
