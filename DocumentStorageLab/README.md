# Document Storage Lab

This lab uses a document library to study two questions: what happens to the application when a service is replaced, and what happens to reads and writes when a replica is lost? The deployment covers software defined infrastructure (Topic 7) and software defined storage (Topic 10).

Nginx routes requests to two Express instances. MongoDB holds the catalogue, version history and sessions. SeaweedFS holds the file contents under policy 001 by default, which requests two copies on services in one logical rack. The copies and the database still share the host.

## Run locally

Use Node.js 24 and Docker Compose. Run from this directory:

```sh
node scripts/prepare-local.mjs
docker compose up -d --build
```

Open [the library](http://127.0.0.1:18380/) once the catalogue connects. A fresh installation starts empty; the `fixtures/` directory contains files to try.

| Account | Demo password | Access |
|---|---|---|
| viewer | viewer-lab-2026 | Browse, preview, download and export receipts |
| editor | editor-lab-2026 | Also upload, add versions, change categories, trash, restore and import receipts |

These accounts are for loopback use. Both roles can read all retained versions, including trash. See the [application guide](Application%20Guide.md) for how to use the library.

The preparation script creates missing MongoDB credentials in `.local/secrets`. Keep them with an initialized database. To stop without removing data, use `docker compose --profile expand down`. If monitoring was enabled, pass its Compose file and profile to `down` as well.

## Deployment

| Component | Responsibility | CPU / memory limit |
|---|---|---|
| Nginx | Loopback gateway and passive upstream failover | 0.25 core / 128 MiB |
| Each API | Document operations, session checks and verified reads | 0.5 core / 256 MiB |
| MongoDB | Catalogue, receipts, history and hashed sessions | 0.5 core / 512 MiB |
| Each SeaweedFS service | File ID allocation or storage of file bytes | 0.5 core / 256 MiB |
| Prometheus | Scrapes private API metrics | 0.5 core / 256 MiB |
| Grafana | Local dashboard | 0.5 core / 384 MiB |

Only the gateway publishes the application port. The APIs reach the database and storage on separate internal networks. Named volumes keep data after container replacement. MongoDB uses a single replica-set member for transactions, so both APIs lose catalogue access if it is down.

Nginx may retry a read after an upstream connection error. It does not replay a POST or PATCH already sent to an API. If storage accepts the bytes but the catalogue commit cannot be confirmed, the API returns a recovery receipt. Retrying by uploading the file again could create a duplicate; receipt recovery checks the stored bytes first.

## API overview

| Route | Purpose |
|---|---|
| `GET /api/health`, `GET /api/ready` | Process liveness and dependency readiness |
| `GET /api/catalogue` | Shared document receipts and activity |
| `POST /api/files` | Store a first or later version; revisions use `x-document-id` and `x-document-revision` |
| `GET /api/files/:fid` | Read a catalogued version |
| `PATCH /api/documents/:id` | Change category or trash state with an expected revision |
| `POST /api/catalogue/import` | Verify and import receipt metadata |

The server enforces the viewer/editor distinction. Writes require the exact workspace Origin and an editor session. The local session cookie is HttpOnly and SameSite Strict; a remote deployment would need HTTPS, Secure cookies and a separate identity design.

## Backup and restore

The backup captures catalogue metadata and all retained versions, including trash. It verifies file sizes and hashes as it copies the bytes. A receipt export alone cannot restore files.

```sh
mkdir -p backups
node scripts/backup-local.mjs backup --project dodc-document-lab --port 18380 --out backups/snapshot-01
node scripts/backup-local.mjs verify --in backups/snapshot-01
```

Restore into a fresh, empty project on a separate port:

```sh
LAB_HTTP_PORT=18391 docker compose -p dodc-document-lab-restore up -d --no-build
node scripts/backup-local.mjs restore --in backups/snapshot-01 --project dodc-document-lab-restore --port 18391
LAB_HTTP_PORT=18391 docker compose -p dodc-document-lab-restore down
```

The restore keeps document IDs and history but assigns new storage IDs. It rejects a nonempty target and does not copy users, sessions or database credentials. The October drill restored 167 documents and 174 versions. Provisioning and verification took 15.532 seconds for 6,733 bytes of sample data. That timing does not estimate production recovery time, and a backup on the same laptop does not cover host loss.

## Test deployments

The failure runners use an isolated test project with separate volumes and a different port. Build the test image before running a check:

```sh
LAB_HTTP_PORT=18390 docker compose -p dodc-document-lab-test -f compose.yaml -f tests/compose.test.yaml up -d --build
node tests/availability-integration.mjs
node tests/access-integration.mjs
node tests/catalogue-integration.mjs
node tests/lifecycle-integration.mjs
```

The browser checks require Playwright on Node's module path. The launchers use the standard macOS Chrome path unless `CHROME_PATH` is set. Each run writes its results under `evidence/`.

```sh
LAB_HTTP_PORT=18390 docker compose -p dodc-document-lab-test -f compose.yaml -f tests/compose.test.yaml down
```

The replication, three-master and performance runners use fresh project names and the test image. The restore runner also needs the isolated test deployment as a backup source. Run the fault checks against those projects only. The overrides live in `experiments/`; use a Compose version that supports `!override` (2.24.4 or later).

| Runner in `tests/` | What it measures |
|---|---|
| `replication-integration.mjs` | Actual copy locations and hashes for 000, 001 and 010; reads and writes after one volume stops; future placement after a third service joins |
| `recovery-integration.mjs` | Snapshot and restore into an empty project; corrupt backup and invalid-target rejection |
| `masters-integration.mjs` | Reads and writes after leader loss; fresh allocation with two peers stopped |
| `performance.mjs` | Four API budgets and layouts, three file sizes, two concurrency settings and three repeats |

Adding the third volume service raised configured slots from 16 to 24. The original files stayed in place. The two master tests agreed that existing reads still worked with two peers stopped, but an upload into existing placement returned 503 in one run and 201 in the other.

The benchmark recorded 5,760 requests across 144 groups. For 1 MiB at concurrency eight, one full-core API returned lower p95 latencies than two half-core APIs with the same total CPU and memory. The second process still helped with failover. The report discusses why those are separate decisions.

## Monitoring

```sh
docker compose -f compose.yaml -f monitoring/compose.yaml --profile monitoring up -d --build
```

Open [Prometheus](http://127.0.0.1:18381/) or the [Grafana dashboard](http://127.0.0.1:18382/d/dodc-operations/document-service-operations). Prometheus scrapes each API on an unpublished metrics port. The dashboard shows dependency readiness, request rates, errors, estimated p95 and process resources. An API can still expose metrics when MongoDB is down. The alerts are local; they do not send notifications.

## Results

The [evidence index](evidence/index.json) lists the recorded runs. The October browser screenshots show the interface used for those tests. The current interface uses the same document API. [Report data and figures](report/README.md) describes how to rebuild the tables and charts from the saved results.

Bootstrap and PDF.js are bundled with their upstream licenses under `app/public/vendor/`.
