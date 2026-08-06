---
author: Ryan Wallace
pubDatetime: 2026-07-26T16:22:00Z
modDatetime: 2026-07-26T16:22:00Z
title: "Inside Jobman, Part 3: Scheduling Without a Central Scheduler"
slug: inside-jobman-part-3
featured: false
draft: false
tags:
  - jobman
  - go
  - systems-programming
  - cli
description: How independent Jobman supervisors coordinate dependencies, waits, retries, and fair concurrency admission through durable local state.
---

<!-- markdownlint-disable MD014 -->

> **Inside Jobman:**
> [Part 1: Architecture](/posts/inside-jobman-part-1/) ·
> [Part 2: Ownership transfer](/posts/inside-jobman-part-2/) ·
> **Part 3: Scheduling** ·
> [Part 4: Process control and logs](/posts/inside-jobman-part-4/)

[Part 2](/posts/inside-jobman-part-2/) stopped after ownership had been committed to a detached supervisor. The target command had not necessarily been started. Dependencies could still be active, a retry delay could be pending, or the configured concurrency limit could already be full.

Consider the preparation and analysis pipeline from [Part 1](/posts/inside-jobman-part-1/), with the input now divided into four shards. All four analysis jobs depend on the same preparation job and use a pool with two slots:

```yaml
schema_version: 1
concurrency:
  max_active_slots: 4
  pools:
    analysis: 2
```

```console
$ for shard in 1 2 3 4; do
    jobman run --after-success "$prepare_id" \
      --pool analysis --slots 1 \
      --retries 2 --retryable-exit-code 1 --retry-delay 1s \
      -- python analyze_data.py --shard "$shard"
  done
```

Four supervisors are left waiting. When preparation succeeds, all four may observe that result within the same polling interval. Only two runs are allowed into the `analysis` pool.

No central Jobman process chooses the winners. Each supervisor attempts its own state transition against SQLite, and the transactions settle the race. The queue, slot allocations, retry deadlines, and evidence used to recover stale owners are all stored there. If a supervisor disappears, the scheduling record is left behind.

## Eligibility is checked before capacity

The word “queued” can obscure two separate situations. A job may be unable to run because a prerequisite is missing, or it may be ready but waiting for capacity. Those cases are kept separate in Jobman.

Before an admission is requested, dependencies and wait conditions are evaluated. Cancellation, pause state, and timeouts are checked as well. Only an eligible job is allowed to compete for slots.

<div class="mermaid">
flowchart TD
    A["Load durable job state"] --> B{"Terminal, paused, or stopping?"}
    B -->|"yes"| C["Observe or finalize durable state"]
    B -->|"no"| D{"Initial prerequisites satisfied?"}
    D -->|"no"| E["Evaluate dependencies and waits"]
    E --> F["Persist observations"]
    F --> A
    D -->|"yes"| G{"Retry delay elapsed?"}
    G -->|"no"| A
    G -->|"yes"| H["Try transactional admission"]
    H -->|"capacity unavailable"| I["Keep durable queue position"]
    I --> A
    H -->|"admitted"| J["Reserve and execute one run"]
    J --> K["Release admission"]
    K --> L{"Completion policy terminal?"}
    L -->|"yes"| M["Complete job"]
    L -->|"no"| N["Persist backoff or queued state"]
    N --> A
</div>

A file wait or dependency can last for hours. Capacity is not reserved during that time. One lightweight supervisor process remains, but no execution slot is consumed.

Long-running work is also kept out of SQLite transactions. A transaction records a decision or an observation and closes. Sleeps, filesystem probes, and target processes are handled afterward.

## A dependency edge becomes a receipt

When `--after-success "$prepare_id"` is submitted, the selector is resolved immediately to a canonical job ID. Missing references, contradictory predicates, and dependency cycles are rejected before submission completes.

The edge stores the required relationship:

| Predicate       | Eligible when the dependency...             |
| --------------- | ------------------------------------------- |
| `after-success` | completes successfully                      |
| `after-finish`  | reaches any terminal outcome                |
| `after-failed`  | completes with a failure outcome            |
| `after-outcome` | reaches one of the listed terminal outcomes |

While preparation is active, no final observation can be made. Each shard stays in `waiting` and checks again later.

Once preparation completes, its revision and outcome are copied onto the dependency edge in a transaction. That observation is written once. The edge now acts like a receipt: the exact terminal state that satisfied the prerequisite has been recorded, and the relationship will not be reinterpreted through a display name that may later be reused.

A successful preparation satisfies all four shard edges. A failed preparation makes `after-success` impossible. Each dependent job can then be completed as `aborted` with the `dependency_unsatisfied` diagnostic instead of being left in `waiting` forever.

No completion message has to be delivered from one job to every dependent. If a notification were missed during a crash, extra recovery machinery would be needed. Here, the completed dependency is already durable and can be observed independently by each supervisor.

## Files and probes pass through the same gate

Some prerequisites do not belong to another Jobman job. A run may be held until an absolute time, for a delay after acceptance, until a filesystem path exists, or until an executable probe succeeds.

Multiple wait conditions can be combined with `all` or `any`. Probe arguments remain separate rather than being joined into a shell command. Execution is bounded by a timeout and an output limit, and a short diagnostic is persisted after each evaluation. When `jobman show --json` is used on a job that appears stuck, those observations show what has actually been checked.

Dependencies and wait conditions are initial gates. After they have been satisfied, they are not reevaluated before every retry. A wait-abort deadline or whole-job timeout may still end the job before its first run.

Only after this stage is an admission requested.

## One transaction decides the slot race

An eligible job requests a positive slot count. When a named pool is selected, those slots are charged against both the store-wide limit and the pool limit. Without a named pool, only the global limit is used.

