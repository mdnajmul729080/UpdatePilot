import Docker from "dockerode";
import DockerCompose from "dockerode-compose";
import { DockerError } from "../utils/errors.js";
import { silentLogger } from "../utils/logger.js";
import { retry } from "../utils/retry.js";

/** @typedef {{ pulled: true, image: string }} PullResult */
/** @typedef {{ id: string, name: string, image: string, state: string, status: string }} ContainerInfo */
/** @typedef {{ success: true, newContainerId: string | null, previousContainerId: string | null }} DeployResult */
/** @typedef {{ finalized: true }} FinalizeResult */
/** @typedef {{ rolledBack: true, restoredContainerId: string | null }} RollbackResult */
/** @typedef {{ image?: string, tag?: string, containerName?: string, composeFile?: string, socketPath?: string, logger?: Object, dockerClient?: Object, dockerComposeClient?: Object, keepImages?: number }} DockerAdapterOptions */

/**
 * Perform Docker deployments while retaining the previous container until verification.
 * @example
 * const docker = new DockerAdapter({ image: "ghcr.io/acme/app", containerName: "app" });
 * await docker.pull();
 */
export class DockerAdapter {
  /**
   * Create an adapter without connecting to Docker until an operation is requested.
   * @param {DockerAdapterOptions} options Docker image and optional client/configuration overrides.
   * @example
   * new DockerAdapter({ image: "ghcr.io/acme/app", tag: "1.2.3", containerName: "app" });
   */
  constructor({
    image,
    tag = "latest",
    containerName,
    composeFile,
    socketPath = "/var/run/docker.sock",
    logger = silentLogger,
    dockerClient,
    dockerComposeClient,
    keepImages = 3,
  } = {}) {
    if (typeof image !== "string" || image.trim() === "")
      throw new DockerError("image is required", {
        context: { operation: "constructor", image },
      });
    this.image = image;
    this.tag = tag;
    this.containerName = containerName ?? image.split("/").at(-1);
    this.composeFile = composeFile;
    this.socketPath = socketPath;
    this.logger = logger;
    this.dockerClient = dockerClient;
    this.dockerComposeClient = dockerComposeClient;
    this.keepImages = keepImages;
    this._previousContainer = null;
    this._newContainer = null;
    this._deployError = null;
  }

  /**
   * Pull the configured image and wait for the pull stream to finish.
   * @param {string} [tag=this.tag] Image tag to pull.
   * @returns {Promise<PullResult>} Confirmation and fully-qualified image reference.
   * @example
   * await adapter.pull("1.2.3");
   */
  async pull(tag = this.tag) {
    const repoTag = `${this.image}:${tag}`;
    try {
      await retry(() => this._pullWithProgress(repoTag), {
        retries: 3,
        baseDelay: 1_000,
      });
      return { pulled: true, image: repoTag };
    } catch (error) {
      throw new DockerError(`Failed to pull ${repoTag}`, {
        cause: error,
        context: { operation: "pull", image: repoTag },
      });
    }
  }

  /**
   * Find the running container matching the configured name.
   * @returns {Promise<ContainerInfo | null>} Container details or null when absent/unavailable.
   * @example
   * const current = await adapter.getCurrentContainer();
   */
  async getCurrentContainer() {
    try {
      const containers = await this._getDocker().listContainers({
        all: true,
        filters: { name: [this.containerName] },
      });
      const entry = containers.find((item) =>
        item.Names?.includes(`/${this.containerName}`),
      );
      if (!entry) return null;
      return {
        id: entry.Id,
        name: this.containerName,
        image: entry.Image,
        state: entry.State,
        status: entry.Status,
      };
    } catch (error) {
      try {
        this.logger.warn("Could not find current Docker container", {
          containerName: this.containerName,
          error: error.message,
        });
      } catch {
        // Logging is best-effort; retain null-on-error behavior.
      }
      return null;
    }
  }

  /**
   * Deploy a new image alongside the old container without removing the old one.
   * @param {string} [newTag=this.tag] Tag to deploy.
   * @returns {Promise<DeployResult>} New and previous container identifiers.
   * @example
   * const deployment = await adapter.deploy("1.2.3");
   */
  async deploy(newTag = this.tag) {
    let created;
    try {
      await this.pull(newTag);
      const previous = await this.getCurrentContainer();
      this._previousContainer = previous
        ? { ...previous, instance: this._getDocker().getContainer(previous.id) }
        : null;
      this._deployError = null;
      const newName = `${this.containerName}-new-${Date.now()}`;
      if (this.composeFile) {
        const compose = this._getCompose();
        await compose.pull();
        const state = await compose.up();
        const newContainerId =
          state?.id ?? state?.Id ?? state?.container?.id ?? null;
        return {
          success: true,
          newContainerId,
          previousContainerId: previous?.id ?? null,
        };
      }
      const ports = await this._portOptions(previous?.id);
      created = await this._createContainer({
        Image: `${this.image}:${newTag}`,
        name: newName,
        ...ports,
      });
      this._newContainer = created;
      await created.start();
      return {
        success: true,
        newContainerId: created.id,
        previousContainerId: previous?.id ?? null,
      };
    } catch (error) {
      this._deployError = error;
      if (created) await this._safeRemove(created);
      throw new DockerError("Docker deployment failed", {
        cause: error,
        context: { operation: "deploy", image: `${this.image}:${newTag}` },
      });
    }
  }

