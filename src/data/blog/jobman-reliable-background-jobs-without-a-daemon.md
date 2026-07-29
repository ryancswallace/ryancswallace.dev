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

**[Jobman](https://github.com/ryancswallace/jobman)** is a daemonless job manager for local background processes. I wrote it for work that has outgrown `nohup` and ad hoc shell scripts but does not justify a full-fledged service or distributed scheduler.

Jobman provides:

| Concern            | Jobman's approach                                       |
| ------------------ | ------------------------------------------------------- |
| Detached execution | One short-lived supervisor per job                      |
| Durable state      | Transactional metadata in SQLite                        |
| Output             | Separate stdout and stderr files with an ordering index |
| Reliability        | Retries, backoff, delays, and timeouts                  |
| Coordination       | Inter-job dependencies and concurrency limits           |
| Lifecycle control  | Status, wait, pause, resume, cancel, and rerun          |
| Automation         | Versioned JSON and stable exit behavior                 |

There is no shared Jobman daemon. Completed jobs leave no supervisor or other processes running.

<figure>
  <video controls muted playsinline autoplay loop preload="metadata">
    <source src="/videos/jobman-basic-cli.webm" type="video/webm" />
    <a href="/videos/jobman-basic-cli.gif">View the GIF version</a>
  </video>
  <figcaption>Basic Jobman command line behavior.</figcaption>
</figure>

## A small pipeline

Consider a two-step workflow:

<div class="mermaid">
flowchart LR
    A["Prepare input"] -->|"success"| B["Analyze input"]
    B -->|"exit 1"| C{"Retries left?"}
    C -->|"yes"| B
    C -->|"no"| D["Fail job"]
    B -->|"exit 0"| E["Complete"]
</div>

The requirements are relatively simple:

- preparation and analysis should run in the background;
- analysis must not start unless preparation succeeds;
- a transient analysis failure should be retried;
- each attempt's output and result should remain inspectable.

Start with disposable state and working directories:

Submit the preparation step:

```console
$ prepare_id=$(jobman run -- python prepare_data.py)
```

`jobman run` returns the job's canonical ID immediately after a detached supervisor has claimed it. The target then continues independently of the submitting terminal.

Submit the analysis dependent on the data preparation job:

```console
$ analyze_id=$(jobman run --after-success "$prepare_id" \
    --retries 2 --retryable-exit-code 1 --retry-delay 1s \
    -- python analyze_data.py)
```

This specification records three job policy decisions:

| Option                          | Meaning                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `--after-success "$prepare_id"` | Start only after preparation job succeeds               |
| `--retryable-exit-code 1`       | Treat exit status 1 as transient                        |
| `--retries 2 --retry-delay 1s`  | Permit two additional attempts, separated by one second |

The policy is stored before the background supervisor begins evaluating it. A later CLI invocation does not have to reconstruct the pipeline from shell history.

## Inspecting the job

Jobman lets you inspect running or completed jobs:

```console
$ jobman status "$prepare_id"
$ jobman status "$analyze_id"
```

Wait for analysis to reach a completed state:

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

Detaching a process is straightforward, but managing it after detachment presents technical challenges.

Once the submitting CLI exits, some component must still:

- evaluate dependencies and retry policy;
- acquire concurrency capacity;
- start and reap target processes;
- capture stdout and stderr;
- enforce timeout and cancellation policy;
- commit lifecycle transitions;
- deliver configured notifications.

Jobman assigns that responsibility to a per-job supervisor:

<div class="mermaid">
sequenceDiagram
    participant CLI as Submitting CLI
    participant DB as Local datastore
    participant S as Per-job supervisor
    participant T as Target process
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

The supervisor is another invocation of the Jobman executable in a private mode. It owns one job and terminates after the job and its completion work finish.

This model avoids several properties of a global daemon:

- a shared long-running failure domain;
- privileged system integration;
- daemon installation and upgrade coordination;
- version skew between clients and a long-running service.

That said, this model does _not_ eliminate all need for coordination. Supervisors and CLI commands still contend over shared state (in the datastore), so lifecycle changes use transactions and revision checks.

## Storage follows the data

Jobman uses two storage mechanisms because metadata storage and log storage are substantially different workloads with differing requirements.

<div class="mermaid">
flowchart TB
    J["Jobman commands and supervisors"] --> DB["SQLite metadata (datastore)"]
    J --> FS["Private log files"]
    DB --> M["Jobs, runs, events, leases, policy"]
    FS --> O["stdout"]
    FS --> E["stderr"]
    FS --> I["Chunk ordering index"]
</div>

SQLite is a good fit for:

- atomic lifecycle transitions;
- concurrent readers and writers;
- schema migration;
- querying job history.

Raw files are a better fit for potentially large byte streams. By using raw files instead of SQLite for log data, Jobman doesn't need to turn arbitrary process output into database rows.

The split also lets Jobman record two distinct facts:

1. what happened to the target process;
2. whether its output was recorded completely.

A logging failure does not rewrite a successful process exit as a failed execution. The target outcome and recording integrity are related but treated distinctly.

## Direct execution is the default

Everything after `--` is an executable and its argument vector. Jobman does not implicitly pass the command through a shell.

For a normal executable:

```console
$ jobman run -- tar -xzf report.tar.gz
```

Shell evaluation must be explicit:

```console
$ jobman run -- sh -c 'generate | compress > report.tar.gz'
```

This preserves argument boundaries by default. It also avoids making quoting rules and command injection part of every Jobman invocation.

## Product boundary

Jobman is intentionally designed as a single-host (i.e., local) solution.

| Jobman handles                         | Jobman does _not_ handle            |
| -------------------------------------- | ----------------------------------- |
| Per-user jobs on one machine           | Distributed scheduling              |
| Local dependency evaluation            | Placement across hosts              |
| Process-tree lifecycle control         | Cluster resource discovery          |
| Named concurrency pools                | Preemption or fair-share scheduling |
| Durable local logs and state           | Remote log aggregation              |
| Operation over an existing SSH session | A remote-control service            |

A job _can_ survive the terminal or SSH connection that submitted it, it _may not_ survive the end of the operating system user session, and it _will not_ survive a system shutdown or reboot. Jobman does not purport to be a machine-level service manager.

This boundary keeps the tool useful without introducing all the complexities of a distributed system.

## Topics in detail

The command line API is the least complicated part of Jobman--the more interesting work is in the underlying technology:

- safely transferring ownership to a detached supervisor;
- making lifecycle transitions explicit and transactional;
- preserving state across crashes;
- managing process trees on Linux, macOS, and Windows;
- recording ordered output without placing bulk logs in SQLite.

These are topics I'll cover in other articles in the [series on Jobman](https://ryancswallace.dev/tags/jobman/).

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
