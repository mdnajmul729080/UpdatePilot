# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core UpdatePilot engine with orchestrator flow
- `defineConfig()` with strict validation and helpful error messages
- `GitHubAdapter` for GitHub Releases checks with caching and rate-limit handling
- `DockerAdapter` for blue-green deployment with rollback safety
- `HealthAdapter` for HTTP health checks with timeout and retry
- `HookBus` with nine lifecycle hooks
- Full TypeScript declarations in `src/types/index.d.ts`
- Express admin panel example in `examples/basic-express/`
- Safe demo mode with simulated adapters and a real-infrastructure opt-in
- ESLint flat config, CodeQL, Dependabot, and CI matrix for Node.js 20 and 22
- README, contribution guide, and architecture documentation
- Engine-flow integration tests and a spawned-server HTTP smoke test for all admin endpoints
- npm audit remediation for the nested Dockerode dependency tree

### Changed

- `HookBus` moved from `src/utils/events.js` to `src/core/events.js`; the utility path re-exports it for compatibility.

### Security

- Health checks use `redirect: 'manual'` to prevent false-positive redirects to login pages
- Deep-freezing the resolved config prevents accidental mutation
- An in-memory concurrency lock prevents overlapping deployments
