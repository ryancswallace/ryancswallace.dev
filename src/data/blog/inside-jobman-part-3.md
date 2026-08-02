---
author: Ryan Wallace
pubDatetime: 2026-08-01T16:22:00Z
modDatetime: 2026-08-01T16:22:00Z
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

In [Part 2](/posts/inside-jobman-part-2/), I followed a job from submission through the point where a detached supervisor commits ownership. Acceptance does not mean the target command has started. The supervisor may still need to wait for dependencies, evaluate other prerequisites, or acquire concurrency capacity.

Return to the preparation and analysis pipeline from [Part 1](/posts/inside-jobman-part-1/), but suppose the input is divided into four shards. All four analysis jobs depend on the same preparation job and share a concurrency pool:

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

Each submission has its own supervisor. When preparation succeeds, those four processes become eligible at roughly the same time, but the `analysis` pool permits only two active runs. There is no central Jobman process holding a queue in memory or waking the winners.

The supervisors coordinate through SQLite instead. Prerequisite observations, queue order, slot allocations, leases, and retry deadlines are durable state. Any supervisor may disappear without taking the scheduling record with it.

The resulting design is decentralized, but it is not uncoordinated.

## Eligibility and admission are different decisions

Before starting a run, a supervisor answers two questions:

1. **Is the job eligible?** Its dependencies and wait conditions must be satisfied, and no timeout, pause, or cancellation may prevent progress.
2. **Is the job admitted?** Enough global and named-pool slots must be available, and no older competing request may currently have priority.

Keeping these decisions separate prevents jobs from occupying scarce capacity while they wait for something unrelated to that capacity. A job waiting for a file, a dependency, or a retry delay consumes a supervisor process, but it does not consume an execution slot.

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

No sleep, probe, or process execution occurs inside a database transaction. Transactions record short decisions; supervisors perform longer work outside them and return with new observations.

## Dependencies are durable observations

At submission, a dependency selector such as `--after-success "$prepare_id"` is resolved to a canonical job ID. Jobman rejects missing references, contradictory predicates, and dependency cycles before the job leaves submission.

The stored edge describes both the referenced job and the outcome predicate:

| Predicate       | Eligible when the dependency...                     |
| --------------- | --------------------------------------------------- |
| `after-success` | completes successfully                              |
| `after-finish`  | reaches any terminal outcome                        |
| `after-failed`  | completes with a failure outcome                    |
| `after-outcome` | reaches one of an explicit set of terminal outcomes |

While a dependency remains active, the dependent supervisor has nothing final to record. It stays in `waiting` and periodically checks again.

When the dependency completes, evaluation takes a transactional snapshot of its revision and outcome onto the edge. That observation is written once. Later evaluations use the recorded values rather than reinterpret the relationship from a mutable display name or shell command.

For the shard example, a successful preparation outcome satisfies all four edges. If preparation fails, the `after-success` predicate can never become true. Jobman completes each dependent job as `aborted` with a `dependency_unsatisfied` diagnostic instead of leaving it in `waiting` forever.

This is simpler than a durable event-delivery system between jobs. Supervisors do not subscribe to an in-memory completion channel, and a dependency does not need to find and notify every dependent process. The terminal snapshot already exists in the shared datastore; each dependent can observe it independently.

## Wait conditions use the same gate

Dependencies describe relationships between Jobman jobs. Wait conditions cover prerequisites outside Jobman's lifecycle model:

- an absolute time;
- a delay after acceptance;
- the existence and optional type of a filesystem path; or
- a bounded executable probe.

Multiple conditions combine with `all` or `any`. Probe execution preserves argument boundaries, has a timeout and output limit, and records a bounded diagnostic rather than unbounded command output. Each evaluation is persisted, making `show --json` useful when a job appears stuck.

Wait conditions and dependencies gate only the initial run. Once the prerequisites are satisfied, Jobman records that fact and does not require them again for every retry. A wait-abort deadline or whole-job timeout can terminate the job before its first run if eligibility never arrives.

The important scheduling property is the same: no admission is held while prerequisites are pending.

## Capacity is a transaction, not a counter in memory

After eligibility, a supervisor requests a positive number of slots. A job assigned to a named pool consumes that many slots from both the store-wide capacity and the pool's capacity. A job without a pool consumes only global slots.

An impossible request is rejected during submission. If the `analysis` pool has capacity two, a request for three slots will never fit, so allowing it to wait would only create a permanently blocked queue entry.

A request that can fit eventually but cannot fit now enters the durable admission queue. Each acquisition attempt runs as one short transaction that:

1. loads the current global and relevant pool capacities;
2. records or reloads the request's queue position;
3. counts slots held by active admissions;
4. applies the fairness rule; and
5. either inserts the admission or leaves the request queued.

SQLite serializes the writes. If two shard supervisors see the last available slot and try to acquire it simultaneously, the first transaction commits the admission. The second transaction then observes the updated usage and remains queued. There is no interval in which both can successfully reserve the same capacity.

On success, the job moves into `starting`, and its admission is then bound to the newly reserved run. On failure, the job remains `queued`, and its existing queue position survives later acquisition attempts.

