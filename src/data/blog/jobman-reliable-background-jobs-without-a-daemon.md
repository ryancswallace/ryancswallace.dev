---
author: Ryan Wallace
pubDatetime: 2026-07-23T13:42:00Z
modDatetime: 2026-07-23T13:42:00Z
title: "Jobman: Reliable Background Jobs Without a Daemon"
slug: jobman-reliable-background-jobs-without-a-daemon
featured: false
draft: false
tags:
  - jobman
  - go
  - systems-programming
  - cli
description: A technical introduction to Jobman's architecture through a real workflow with dependencies, retries, durable state, and logs.
---

# Jobman: Reliable Background Jobs Without a Daemon

Jobman is a daemonless job manager for local background processes. I wrote it for work that has outgrown `nohup` and ad hoc shell scripts but does not justify a service or distributed scheduler.

It provides:

| Concern            | Jobman's approach                                       |
| ------------------ | ------------------------------------------------------- |
| Detached execution | One short-lived supervisor per job                      |
| Durable state      | Transactional metadata in SQLite                        |
| Output             | Separate stdout and stderr files with an ordering index |
| Reliability        | Retries, backoff, delays, and timeouts                  |
| Coordination       | Dependencies and local concurrency limits               |
| Lifecycle control  | Status, wait, pause, resume, cancel, and rerun          |
| Automation         | Versioned JSON and stable exit behavior                 |

There is no shared Jobman daemon. Completed jobs leave no supervisor running.

## A small pipeline

Consider a two-step local workflow:

<div class="mermaid">
flowchart LR
    A["Prepare input"] -->|"success"| B["Analyze input"]
    B -->|"exit 1"| C{"Retries left?"}
    C -->|"yes"| B
    C -->|"no"| D["Fail job"]
    B -->|"exit 0"| E["Complete"]
</div>

The requirements are modest:

- preparation and analysis should run in the background;
- analysis must not start unless preparation succeeds;
- a transient analysis failure should be retried;
- each attempt's output and result should remain inspectable.

Start with disposable state and working directories:

```console
$ export JOBMAN_STATE_DIR="$(mktemp -d)"
$ work_dir="$(mktemp -d)"
```

Submit the preparation step:

```console
$ prepare_id=$(jobman run --name prepare -- \
    sh -c 'sleep 2; printf "21\n" > "$1/input.txt"' \
    sh "$work_dir")
```

`jobman run` returns the job's canonical ID after a detached supervisor has claimed it. The target then continues independently of the submitting terminal.

Submit the dependent analysis:

```console
$ analyze_id=$(jobman run --name analyze \
    --after-success "$prepare_id" \
    --retries 2 \
    --retryable-exit-code 1 \
    --retry-delay 1s \
    -- \
    sh -c '
        attempt_file="$1/attempt"
        attempt=$(cat "$attempt_file" 2>/dev/null || printf 0)
        attempt=$((attempt + 1))
        printf "%s\n" "$attempt" > "$attempt_file"

        if [ "$attempt" -eq 1 ]; then
            printf "temporary analysis failure\n" >&2
            exit 1
        fi

        value=$(cat "$1/input.txt")
        printf "result: %s\n" "$((value * 2))"
    ' sh "$work_dir")
```

This specification records three policy decisions:

| Option                          | Meaning                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `--after-success "$prepare_id"` | Start only after preparation succeeds                   |
| `--retryable-exit-code 1`       | Treat exit status 1 as transient                        |
| `--retries 2 --retry-delay 1s`  | Permit two additional attempts, separated by one second |

The policy is stored before the background supervisor begins evaluating it. A later CLI invocation does not have to reconstruct the pipeline from shell history.

## Inspecting the job

While the pipeline is running:

```console
$ jobman status "$prepare_id"
$ jobman status "$analyze_id"
```

Wait for analysis to reach a terminal state:

```console
$ jobman wait "$analyze_id"
```

`wait` is an observer, not an owner. Interrupting it does not cancel the job.

The complete run history is still available afterward:

```console
$ jobman show "$analyze_id"
```

The two output streams retain their identities:

```console
$ jobman logs --stream stderr "$analyze_id"
temporary analysis failure

$ jobman logs --stream stdout "$analyze_id"
result: 42
```