  /**
   * Remove the previous container and prune dangling images after health verification.
   * @returns {Promise<FinalizeResult>} Finalization status.
   * @example
   * await adapter.finalize();
   */
  async finalize() {
    if (!this._previousContainer && !this._newContainer)
      return { finalized: true };
    try {
      const previous = this._previousContainer?.instance;
      if (previous) {
        try {
          await previous.stop();
        } catch (error) {
          if (!/not running|304|already stopped/i.test(error.message ?? ""))
            throw error;
        }
        await previous.remove({ force: true });
      }
      await this._pruneImages();
      this._reset();
      return { finalized: true };
    } catch (error) {
      throw new DockerError("Could not finalize Docker deployment", {
        cause: error,
        context: {
          operation: "finalize",
          containerId: this._previousContainer?.id,
        },
      });
    }
  }

  /**
   * Remove the attempted deployment and restart the previous container if needed.
   * @param {Error} [originalError] Error that caused rollback, such as a failed health check.
   * @returns {Promise<RollbackResult>} Rollback status and restored container identifier.
   * @example
   * await adapter.rollback(healthError);
   */
  async rollback(originalError = this._deployError) {
    try {
      if (this._newContainer) {
        try {
          await this._newContainer.stop();
        } catch (error) {
          if (!/not running|304|already stopped/i.test(error.message ?? ""))
            throw error;
        }
        await this._safeRemove(this._newContainer);
      }
      const previous = this._previousContainer;
      if (previous?.instance && previous.state !== "running")
        await previous.instance.start();
      const restoredContainerId = previous?.id ?? null;
      this._reset();
      return { rolledBack: true, restoredContainerId };
    } catch (rollbackError) {
      throw new DockerError(
        "CRITICAL: rollback failed — manual intervention required",
        {
          cause: rollbackError,
          context: { operation: "rollback", originalError, rollbackError },
        },
      );
    }
  }

  _getDocker() {
    if (!this.dockerClient)
      this.dockerClient = new Docker({ socketPath: this.socketPath });
    return this.dockerClient;
  }

  _getCompose() {
    if (!this.dockerComposeClient)
      this.dockerComposeClient = new DockerCompose(
        this._getDocker(),
        this.composeFile,
        this.containerName,
      );
    return this.dockerComposeClient;
  }

  async _pullWithProgress(repoTag) {
    const docker = this._getDocker();
    const stream = await docker.pull(repoTag);
    await new Promise((resolve, reject) => {
      let lastLog = 0;
      docker.modem.followProgress(
        stream,
        (error, output) => (error ? reject(error) : resolve(output)),
        (event) => {
          const now = Date.now();
          if (now - lastLog >= 1_000) {
            lastLog = now;
            try {
              this.logger.debug("Docker image pull progress", {
                image: repoTag,
                status: event.status,
                progress: event.progress,
              });
            } catch {
              // Progress logging must not fail the image pull.
            }
          }
        },
      );
    });
  }

  async _createContainer(options) {
    return this._getDocker().createContainer(options);
  }

  async _safeRemove(container) {
    try {
      await container.remove({ force: true });
    } catch {
      // Container cleanup is best-effort by contract.
    }
  }

  _portOptions(containerId) {
    if (!containerId) return {};
    const source = this._getDocker().listContainers;
    const entryPromise = source.call(this._getDocker(), {
      all: true,
      filters: { name: [this.containerName] },
    });
    return entryPromise.then((entries) => {
      const entry = entries.find((item) => item.Id === containerId);
      const exposed = {};
      const bindings = {};
      for (const port of entry?.Ports ?? []) {
        const key = `${port.PrivatePort}/${port.Type}`;
        exposed[key] = {};
        if (port.PublicPort)
          bindings[key] = [
            { HostPort: String(port.PublicPort), HostIp: port.IP ?? "0.0.0.0" },
          ];
      }
      return Object.keys(exposed).length
        ? { ExposedPorts: exposed, HostConfig: { PortBindings: bindings } }
        : {};
    });
  }

  async _pruneImages() {
    const docker = this._getDocker();
    const images = await docker.listImages({ filters: { dangling: ["true"] } });
    const oldest = images.sort((a, b) => (a.Created ?? 0) - (b.Created ?? 0));
    for (const image of oldest.slice(
      0,
      Math.max(0, oldest.length - this.keepImages),
    )) {
      await docker.getImage(image.Id).remove({ force: true });
    }
  }

  _reset() {
    this._previousContainer = null;
    this._newContainer = null;
    this._deployError = null;
  }
}
