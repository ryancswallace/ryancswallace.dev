---
author: Ryan Wallace
pubDatetime: 2026-08-01T18:52:00Z
modDatetime: 2026-08-01T18:52:00Z
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

[Part 3](/posts/inside-jobman-part-3/) left an analysis shard with a concurrency admission. A run can now be started. The remaining work sits at the operating-system boundary, where a process may create descendants, fill two output pipes at once, ignore a polite request to stop, or exit between inspection and a database commit.

Suppose the admitted shard creates four worker processes. Progress is written to stdout, diagnostics are written to stderr, and a stuck worker must not survive the timeout:

```console
$ shard_id=$(jobman run --after-success "$prepare_id" \
    --pool analysis --slots 1 \
    --run-timeout 15m --stop-grace 5s \
    --log-segment-bytes 16MiB --log-segments 8 \
    -- python analyze_data.py --shard 3 --workers 4)
```

Three facts will eventually need to be stored: which process tree may be controlled, how the target ended, and how much of its output was captured. They can disagree. A successful exit does not certify the logs, and a full log does not turn a failed command into a success. A PID, by itself, proves neither identity nor ownership.

## A run record is created before a process

After admission, a run ID and run number are allocated. A private log directory is created with stdout and stderr files, a chunk-order index, and an active-capture marker. The run is then committed in `starting`, and the existing admission is bound to it.

Only after those records exist is the target created.

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

This ordering leaves somewhere to record a failed `Start`. Executable resolution may fail, permissions may be wrong, or the operating system may reject the launch. In those cases, a `start_failed` run is committed instead of leaving a missing attempt in the job history. Retry policy may allow another attempt.

Everything after `--` remains an executable plus an argument vector. Resolution is performed against the stored working directory and environment; no shell command is assembled behind the scenes. Stdin is attached according to policy, and stdout and stderr are given separate pipes.

An uncomfortable interval still remains. The process exists before its identity can be committed. During that interval, the platform-specific tree boundary is established and the process is inspected. The run is moved from `starting` to `running` only after that setup succeeds.

If the tree cannot be made manageable, it is terminated and reaped. If a verified identity cannot be published safely, the tree is terminated and ownership is recorded as lost. A live process is not left behind under a run that only appears to be controlled.

## A remembered PID is too weak

The analysis parent may create four workers, which may create descendants of their own. Terminating only the parent can leave the workers running after Jobman has reported a cancellation or timeout.

A separately addressable tree is therefore created for every run:

| Platform | Target boundary         | Identity evidence                                | Tree-wide control                                                            |
| -------- | ----------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Linux    | Dedicated process group | PID, `/proc` start ticks, kernel boot ID         | `SIGTERM`, `SIGKILL`, `SIGSTOP`, and `SIGCONT` to the group                  |
| macOS    | Dedicated process group | PID, kernel process start time, kernel boot time | The same group signals, with explicit handling for exiting processes         |
| Windows  | Named Job Object        | PID, process-creation time, system boot time     | Best-effort console break, Job Object termination, and per-member suspension |

On Linux and macOS, the target becomes the leader of a new process group. Descendants normally stay in that group, so a signal sent to the negative group ID reaches the group rather than only its leader.

The Windows setup has more moving parts. The target is created suspended, assigned to a named Job Object, and then resumed. A Job Object handle is duplicated into the target so the object remains alive after the supervisor closes its setup handle. Descendants inherit membership, and another Jobman process can later reopen the named object.

The same operations are exposed on all three platforms—cancel, force, pause, and resume—but their implementations are intentionally different.

Before any of those operations, the process is inspected again. Creation and boot identity are compared in addition to the PID. If the stored identity no longer matches, control is refused. PIDs are reused routinely; an old Jobman record must never authorize a signal to whichever unrelated process received that number next.

## A stop request is written down before it is sent

When `jobman cancel` is used on the shard, cancellation intent is first committed to SQLite. The canceling client may then signal the revalidated tree immediately. The supervisor sees the same durable request, remains responsible for reaping the target, and commits the final run state.

The ordering is useful during a badly timed crash. If the client disappears after the commit but before the signal, the supervisor still sees the request. If the signal is delivered and the client disappears afterward, the reason for the signal has already been recorded.

Timeouts use the same lifecycle path. Two budgets are supported. A run timeout covers one invocation and may produce a retryable result. A whole-job timeout includes time spent waiting for dependencies, capacity, and retry delays, and ends the job. Paused time is deducted from both budgets; suspension should not consume execution time promised by the configured timeout.

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

On Unix, `SIGTERM` is sent to the process group and `SIGKILL` is used after the grace period when forced termination is enabled. On Windows, `CTRL_BREAK_EVENT` is attempted for the graceful step. That signal is best effort because the detached supervisor may not share the target's console. Job Object termination supplies the reliable forced stop.

The recorded outcome describes why Jobman stopped the run. Exit metadata separately describes what the operating system reported. Forced Job Object termination may be observed as exit code 1, for example, while the durable run outcome remains `timed_out` or `cancelled` and the platform reason is retained.

## Both pipes must keep moving

