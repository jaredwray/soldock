# ADR-0004: Partition state by owner: D1 for the directory, SQLite Durable Objects per owner, R2 for bytes

- **Status:** accepted
- **Date:** 2026-10-15
- **Decided in:** plan bootstrap (requirement R8)

## Context

The system must scale to thousands of users without hot spots. D1 is capped at 10 GB per database
and serializes writes. Each SQLite-backed Durable Object provides strongly consistent,
transactional storage of up to 10 GB, single-threaded execution (a soft limit of about 1k requests
per second), alarms, PITR and hibernatable WebSockets. There is no limit on the number of objects.
R2 stores objects of up to 5 TiB with no egress fees.

## Decision

- **D1 `directory`** holds only small, global, read-heavy data: org settings, domains, principals,
  addresses, group membership, credentials and sessions, OAuth clients, agent policies, and the
  **object registry** (every Durable Object instance with its type, owner and backup cursor).
- **A Durable Object per owner or collaboration unit**:
  - `PrincipalDO` per principal
  - `MailboxDO` per mailbox
  - `DriveSpaceDO` per drive space
  - `DocumentDO` per native document
  - `MeetingDO` per meeting

  Each object is authoritative for its own data and ACLs. Per-user state lives in the domain
  that owns it ([ADR-0013](0013-per-principal-state.md)).
- **Shared infrastructure objects**, sharded so none is a hot spot:
  - `BlobIndexDO`: 256 shards by hash prefix, mapping blob hashes to storage keys and reference counts
  - `BackupRunDO`: one per backup run
- **R2 `blobs`** holds every large or immutable payload under opaque keys, deduplicated by SHA-256
  through `BlobIndexDO`. Objects store references, not bytes. Other buckets: `backups` (locked), `archive` (Infrequent Access) and `audit` (locked).
- **Cross-object effects** (sharing fan-out, mail delivery to many mailboxes, notifications) use
  a **transactional outbox** inside the source object, delivered at least once by alarm or queue to
  idempotent handlers. No distributed transactions.

## Consequences

- Adding users adds objects, which scale independently. The directory remains the only shared
  database, so we cache aggressively (address routing, auth lookups) and use D1 read replicas.
- Queries that cross owners (eDiscovery, org-wide search, admin reports) are fan-out jobs
  (Workflows), not SQL joins. This is acceptable because they are rare and privileged.
- A very large shared mailbox or drive could approach 10 GB. Mitigations: bytes live in R2,
  ≈5 KB per message gives about 2M messages, and if a mailbox ever reaches that, we can shard it into
  archive objects by date (post-v1).
- Each object's schema is migrated lazily on wake. Migrations must be fast and forward-only.

## Alternatives considered

- *Everything in D1, sharded by user across many databases*: we would have to manage shards
  ourselves, and real-time collaboration would get no WebSocket or co-location benefits.
- *One Durable Object per user for everything*: this mixes unrelated workloads, and shared mailboxes,
  shared drives and documents don't belong to one user.
