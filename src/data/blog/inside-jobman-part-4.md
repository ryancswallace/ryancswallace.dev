---
author: Ryan Wallace
pubDatetime: 2026-08-06T18:52:00Z
modDatetime: 2026-08-06T18:52:00Z
title: "Inside Jobman, Part 4: Process Trees, Timeouts, and Durable Logs"
slug: inside-jobman-part-4
featured: false
draft: false
tags:
  - jobman
  - go
  - systems-programming
  - cli
description: How Jobman controls process trees across platforms, enforces cancellation and timeouts, and records output without confusing log integrity with process outcome.
---

<!-- markdownlint-disable MD014 -->
<!-- cspell:words SIGCONT SIGSTOP goroutines logstore revalidatable unindexed -->

> **Inside Jobman:**
> [Part 1: Architecture](/posts/inside-jobman-part-1/) ·
> [Part 2: Ownership transfer](/posts/inside-jobman-part-2/) ·
> [Part 3: Scheduling](/posts/inside-jobman-part-3/) ·
> **Part 4: Process control and logs**

[Part 3](/posts/inside-jobman-part-3/) ended when an analysis shard acquired concurrency capacity. The supervisor may now start a run, but it still has to cross a difficult boundary: an operating-system process can spawn descendants, ignore graceful termination, write to two streams concurrently, and disappear between observation and persistence.

Suppose one shard uses four worker processes. The parent reports progress on stdout, workers report diagnostics on stderr, and a stuck worker should not survive a timeout:

```console
$ shard_id=$(jobman run --after-success "$prepare_id" \
    --pool analysis --slots 1 \
    --run-timeout 15m --stop-grace 5s \
    --log-segment-bytes 16MiB --log-segments 8 \
    -- python analyze_data.py --shard 3 --workers 4)
```

Managing this run requires Jobman to preserve three different facts:

1. which process tree it started and is allowed to control;
2. how the target actually terminated; and
3. whether its output was recorded completely.

Those facts are related, but they are not interchangeable. A successful exit does not prove that every log byte reached storage. A logging failure does not change the target's exit code. A stale PID is not permission to signal whatever process now has that number.

## Reserve the run before starting it

After admission, the supervisor allocates a run ID and number. Before creating the target process, it creates a private log directory containing stdout, stderr, a chunk-order index, and an active-capture marker. It then commits a `starting` run with those paths and binds the concurrency admission to that run.

<div class="mermaid">
sequenceDiagram
    participant S as Supervisor
    participant DB as SQLite datastore
    participant L as Log store
    participant T as Target tree
    S->>L: Create private run files and active marker
    S->>DB: Reserve run and bind admission
    S->>T: Start direct executable in a tree boundary
    S->>T: Inspect process and finalize tree identity
    S->>DB: Commit running phase and process identity
    par Capture stdout
        T-->>L: Raw stdout chunks
    and Capture stderr
        T-->>L: Raw stderr chunks
    and Observe lifecycle
        S->>DB: Check cancellation, pause, and timeouts
    end
    T-->>S: Exit observation
    S->>L: Flush and close capture
    S->>DB: Commit exit, outcome, and log integrity
</div>

Durable reservation gives a failed start somewhere to go. If executable resolution or `Start` fails, Jobman records a `start_failed` run rather than leaving an unexplained gap in job history. Start failures may be retryable when policy allows.

Everything after `--` remains an executable and argument vector. Jobman resolves it against the stored working directory and environment without joining arguments into a shell command. It then attaches stdin according to policy and creates separate stdout and stderr pipes.

There is an unavoidable interval between the operating system creating a process and Jobman committing its identity. Jobman keeps this interval small. It establishes the platform tree boundary, inspects the new process, and only then moves the run from `starting` to `running`. If identity setup fails, it terminates and reaps the target instead of publishing an unmanageable process as active. If the process starts but its identity cannot be committed safely, Jobman terminates the tree and records ownership as lost rather than pretending the start was clean.

## Control a tree, not a PID

The analysis parent can create four workers, and those workers can create children of their own. Signaling only the parent could leave descendants running after the job is reported as canceled or timed out.

Jobman creates a separately addressable target tree using the strongest suitable primitive on each platform:

