# Contributing

QuantsMind AI Coder v3.1.0 is the current build (a reliability-qualified
candidate on the v3.0.0 GA base). Contributions should preserve its core
invariants:

1. **Explicit context and explicit sending.** No automatic workspace scanning,
   no background provider requests, and no file modification without per-file
   approval.
2. **Contained change and command execution.** Writes stay inside the workspace
   with backups, and commands are allowlisted, shell-free, and user-triggered.
3. **Independent packaging.** The project stays a single npm package with no
   QuantsMind-Agent, shared SDK, submodule, monorepo, Python runtime, backend,
   or database dependency.

## Setup

```bash
npm ci
npm run compile
npm run lint
npm run test:unit
```

Use Node.js 20 or newer. The repository includes `.nvmrc` for Node 22. VS Code
1.95.0 is the minimum supported host.

## Branches and baseline

- `main` holds the reproducible baseline for released preview builds.
- `develop` is the active development branch.
- Use short-lived feature branches from `develop`, then merge back after CI
  passes.

Do not create, push, or transfer a remote repository, publish to a Marketplace,
or create a release without explicit maintainer authorization. The local Git
baseline is intentionally separate from any hosting decision.

## Workflow

1. Create a branch from `develop`.
2. Make a focused change with tests.
3. Run the full local verification:

   ```bash
   npm run verify
   npm run test:packaged
   ```

4. Update documentation and `CHANGELOG.md` when behavior changes.
5. Open a pull request after CI passes.

## Code standards

- TypeScript strict mode with `noUnusedLocals` and `noUnusedParameters`.
- CommonJS output targeting ES2022 for the VS Code extension host.
- Keep provider-neutral logic free of `vscode` imports so it stays unit-testable.
- Validate and normalize all input crossing a trust boundary: provider
  responses, webview messages, endpoint URLs, credentials, and file content.
- Never log request bodies, credentials, or attached file content.
- Never add a setting that stores a credential.
- Do not add a file write or command execution without explicit approval,
  workspace containment, and tests.
- Keep webview markup free of remote assets and inline executable scripts.
- Add tests for every security-relevant behavior.

## Commit style

Use concise imperative subjects, for example:

```text
Add SSE chunk-boundary coverage
Fix redaction of Basic authorization headers
Document loopback endpoint policy
```

Explain the motivation in the body when it is not obvious.

## Dependency changes

- Pin exact versions in `package.json`.
- Keep the runtime dependency surface minimal.
- Run `npm audit --omit=dev` and confirm it is clean.
- Document any new dev-only advisory rather than silently accepting it.
- Do not add a dependency that requires a QuantsMind repository or private
  registry.

## Security reports

Follow [SECURITY.md](SECURITY.md). Do not open public issues with working
exploits or real credentials.

## License

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
