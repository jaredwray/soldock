# `@soldock/cli` (`soldock`)

> Status: **planned**. The first command is `provision`. Later commands are `restore`, `dr rebuild` and `init`.

The operator CLI for self-hosters: provisions Cloudflare resources (D1, R2 buckets with lifecycle rules and bucket locks, KV, Queues and their DLQs, Email Routing, DNS), runs interactive setup, and (when backups exist) drives backup, restore and disaster-recovery operations through the authenticated admin API.