Requests that can never fit are rejected during submission. A three-slot request cannot run in the two-slot `analysis` pool, so no useful result would come from placing it in the queue.

A request that fits in principle but not at the moment is different. Its durable queue position is created or reloaded during each acquisition attempt. In the same short transaction, active admissions are counted, the fairness rule is applied, and either a new admission is inserted or the request remains queued.

This is the point at which the four shard supervisors meet. Suppose two slots have already been taken and the other two supervisors concurrently read an apparently available final slot. Their reads may overlap, but their writes cannot both commit on the same old state. SQLite serializes the admission transactions. The winner records its allocation; the other attempt observes the new usage or loses the compare-and-swap and stays queued.

After admission, the job enters `starting`. The allocation is bound to the run once that run has been reserved. A failed attempt leaves the original queue position intact instead of sending the job to the back.

## The oldest request may be bypassed, three times

Strict first-in, first-out ordering behaves poorly when jobs request different numbers of slots. Suppose a pool has room for four:

| Current state             | Slots |
| ------------------------- | ----: |
| Active run                |     2 |
| Oldest queued request     |     3 |
| Younger queued request    |     1 |
| Capacity currently unused |     2 |

The three-slot request cannot start. Under strict FIFO, the one-slot request would also be blocked and two usable slots would sit idle. If every smaller request were always allowed through, the large request could instead be starved by a steady stream of short jobs.

A bounded bypass is used. When the oldest competing request does not fit, a younger request that does fit may be admitted. The older request's bypass counter is incremented in the same transaction. Once three bypasses have been recorded, younger competitors must wait for it.

In reduced form:

```go
older := oldestCompetingRequest(request)

if older.fitsNow() || older.bypassCount >= 3 {
    return ErrCapacity
}
if !request.fitsNow() {
    return ErrCapacity
}

persistAdmission(request)
incrementBypassCount(older)
```

Competition is limited to shared finite scopes: the global limit, the same finite named pool, or both. Requests in unrelated pools are not ordered against one another just because their supervisors happen to poll at the same time.

Initial order is based on the time prerequisites were satisfied, with the canonical job ID used to break ties. This is not weighted fair sharing, and no running job is preempted. The narrower goal is to allow some backfilling without making starvation unbounded.

## An expired lease does not manufacture a free slot

Every admission has a lease that is renewed by its supervisor while the run is active. It would be tempting to treat the expiration timestamp as automatic capacity reclamation. That could violate the limit.

A laptop may have resumed from sleep, or a live supervisor may have been delayed while SQLite was busy. Its target could still be using the resource even though the lease is stale. If those slots were immediately reassigned, both the old and new runs would be counted as active outside the database while only one allocation appeared inside it.

Expiration therefore starts reconciliation. The owning job, supervisor lease, and stored process identity are checked. Capacity is released after the owner is shown to be gone or the job has already completed. When identity cannot be verified safely, the allocation is left alone.

The timestamp says when doubt is justified. It does not prove that a process has stopped.

## A retry gives up its seat

After a run ends, its result is classified as success, retryable failure, or non-retryable failure. Cancellation, whole-job timeout, success and failure counts, the run limit, and any retry deadline are then evaluated in a fixed order.

The admission is released before another attempt is delayed or started. If the retry policy permits another run, constant, linear, or exponential delay is calculated with the configured cap and bounded jitter. An exact `next_run_at` timestamp is persisted for `backoff`; without a delay, the job returns directly to `queued`.

No slot is held during backoff. Once the timestamp is reached, admission must be won again. A flaky shard therefore cannot occupy half of the analysis pool while it waits for its next attempt.

The whole-job timeout continues across dependency waits, admission waits, and retry delays. A run timeout covers only one target invocation and can itself produce a retryable result. Actual termination belongs to the execution boundary described in Part 4; the scheduler only decides whether another run may follow.

## Polling is used on purpose

Without a resident scheduler, no shared condition variable is available when a dependency completes or a slot is returned. Supervisors check durable state at bounded intervals.

The ordinary interval is 100 milliseconds. Symmetric jitter between 90 and 110 percent is applied so the four shard supervisors do not keep waking in lockstep after being submitted together. Longer intervals can be configured for wait conditions, and backoff polling is bounded by the recorded eligibility time.

Some database reads and up to a polling interval of scheduling latency are accepted here. In exchange, a missed in-memory wake-up cannot strand a job. After a restart, no queue has to be reconstructed from a scheduler process because the useful parts of that queue were already stored.

This trade is aimed at local jobs owned by one user on one machine. Thousands of remote workers or sub-millisecond dispatch would call for a different design.

## The queue survives its supervisors

For the shard pipeline, the dependency revision says why each job became eligible. The prerequisites-satisfied timestamp preserves its initial place in line. Admission rows and bypass counts record who received capacity and who was allowed through. Leases identify allocations that deserve investigation. Retry timestamps keep policy from being reconstructed from process memory or log text.

Each supervisor still acts for only one job. Coordination occurs where a shared fact must be changed, through a short transaction against those durable records. No supervisor is given authority to schedule the others.

Once one shard has been admitted, another boundary has to be crossed. A target may spawn descendants, fill stdout and stderr pipes, ignore graceful termination, or exit while its final output is still being drained. [Part 4: Process Trees, Timeouts, and Durable Logs](/posts/inside-jobman-part-4/) follows that run from reservation through its recorded result.

---

**Previous:** [Part 2: Transferring Job Ownership to a Detached Supervisor](/posts/inside-jobman-part-2/)

**Next:** [Part 4: Process Trees, Timeouts, and Durable Logs](/posts/inside-jobman-part-4/)

[View every Jobman article](/tags/jobman/)

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
