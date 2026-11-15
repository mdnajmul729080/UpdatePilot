# Agent Development Rules

## Private `notes/` Directory

- `notes/` is for local development planning and implementation records only.
- Keep its contents private and out of Git, npm packages, public documentation, and releases.
- Do not put public-facing documentation, release notes, public project information, credentials, tokens, or other secrets in `notes/`.
- Use Markdown for plans, investigation notes, and phase/update logs.

## Before Making Changes

- Before every source, test, configuration, or documentation change, write or update a plan in `notes/` describing the goal, scope, steps, and verification criteria.
- Do not begin implementation until that plan has been recorded.
- For multi-step work, update the plan as each phase begins and completes.

## Record Implementation

- Record what was changed, when, the relevant files, tests/checks run, their results, and any remaining issues in a Markdown log under `notes/`.
- Update the log after each implementation phase and before starting another change phase.
- Keep these notes local; never link them from public docs or copy them into package contents.
