# Application guide

Open [Document Storage](http://127.0.0.1:18380/) and sign in with an account from the [README](README.md#run-the-lab). The catalogue and storage indicators are separate. The catalogue depends on MongoDB; storage status comes from SeaweedFS.

## Files and versions

An editor can upload up to ten files at once, each at most 5 MiB. Files in a batch are sent independently. The library retains failed selections so they can be checked or retried. Documents appear in another browser after its next refresh.

Open **Details** to see the file ID, size and SHA-256 checksum. Editors can change the category or add a version. **Version history** opens the bytes retained for a previous version. A category change does not create a content version. If someone changes the document first, refresh its details before retrying.

Select **Trash** to see deleted documents. Editors can restore them with their original IDs and history. Trash leaves every version in storage. Both roles can read retained documents in trash.

The library checks the size and hash before download or preview. Text, images and the first ten pages of a supported PDF can be previewed. Download gives the full file. A past verification does not guarantee that the file is still reachable.

## Receipts

**Export receipts** saves identifiers and hashes. It does not copy the files. An editor can import receipts from the same storage deployment; the API verifies the actual bytes before accepting the metadata. Repeating an import does not create another document. If an older version of the library left receipts in this browser, **Add previous receipts** can add them to the shared catalogue.

If a write reaches storage but the catalogue acknowledgement fails, the library shows **Unconfirmed uploads**. Export the recovery receipt before closing the page. When the database is back, refresh the catalogue and use **Verify and recover uploads**. A recovery receipt from a failed version upload can register the bytes as a separate document. Check the original version history before uploading that revision again.

## Storage and activity

**Storage** lists the services SeaweedFS can reach and the configured allocation slots. Slots are a configuration limit, not free disk space. The default 001 policy requests two copies under one rack label. All services still share the host.

**Recent activity** shows up to eight changes and retrievals recorded by the server. The **Experiments** section links to the deployment notes and storage status. The library does not stop or start services from the browser; the [test deployments](README.md#experiments) cover those faults on separate data.