The parent and its workers can write to stdout and stderr concurrently. Each operating-system pipe has a finite buffer. A straightforward loop that reads stdout to EOF and then starts on stderr can deadlock: a worker fills stderr, blocks before closing it, and the stdout reader waits forever for the process to finish.

One drain goroutine is started for each stream:

```go
go drainPipe(stdout, capture, logstore.Stdout)
go drainPipe(stderr, capture, logstore.Stderr)

go func() {
    captureGroup.Wait()
    completion <- command.Wait()
}()
```

The unusual-looking order in the last goroutine is deliberate. Both readers are allowed to finish before `Wait` is called. If `Wait` closes an `os/exec` pipe while a reader is still consuming its final bytes, those bytes can be lost and capture may be reported as degraded even though the target exited normally.

A stream is still drained when its capture has been disabled; the bytes are copied to `io.Discard`. The same fallback is used after a log write fails. Storage trouble is allowed to degrade the record, but it is not allowed to stop pipe consumption and freeze the target.

## Raw bytes are kept separate

Stdout and stderr are stored in separate raw files. No UTF-8, line-ending, or newline assumption is made. Each stream remains independently readable even when the metadata used to combine them has been damaged.

Those two files cannot show how the streams were interleaved. A fixed-size chunk index is written alongside them. Each 52-byte record contains:

| Field                       | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| Version and stream          | Identify the index format and stdout or stderr        |
| Segment, offset, and length | Locate the raw bytes without copying them into SQLite |
| Global sequence number      | Preserve Jobman's observed append order               |
| Timestamp                   | Record when the supervisor observed the chunk         |
| CRC-32C                     | Detect a corrupt complete record                      |

Only the order observed by Jobman is promised. If two workers write to different pipes at nearly the same time, the operating system exposes no portable causal ordering between them. Whichever chunk is appended first receives the next sequence number under a mutex.

## The raw write is synced before its index entry

For each chunk, the raw bytes are written and synced before the corresponding index record is written and synced. The ordering is intentionally one-way: every valid index entry must refer to bytes that were already made durable.

A crash between those two syncs leaves a less tidy case. Raw bytes may exist without an index entry. They are still available when stdout or stderr is read separately, but their position relative to the other stream cannot be recovered. Combined output omits that unindexed tail and reports the condition rather than inventing an order.

Different treatment is given to different index failures. An incomplete final record is accepted as a torn crash tail and ignored. A complete record with a bad checksum, a sequence gap, or a byte range outside the raw file is reported as corruption. The complete index snapshot is validated before combined output is copied to the caller.

This makes partial durability visible without turning every interrupted append into total log loss.

## A segment limit preserves the prefix

When `--log-segment-bytes` is set, stdout and stderr rotate independently. Version 2 of the index includes a segment number for each stream while retaining one sequence across both.

No old segment is deleted to make space during capture. Once the configured segment count has been reached, recording becomes degraded and previously written segments are left intact. Pipe draining continues so the target can exit.

The result is an honest prefix. Replacing early segments with a later window would either require index history to be rewritten or make a suffix look like the complete stream.

An `.active` marker is present while capture remains open. Retention cleanup uses it to avoid treating an in-progress directory as completed. Filesystem identity and containment are checked again before eligible logs are pruned, and the removal is reflected in metadata rather than appearing later as unexplained missing files.

## Exit status and capture health may disagree

After both drains finish, `Wait` is called, the files are closed and synced, authoritative byte counts are measured, and the result is committed. Several dimensions are stored separately:

| Fact             | Examples                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| Run outcome      | `success`, `failure`, `timed_out`, `cancelled`, `start_failed`, `lost` |
| Exit observation | Exit code, signal, or platform-specific reason                         |
| Log integrity    | `pending`, `valid`, or `partial`                                       |
| Recording health | `healthy` or `degraded`, with a bounded diagnostic code                |

Suppose `analyze_data.py` exits zero just as the disk fills during stderr capture. The run can be stored as `success` while log integrity is `partial` and recording health is degraded. The reverse is also possible: pristine logs do not alter a nonzero, non-retryable exit.

Automation can choose which fact it requires. Process success may be sufficient for one workflow, while another may reject a result unless complete logs were retained. Degraded capture can be alerted on without rewriting the target's actual outcome.

The separation also keeps crash recovery honest. If the supervisor vanishes while capture is pending, the logs can be marked partial and the run can be marked lost. No result is inferred from the final log line, and a normal exit code is never used as proof that all output reached storage.

## Where the boundary stops

For one analysis shard, a surprising amount of machinery sits between admission and completion. A run is reserved, a tree identity is established, stop intent is persisted, two streams are drained, and process and capture results are committed independently.

Some behavior remains outside Jobman's control. A child can deliberately escape its process group, a graceful handler can perform external work before exiting, and ending the operating-system user session can terminate the supervisor. Those limits follow from the local, per-user model described in Part 1.

Inside that boundary, a stale PID is never treated as authority. Graceful and forced stops are directed at the managed tree. Index records are published only after their raw bytes, and log damage is not folded into the command's exit result.

Those rules finish the path started with submission: ownership was transferred in Part 2, capacity was assigned in Part 3, and the final run record now states only what could actually be observed.

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
