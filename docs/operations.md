# Operations

## Configuration and deployment

1. Provision PostgreSQL with pgvector and create separate application and migration connections where your host supports them.
2. Set the required environment variables from `backend/.env.example`. Keep secrets out of source control and frontend `VITE_*` variables.
3. Install locked dependencies, generate Prisma and build both packages.
4. Back up the database and apply committed migrations with `npm run db:migrate:deploy` in `backend/`.
5. Start the API and deploy the frontend using its configured Nitro/Vercel output.
6. Set `FRONTEND_URL` to the exact frontend origin. Add each trusted preview origin explicitly to `CORS_ORIGINS`.
7. Confirm health, public catalogue reads, sign-in and a protected request.

The API assumes one trusted reverse proxy in production. Review `trust proxy` for your actual network topology before deployment. CORS is a browser boundary, not authentication: direct HTTP clients still need route-level authorization.

The Docker Compose file runs only the API, with an external database. It does not run migrations or the frontend. Both Docker stages use Node 22. The build context excludes environment files and local dependencies.

## Local development

Use two terminals:

```sh
# Terminal 1
cd backend
npm run dev
```

```sh
# Terminal 2
cd frontend
npm run dev -- --port 3000
```

If using port 3010, for example, set `CORS_ORIGINS=http://localhost:3010,http://127.0.0.1:3010` in the API environment and restart it. These are different origins. `VITE_API_URL` is embedded in the frontend build; a production change requires a rebuild.

## Seeding

Local demo accounts are intentionally simple for development. In production the seed requires `SEED_ADMIN_PASSWORD` and `SEED_TEACHER_PASSWORD`, each at least 12 characters. The seed upserts existing accounts without changing their passwords. Re-running it does **not** rotate credentials for an existing user.

Subjects come from the optional root OUTPUT directory. The seed creates branch records even when that directory is missing. Manage subjects through the admin catalogue if no paper collection is available.

## Indexing and model changes

Inspect the script's flags and configuration before running it against a deployment:

- `scripts/backfill.ts`: resource chunks; supports branch and missing-only filtering.
- `scripts/backfillQuestions.ts`: individual questions.
- `scripts/buildTopicProfiles.ts`: cached topic descriptions, aliases and query vectors.
- `scripts/bulkUpload.ts`: collection import; can write many resources and consume provider quotas.

When changing embedding providers, do not mix old and new vectors even if dimensions match:

1. Pause retrieval traffic or use a maintenance window.
2. Back up the database.
3. Set the new provider keys consistently for the API and maintenance scripts.
4. Re-index resource chunks, individual questions and syllabus chunks; verify the scripts' coverage for your data.
5. Rebuild stale topic profiles and restart API processes to clear in-memory caches.
6. Verify known queries against known papers before restoring traffic.

The current scripts are maintenance tools, not a versioned index migration system. For a larger deployment, build a new index alongside the old one and switch after validation.

## Troubleshooting

| Symptom                                   | Check                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Empty course list                         | Was the optional OUTPUT collection available at seed time? Add subjects in the admin catalogue.                              |
| Browser CORS error                        | Exact scheme, hostname and port in FRONTEND_URL/CORS_ORIGINS; restart the API.                                               |
| Quizzes or flashcards return 503          | Provider credentials, quota, configured model availability and generation logs. No placeholder material is saved.            |
| Uploaded paper cannot be found by topic   | Background ingestion may still be running or may have failed; inspect logs and backfill.                                     |
| Search changed after a key update         | Verify the embedding provider/model and re-index incompatible vectors.                                                       |
| Prisma asks to reset an existing database | Stop and inspect migration history/drift. Use migrate deploy for committed migrations; do not approve a data reset casually. |
| Prisma client file is locked on Windows   | Stop running API/watch processes before generating the client.                                                               |
| Health is green but data requests fail    | Health checks process liveness only; verify the database and external services separately.                                   |

## Recovery and scale

SIGINT/SIGTERM stop new HTTP connections and drain active requests before Prisma disconnects. A ten-second deadline bounds shutdown; a long agent stream or indexing task can be interrupted. Background indexing should move to a durable queue before reliable multi-instance operation.

Global limits are in-memory (200 requests/minute per client IP, auth 20/15 minutes). Some expensive routes have additional limits. Review user-based quotas, shared rate-limit storage, durable ingestion jobs and centralized monitoring before increasing traffic.

Maintain database backups, monitor failed ingestion and orphaned-file cleanup logs, and verify recovery against a non-production environment. Automated tests mock database methods and do not replace PostgreSQL transaction or live-provider integration tests.