| Platform | Target boundary         | Identity evidence                                | Tree-wide control                                                            |
| -------- | ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Linux    | Dedicated process group | PID, `/proc` start ticks, kernel boot ID         | `SIGTERM`, `SIGKILL`, `SIGSTOP`, and `SIGCONT` to the group                  |
| macOS    | Dedicated process group | PID, kernel process start time, kernel boot time | The same group signals, with explicit handling for exiting processes         |
| Windows  | Named Job Object        | PID, process-creation time, system boot time     | Best-effort console break, Job Object termination, and per-member suspension |

On Linux and macOS, the target starts as the leader of a new process group. Descendants normally remain in that group, so signaling the negative group ID reaches the tree rather than only the leader.

Windows requires a different sequence. The target starts suspended, is assigned to a named Job Object, and is then resumed. A handle is duplicated into the target so the Job Object remains available after the supervisor closes its setup handle. Descendants inherit membership, and later Jobman invocations can reopen the named object for tree-wide control.

The user-visible contract is the same even though the mechanisms are not: cancellation, forced termination, pause, and resume apply to the managed tree.

Before any control operation, Jobman re-inspects the process. The persisted identity includes creation and boot information in addition to the PID. If the current process does not match, the operation fails with an identity mismatch. PID reuse must never cause Jobman to terminate an unrelated process.

## Intent before signal

Cancellation and timeouts are durable lifecycle transitions before they are operating-system effects. If `jobman cancel` targets the shard, Jobman first records cancellation intent. The canceling client may then signal the revalidated tree immediately; the supervisor also observes the durable intent and remains responsible for reaping the target and finalizing the run.

Timeouts use the same ordering. Jobman distinguishes two budgets:

- a **run timeout** covers one invocation and may be classified as retryable;
- a **whole-job timeout** covers dependencies, capacity waits, retry delays, and runs, and is terminal.

Time spent paused is subtracted from both budgets. A pause is not an application checkpoint, but it should not consume the time Jobman promised the target.

<div class="mermaid">
flowchart LR
    A["Cancellation or timeout observed"] --> B["Commit durable stop intent"]
    B --> C["Revalidate process identity"]
    C --> D["Request graceful tree stop"]
    D --> E{"Exited within grace period?"}
    E -->|"yes"| F["Reap and record result"]
    E -->|"no"| G{"Forced termination enabled?"}
    G -->|"yes"| H["Force tree termination"]
    H --> F
    G -->|"no"| I["Report control failure"]
</div>

The graceful request is `SIGTERM` to the process group on Unix. On Windows, `CTRL_BREAK_EVENT` is best effort because a detached supervisor may not share the target's console. After the configured grace period, forced Job Object termination provides the reliable Windows tree-wide stop; Unix uses `SIGKILL`.

The durable outcome records why Jobman stopped the run, while exit metadata records what the operating system reported. This distinction matters on Windows, where forced Job Object termination may appear as exit code 1. Jobman stores the run as `timed_out` or `cancelled` and preserves the lower-level observation as a platform reason rather than misclassifying it as an ordinary command failure.

## Drain both pipes before waiting

The parent and its workers may write to stdout and stderr at the same time. Operating-system pipes have finite buffers. If the supervisor reads one stream to completion before touching the other, a worker can fill the neglected pipe and block the entire tree.

Jobman starts one drain goroutine per stream:

```go
go drainPipe(stdout, capture, logstore.Stdout)
go drainPipe(stderr, capture, logstore.Stderr)

go func() {
    captureGroup.Wait()
    completion <- command.Wait()
}()
```

The excerpt omits bookkeeping, but the order is significant. Both pipes are drained concurrently, and `Wait` is called only after their readers finish. Calling `Wait` first can let `os/exec` close a pipe under a reader, losing final bytes and falsely reporting degraded capture.

Even when capture is disabled for a stream, Jobman drains it to `io.Discard`. The target must never block merely because its output is not being retained. If a log write fails, Jobman likewise switches to draining the remaining pipe data to a discard path so the storage failure does not deadlock the process it is observing.

## Raw streams plus an ordering index

Jobman stores stdout and stderr as separate raw files. They are byte-preserving and make no assumptions about UTF-8, line endings, or whether a write ends with a newline. Either stream can be read independently even if the combined ordering metadata is damaged.

