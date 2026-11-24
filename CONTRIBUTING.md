# Contributing

Install dependencies with `npm ci` separately in frontend and backend. Use Node 22.12+ and keep lockfiles committed with dependency changes. Never commit .env files, credentials, original student data or generated build output.

## Before opening a change

Run backend typecheck, lint, tests and build; run frontend typecheck, lint and build. CI repeats these checks. The backend regression suite uses a temporary HTTP server, fake credentials and database stubs. No live services are required.

For UI changes, inspect a narrow mobile viewport and a desktop viewport. Test keyboard navigation, focus return after dialogs, empty/error/loading states and signed-out behavior. Match existing semantic color tokens and reusable components. Prefer plain, actionable labels.

## Structure

- HTTP routes validate requests, enforce authorization and shape responses.
- Keep scheduling and ranking logic in pure helpers with behavioral tests.
- Keep account-owned queries scoped to the authenticated user.
- Treat AI/provider responses as untrusted input and validate them before persistence.
- Change the Prisma schema through a new migration; never rewrite already-applied migrations.
- TanStack uses file-based routing. Do not edit generated routeTree.gen.ts manually.
- Update architecture and operations docs when behavior or deployment steps change.

Use `npm run format` in frontend for Prettier. Avoid unrelated dependency upgrades. Explain the problem, resulting behavior, verification and remaining limitations in a pull request.

The original academic report is preserved in docs/project-report.md as historical context; keep operational instructions in README.md and docs/operations.md.
