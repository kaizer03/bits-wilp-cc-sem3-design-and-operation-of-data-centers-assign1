# Run the lab

Install Node.js 24 and Docker Compose 2.24.4 or later. From this directory:

```sh
node scripts/prepare-local.mjs
docker compose up -d --build
```

Open [the library](http://127.0.0.1:18380/) and upload a file from `fixtures/`.

| Account | Demo password | Access |
|---|---|---|
| editor | editor-lab-2026 | Upload, revise, trash and restore |
| viewer | viewer-lab-2026 | Browse, preview and download |

The gateway binds to loopback. Keep `.local/secrets` with the initialized database. Use `docker compose --profile expand down` to stop without deleting data.

## Experiments

Use a separate test project so faults do not affect the main library:

```sh
LAB_HTTP_PORT=18390 docker compose -p dodc-document-lab-test -f compose.yaml -f tests/compose.test.yaml up -d --build
```

The `tests/` directory contains catalogue, access, availability and recovery checks. The replication, master and performance runners start separate projects using the test image and overrides in `experiments/`. Browser checks need Playwright and Chrome; set `CHROME_PATH` if Chrome is elsewhere.

For metrics, start with `-f compose.yaml -f monitoring/compose.yaml --profile monitoring` before `up`. Prometheus uses port 18381 and [Grafana](http://127.0.0.1:18382/d/dodc-operations/document-service-operations) uses 18382. Use the same overrides when stopping that stack.

## Backup

```sh
mkdir -p backups
node scripts/backup-local.mjs backup --project dodc-document-lab --port 18380 --out backups/snapshot-01
node scripts/backup-local.mjs verify --in backups/snapshot-01
```

Restore only into an empty project:

```sh
LAB_HTTP_PORT=18391 docker compose -p dodc-document-lab-restore up -d --no-build
node scripts/backup-local.mjs restore --in backups/snapshot-01 --project dodc-document-lab-restore --port 18391
```

[Application guide](Application%20Guide.md) · [Evidence](evidence/index.json) · [Report data](report/README.md)

Bootstrap and PDF.js licenses are in `app/public/vendor/`.