Separate files do not say how writes from the two streams were interleaved. For combined output, Jobman adds a fixed-size chunk index. Each 52-byte record contains:

| Field                       | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| Version and stream          | Identify the index format and stdout or stderr        |
| Segment, offset, and length | Locate the raw bytes without copying them into SQLite |
| Global sequence number      | Preserve Jobman's observed append order               |
| Timestamp                   | Record when the supervisor observed the chunk         |
| CRC-32C                     | Detect a corrupt complete record                      |

The index records observed order, not a stronger causal order inside the target. Two worker writes racing on separate pipes have no portable total order until the supervisor reads them. A mutex serializes those observed appends and assigns contiguous sequence numbers.

For every chunk, Jobman writes and syncs the raw bytes first, then writes and syncs the index record. That ordering creates an important one-way guarantee:

> A valid index record never refers to raw bytes that were not already written.

A crash between the two syncs can leave raw bytes without an index entry. Those bytes remain authoritative in the individual stream, but their position relative to the other stream is unknown. Combined output therefore omits the unindexed tail and reports it explicitly instead of guessing an order.

A partial final index record is treated as a torn tail and ignored. Corruption in a complete record, a sequence gap, a bad checksum, or an index range beyond the raw file is an error. Readers validate the complete index snapshot before copying combined output.

## Rotation preserves history

With `--log-segment-bytes`, stdout and stderr rotate independently. Version 2 of the index adds a per-stream segment number, while keeping one global chunk sequence across both streams.

Rotation never deletes an earlier segment to make room. If a configured segment-count limit is reached, capture becomes degraded and everything already recorded remains intact. The supervisor continues draining the target's pipes so the process can finish.

This favors an honest prefix over a misleading window. Deleting old segments during capture would require rewriting index history or presenting a suffix as though it were complete.

An `.active` marker prevents retention cleanup from treating an open capture as completed. Later cleanup requires durable eligibility, rechecks filesystem identity and containment, and records pruning in metadata rather than making missing files look like an unexplained loss.

## Process outcome and recording health

After the target exits, the supervisor finishes both drain goroutines, calls `Wait`, closes and syncs the log files, measures their authoritative sizes, and commits the run result.

The persisted record deliberately has separate dimensions:

| Fact             | Examples                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| Run outcome      | `success`, `failure`, `timed_out`, `cancelled`, `start_failed`, `lost` |
| Exit observation | Exit code, signal, or platform-specific reason                         |
| Log integrity    | `pending`, `valid`, or `partial`                                       |
| Recording health | `healthy` or `degraded`, with a bounded diagnostic code                |

If `analyze_data.py` exits successfully but the disk fills during stderr capture, the run may still be `success` with `partial` log integrity and degraded recording health. Conversely, complete logs do not turn a nonzero, non-retryable exit into success.

This separation is useful to both humans and automation. A caller can decide that process success is sufficient, require complete logs as an additional condition, or alert on degraded recording without rewriting the job's factual outcome.

It also narrows crash recovery. If a supervisor disappears while capture is pending, Jobman can mark the logs partial and the run lost. It does not infer the target's result from its last log line, and it does not infer complete recording from a normal exit code.

## A trustworthy local boundary

For the analysis shard, Jobman does more than start `python` and remember a PID. It reserves the run, establishes a process-tree boundary, publishes a revalidatable identity, records stop intent before signaling, drains both output streams, and commits process and log results without conflating them.

The implementation differs across operating systems, and it cannot make arbitrary application behavior transactional. A child can deliberately leave its managed boundary, a graceful handler can perform external work before exiting, and ending the operating-system user session can terminate the supervisor. Those are part of Jobman's local, per-user product boundary.

Within that boundary, the invariants are concrete:

- no process is controlled from a PID alone;
- cancellation and timeout intent precede their side effects;
- the managed tree receives graceful and, when configured, forced termination;
- stdout and stderr are drained independently;
- valid index entries never name unwritten bytes; and
- target outcome remains distinct from log integrity.

Together with durable ownership and transactional scheduling, those invariants complete the core design: every job has one owner, every run competes under shared limits, and every recorded result says what Jobman actually knows.

---

**Previous:** [Part 3: Scheduling Without a Central Scheduler](/posts/inside-jobman-part-3/)

[View every Jobman article](/tags/jobman/)

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