For scripts, Jobman provides versioned JSON:

```console
$ jobman show --json "$analyze_id"
```

Automation should retain the full job ID and consume JSON rather than parsing the human-readable tables.

## The ownership problem

Detaching a process is straightforward. Managing it after detachment is the real problem.

Once the submitting CLI exits, some component must still:

- evaluate dependencies and retry policy;
- acquire concurrency capacity;
- start and reap target processes;
- capture stdout and stderr;
- enforce timeout and cancellation policy;
- commit lifecycle transitions;
- deliver configured notifications.

Jobman assigns that responsibility to one supervisor per job:

<div class="mermaid">
sequenceDiagram
    participant CLI as "Submitting CLI"
    participant DB as "Local store"
    participant S as "Per-job supervisor"
    participant T as "Target process"

    CLI->>DB: Create submitting job
    CLI->>S: Launch with one-time credential
    S->>DB: Atomically claim job
    S-->>CLI: Acknowledge durable claim
    CLI-->>CLI: Print job ID and exit
    S->>T: Start target
    T-->>S: Output and exit status
    S->>DB: Commit run and job results
    S-->>S: Exit

</div>

The supervisor is another invocation of the Jobman executable in a private mode. It owns one job and terminates after the job and its bounded completion work finish.

This avoids several properties of a global daemon:

- a shared long-running failure domain;
- daemon installation and upgrade coordination;
- a global control listener;
- privileged system integration;
- version skew between clients and a resident service.

It does not eliminate coordination. Supervisors and CLI commands still contend over shared state, so lifecycle changes use transactions and revision checks.

## Storage follows the data

Jobman uses two storage mechanisms because metadata and logs have different workloads.

<div class="mermaid">
flowchart TB
    J["Jobman commands and supervisors"] --> DB["SQLite metadata"]
    J --> FS["Private log files"]

    DB --> M["Jobs, runs, events, leases, policy"]
    FS --> O["stdout"]
    FS --> E["stderr"]
    FS --> I["Chunk ordering index"]

</div>

SQLite is a good fit for:

- atomic lifecycle transitions;
- concurrent readers and writers;
- referential constraints;
- schema migration;
- querying job history.

Raw files are a better fit for potentially large byte streams. Jobman does not need to turn arbitrary process output into database rows or reconstruct it from a text representation.

The split also lets Jobman record two distinct facts:

1. what happened to the target process;
2. whether its output was recorded completely.

A logging failure must not rewrite a successful process exit as a failed execution. The target outcome and recording integrity are related, but they are not the same result.

## Direct execution is the default

Everything after `--` is an executable and its argument vector. Jobman does not implicitly pass the command through a shell.

For a normal executable:

```console
$ jobman run --name checksum -- sha256sum artifact.tar
```

Shell evaluation must be explicit:

```console
$ jobman run --name report -- sh -c 'generate | compress > report.gz'
```

This preserves argument boundaries by default. It also avoids making quoting rules and command injection part of every Jobman invocation.

## Product boundary

Jobman is intentionally local.

| Jobman handles                         | Jobman does not handle              |
| -------------------------------------- | ----------------------------------- |
| Per-user jobs on one machine           | Distributed scheduling              |
| Local dependency evaluation            | Placement across hosts              |
| Process-tree lifecycle control         | Cluster resource discovery          |
| Named concurrency pools                | Preemption or fair-share scheduling |
| Durable local logs and state           | Remote log aggregation              |
| Operation over an existing SSH session | A remote-control service            |

A job can survive the terminal or SSH connection that submitted it. It may not survive the end of the operating-system user session, and Jobman does not present itself as a machine-level service manager.

That boundary keeps the tool useful without hiding a distributed system behind a local CLI.

## Where this leads

The command-line surface is the least complicated part of Jobman. The more interesting work sits underneath it:

- safely transferring ownership to a detached supervisor;
- making lifecycle transitions explicit and transactional;
- preserving honest state across crashes;
- managing process trees on Linux, macOS, and Windows;
- recording ordered output without placing bulk logs in SQLite;
- testing failures at the boundary between durable intent and external effects.

Those are the topics I'll cover in the rest of this series.

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