## Fairness without wasting capacity

A plain first-in, first-out queue is predictable, but variable slot sizes create head-of-line blocking. Suppose a pool has capacity four:

| Current state             | Slots |
| ------------------------- | ----: |
| Active run                |     2 |
| Oldest queued request     |     3 |
| Younger queued request    |     1 |
| Capacity currently unused |     2 |

The oldest request cannot start until at least three slots are free. Strict FIFO would also block the one-slot request, leaving two usable slots idle. Always admitting any request that fits would improve utilization, but a steady stream of small jobs could starve the older three-slot request indefinitely.

Jobman uses bounded bypasses:

- if the oldest competing request fits now, a younger request cannot pass it;
- if the oldest request does not fit and the younger request does, the younger one may be admitted;
- each such admission increments the older request's durable bypass count; and
- after three bypasses, younger competing requests wait until the older request can proceed.

In reduced form, the decision is:

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

The real implementation performs the reads and writes in the same transaction. Requests compete only when they share a finite scope: the global limit, the same finite named pool, or both. Unrelated pools do not block one another merely because their supervisors happen to poll in the same order.

Initial queue order is based on when prerequisites became satisfied, with the canonical job ID breaking equal-time ties deterministically. A failed acquisition keeps that position. The rule is not preemption or weighted fair sharing, but it bounds starvation while allowing limited backfilling.

## Admission leases do not free capacity by themselves

An acquired admission has a lease, and the owning supervisor renews it while a run is active. The lease is liveness evidence, not an expiration timer on capacity.

Automatically returning slots as soon as a lease timestamp passes could exceed the configured limit. A delayed supervisor or temporarily busy datastore might still have a live target using the resource while another job is admitted into the supposedly free slots.

Instead, an expired admission triggers conservative reconciliation. Jobman checks the owning job, supervisor lease, and recorded process identity. Capacity is released only after the owner is proven gone or the job has already completed. If ownership cannot be verified safely, Jobman does not guess.

This follows the same principle as the supervisor handoff in Part 2: timestamps tell Jobman when to investigate, while durable identity and transitions determine what it may change.

## Retries return to the queue

When a run finishes, the supervisor classifies its result as success, retryable failure, or non-retryable failure. Completion policy considers cancellation, whole-job timeout, success and failure counts, the run limit, and any retry deadline in a fixed order. The resulting transition is committed, and the admission is released before the supervisor waits or starts another run.

If another attempt is allowed, Jobman computes its constant, linear, or exponential delay, applies the configured cap and bounded jitter, and persists either:

- `backoff` with an exact `next_run_at` timestamp; or
- `queued` when no delay is required.

The supervisor waits without holding slots. Once the deadline arrives, the job competes for admission again. A flaky job therefore cannot monopolize a constrained pool across its retry delay, and other eligible work can run between attempts.

The whole-job timeout continues to bound time spent waiting for dependencies, capacity, and retry delays. A per-run timeout, by contrast, applies to one target invocation and may itself be classified as retryable. Process termination and timeout enforcement occur at the execution boundary; this scheduling layer decides whether another admitted run should follow.

## Polling is an explicit tradeoff

Without a daemon, Jobman has no central condition variable to notify every supervisor when a dependency completes or a slot is released. Supervisors recheck durable state at bounded intervals.

The ordinary scheduler interval is 100 milliseconds. Jobman applies symmetric jitter from 90 to 110 percent of that interval so a group of supervisors accepted together does not continue waking and contending in lockstep. Wait conditions may specify a longer poll interval, and backoff polling is bounded by the recorded eligibility time.

Polling trades some database reads and bounded scheduling latency for a much simpler failure model:

- there is no resident process whose in-memory queue must be reconstructed;
- a missed notification cannot strand a job indefinitely;
- supervisors can recover stale owners and admissions while doing ordinary work; and
- every decision can be inspected from persisted state.

The tradeoff is appropriate for Jobman's intended scale: local jobs owned by one user on one host. A cluster scheduler with thousands of workers, remote placement, or sub-millisecond dispatch requirements would need a different architecture.

## What the datastore coordinates

For the four analysis shards, SQLite ultimately coordinates more than a numeric limit:

| Durable fact                    | What it prevents                                  |
| ------------------------------- | ------------------------------------------------- |
| Dependency revision and outcome | Reinterpreting an already observed prerequisite   |
| Prerequisites-satisfied time    | Losing initial eligibility order                  |
| Admission request and bypasses  | Restarting the queue or starving a large request  |
| Active slot allocation          | Exceeding global or named-pool capacity           |
| Admission and supervisor leases | Silently abandoning ownership                     |
| Retry deadline and run counts   | Reconstructing policy from process memory or logs |

The supervisors remain independent processes, but their decisions are serialized where they must be. No supervisor decides that another job should run; each attempts its own transition against the same durable constraints.

That is what makes scheduling possible without a central scheduler: eligibility is observable, capacity is transactional, fairness is persisted, and failure does not erase queue state.

The next part will cross the operating-system boundary: how Jobman creates and controls a target process tree, drains its output without deadlocking, and records a trustworthy result when process execution or log capture fails.

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
