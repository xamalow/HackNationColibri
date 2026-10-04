# Workspace integration and checks

Platform owns the root package manifest, lockfile, ESLint configuration and CI workflow. Mobile owns
`apps/mobile`, Hub owns `apps/hub`, and Domain owns `packages/core` and the shared contracts. When a
workspace manifest changes, send its exact commit to Platform so the root dependency closure can be
refreshed before merge. A child lockfile alone does not update the root lockfile.

Run `npm ci --ignore-scripts --no-audit --no-fund` from the repository root. This frozen install includes
the declared workspaces and links `@sauti/core`. Build Core before checking Mobile or Hub because its
public exports resolve to `packages/core/dist`. CI runs Core typecheck/tests/build, Hub JavaScript
syntax checks and simulated tests, then Mobile typecheck, its own ESLint version and parser tests.
Hub is plain MJS and has no transpilation or TypeScript build. Conditional steps report when a workspace
has not landed; they do not certify absent code. Lifecycle scripts are disabled in CI; native artifact
downloads and signed device builds remain separate checks described in `NATIVE_PINS.md`.

The root pins Expo's TypeScript import resolver so its app lint rules can find the resolver after
workspace hoisting. Mobile retains ESLint 9 while the root uses ESLint 10. CommonJS configuration files
have Node's directory globals; the portable Core's runtime restrictions remain scoped to its source.

Hub tests use local, synthetic data and simulated transports. Real provider credentials are supplied
through environment variables or a deployment-owned Key Vault integration; never commit their values,
put them in room messages or print them in logs. The provider adapters document their own configuration.
Keep Hub runtime SQLite files, WAL/SHM sidecars, inbox contents and outbound JSONL under the ignored
runtime directory with access restricted to the hub operator. Those files can contain phone numbers
and message bodies. Fixtures committed to this public repository must remain synthetic.

Owner alerts inform Noor and cannot authorize an action. SMS approvals require the enrolled sender
and the expiring, single-use code bound to the exact proposal and digest. App approvals retain their
own Core authentication contract. Provider sends, live phone calls, TLS/authentication deployment and
device acceptance require their own evidence; passing CI does not demonstrate those operations.
