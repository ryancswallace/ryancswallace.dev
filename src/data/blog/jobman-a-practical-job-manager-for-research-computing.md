---
author: Ryan Wallace
pubDatetime: 2026-07-25T10:04:00Z
modDatetime: 2026-07-25T10:04:00Z
title: "Jobman: A Practical Job Manager for Research Computing"
slug: jobman-a-practical-job-manager-for-research-computing
featured: true
draft: false
tags:
  - jobman
  - pipelines
  - cli
  - research
description: A practical guide to running reliable research pipelines with Jobman using dependencies, retries, timeouts, concurrency limits, durable logs, and notifications.
---

<!-- markdownlint-disable MD014 -->

<div
  class="not-prose mx-auto mb-8 flex max-w-xl justify-center rounded-xl bg-[#212737] px-6 py-5"
>
  <img
    class="h-auto w-full max-w-md !border-0"
    src="/images/jobman-logo-dark-transparent.svg"
    alt="Jobman"
  />
</div>

<div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-start">
  <div>
    <p class="mt-0">
      Empirical research often involves long-running work on a local workstation
      or remote server:
    </p>
    <ul class="mb-0">
      <li>cleaning data;</li>
      <li>fitting models or running simulations;</li>
      <li>producing tables and figures;</li>
      <li>repeating specifications across samples and outcomes.</li>
    </ul>
  </div>
  <aside class="not-prose rounded-lg border border-border bg-muted/40 p-4">
    <p class="mt-0 mb-3 text-sm font-semibold text-foreground">Project links</p>
    <nav aria-label="Jobman links">
      <ul class="m-0 list-none space-y-3 p-0">
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://github.com/ryancswallace/jobman"
          >
            ryancswallace/jobman
          </a>
          <span class="text-xs text-foreground/70">GitHub repository</span>
        </li>
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://jobman.tech/"
          >
            Documentation
          </a>
          <span class="text-xs break-words text-foreground/70">jobman.tech</span>
        </li>
      </ul>
    </nav>
  </aside>
</div>

Jobman keeps these tasks running after the terminal closes and adds dependencies, retries, timeouts, logs, concurrency limits, and notifications. It combines the benefits of `nohup` and terminal job control with the features of many heavier-weight schedulers.

## A example research pipeline

Consider a project with four stages:

<div class="mermaid">
flowchart LR
    A["Download data"] --> B["Clean data"]
    B --> C["Estimate models"]
    C --> D["Build tables"]
    C --> E["Build figures"]
</div>

Each stage should start only after its inputs are ready. A failure should stop dependent work rather than produce results from stale files.

Submit the download and cleaning jobs first:

```console
$ jobman run --name fetch -- python fetch.py
$ jobman run --name clean --after-success fetch -- Rscript clean.R
```

Submit the estimation job:

```console
$ jobman run --name model --after-success clean  -- stata -b do model
```

Once modeling succeeds, the tables and figures can run independently:

```console
$ jobman run --after-success model -- Rscript tables.R
$ jobman run --after-success model -- python figures.py
```

Jobman records the dependency graph when each job is submitted. You can close the terminal while the pipeline runs.

## Check progress

Use `list` for an overview of active jobs:

```console
$ jobman list --active
```

Use `status` for one job:

```console
$ jobman status model
```

Use `show` for the job specification and run history:

```console
$ jobman show model
```

| Subcommand   | Best use                       |
| ------------ | ------------------------------ |
| `list`       | Review several jobs            |
| `status JOB` | Check one current result       |
| `show JOB`   | Inspect policy and run history |
| `wait JOB`   | Block until completion         |
| `logs JOB`   | Read captured output           |

## Persist and review logs

Jobman captures stdout and stderr independently.

Show both streams for a job:

```console
$ jobman logs model
```

Follow a job as it runs:

```console
$ jobman logs --follow model
```

Inspect stderr only:

```console
$ jobman logs --stream stderr model
```

Read only the last 50 lines:

```console
$ jobman logs --lines 50 model
```

For a job with several attempts, include every run:

```console
$ jobman logs --all model
```

This is particularly useful for software that reports diagnostics like convergence warnings, dropped observations, or failed specifications on stderr.

Raw job output is recorded to disk and is _not_ automatically redacted. Avoid printing credentials or confidential data to logs.

## Retry transient failures

Downloads, APIs, database connections, and licensed software can fail temporarily. A configurable retry policy handles those failures without repeatedly running a job that cannot succeed.

```console
$ jobman run --name download \
    --retries 3 --retryable-exit-code 1 \
    --retry-delay 10s --retry-backoff exponential \
    -- python download.py
```

`--retries 3` permits four attempts in total: the initial run and three retries.

A script can use distinct exit codes to separate transient failures from invalid inputs. Only failures (i.e., exit codes) you classify as retryable trigger another attempt.

This allows you to customize the retry policy based on the type of failure encountered:

| Outcome                   | Suggested treatment  |
| ------------------------- | -------------------- |
| Temporary network failure | Retry                |
| Rate limit                | Retry with backoff   |
| Invalid program state     | Fail immediately     |
| Run timeout               | Retry only when safe |

## Limit execution time

Use a run timeout to stop one attempt:

```console
$ jobman run --run-timeout 2h -- python bootstrap.py
```

Use a job timeout to time-bound the entire lifecycle, including waiting and retries:

```console
$ jobman run --job-timeout 8h -- python bootstrap.py
```

The two limits can be combined:

```console
$ jobman run --run-timeout 2h --job-timeout 6h \
    --retry-timeouts --retries 2 -- python bootstrap.py
```

| Limit           | Covers                                                |
| --------------- | ----------------------------------------------------- |
| `--run-timeout` | One execution attempt                                 |
| `--job-timeout` | Dependencies, queueing, delays, attempts, and retries |

For example, timeouts can catch stalled optimizers, infinite loops, inaccessible network resources, and simulations stuck on pathological parameters.

## Limit concurrent work

Parallel jobs can exhaust memory or make every model slower. Jobman supports store-wide capacity and named pools.

For example, configure separate limits for downloads and models:

```yaml
concurrency:
  max_active_slots: 8
  pools:
    downloads: 2
    models: 4
```

Then assign work to a pool:

```console
$ jobman run --pool models -- python model_a.py
$ jobman run --pool models -- python model_b.py
```

A memory- or CPU-intensive job can request several slots:

```console
$ jobman run --pool models --slots 2 -- stata -b do simulation_a
```

Waiting jobs do not consume slots before their dependencies and wait conditions are satisfied.

Pools are useful for:

- preventing runs from exhausting RAM;
- limiting simultaneous database queries;
- restricting calls to rate-limited services;
- reserving capacity for different workload classes.

## Wait for conditions to start

The `--wait-*` flags instruct Jobman to wait for various conditions before starting the job.

A job can wait for a file to exist before starting:

```console
$ jobman run --wait-file data/raw/complete.flag -- python clean.py
```

It can also wait until a specified time:

```console
$ jobman run --wait-until 2026-08-01T02:00:00Z -- python import.py
```

Or start after a relative delay:

```console
$ jobman run --wait-delay 30m -- python refresh.py
```

Add an abort time when an input becomes useless after a deadline:

```console
$ jobman run --wait-file data/ready \
    --wait-abort-at 2026-08-01T12:00:00Z -- python estimate.py
```

## Organize related jobs

Attach groups and tags when submitting work:

```console
$ jobman run --group paper_a --tag baseline -- python model.py
```

Filter the job list by group:

```console
$ jobman list --group paper_a
```

Possible research-oriented groups include:

- `paper`;
- `policy`;
- `replication`;
- `simulation`;
- `data-refresh`.

Tags can also record characteristics such as `baseline`, `robustness`, or `clustered-se`.

Job names are labels, not unique identifiers. Reusing a name does not overwrite an earlier job.

## Control the working environment

Jobs inherit the submitting shell's environment by default, but `run` can override it.

Set the working directory:

```console
$ jobman run --cwd /work/project -- Rscript analysis.R
```

Set an environment value:

```console
$ jobman run --env SPEC=baseline -- python model.py
```

Remove an inherited environment variable:

```console
$ jobman run --unset-env DEBUG -- python model.py
```

Jobman executes the target directly. It does not interpret shell operators unless you explicitly run a shell:

```console
$ jobman run -- sh -c 'python model.py > summary.txt'
```

Prefer direct execution unless shell syntax is necessary.

## Repeat a specification

Rerun a prior job without reconstructing its options:

```console
$ jobman rerun models --name models-rerun
```

The new job copies the earlier specification but has its own ID and history.

For repeated sampling or simulations, define explicit completion limits:

```console
$ jobman run --max-runs 100 --success-target 100 -- python simulate_once.py
```

Jobman can also abort after a specified number of failed runs:

```console
$ jobman run --max-runs 110 --success-target 100 \
    --failure-limit 11 -- python simulate_once.py
```

This is useful when each execution produces one independent result that can be aggregated later.

## Control active work

Pause and resume are useful when interactive work temporarily needs the machine’s resources:

```console
$ jobman pause models
$ jobman resume models
```

Cancellation applies to the managed process tree, not only the initial process. Jobman first requests a graceful stop and can force termination after the configured grace period.

```console
$ jobman cancel models
```

Waiting on a job blocks until the job completes:

```console
$ jobman wait models
```

## Notifications

Jobman supports configured command callbacks, webhooks (HTTPS), and email (SMTP) notifications.

For example, if a notifier named `research` is configured, this invocation sends a message to that notification channel if the job fails:

```console
$ jobman run --notify research --notify-on job_failed -- python models.py
```

Useful events that Jobman can notify about include:

- job succeeded;
- job failed;
- job timed out;
- retry scheduled;
- run started or completed.

Notifications are especially useful for jobs running outside work hours and for remote sessions.

## Use stable output in scripts

Human-readable output is intended for terminals. Use JSON for automation:

```console
$ jobman status --json models
$ jobman show --json models
$ jobman list --json --group paper
```

This makes it easier to generate run manifests or record job outcomes alongside research artifacts.

For reproducibility, retain:

- the canonical job ID (displayed by `jobman run`);
- the source revision (e.g., commit hash);
- the input-data version (e.g., checksum);
- the software environment (e.g., `uv.lock`);
- the command or named job specification;
- relevant Jobman JSON output.

Jobman records execution history, but it does not replace source control, data versioning, or environment management.

## Keep state manageable

Preview history cleanup before deleting anything:

```console
$ jobman clean --older-than 30d
```

Apply the cleanup with `--force`:

```console
$ jobman clean --older-than 30d --force
```

The `clean` subcommand avoids removing active state or metadata still required by another job.

Check that the local Jobman metadata store is healthy:

```console
$ jobman doctor
```

Create a metadata backup before an upgrade or major cleanup:

```console
$ jobman doctor --backup jobman-backup.db
```

Do not delete files inside the Jobman state directory by hand.

## Where Jobman fits

Jobman is designed for single-user work on one machine.

| Good fit                           | Use another system/tool                   |
| ---------------------------------- | ----------------------------------------- |
| Workstation, server, cloud compute | Multi-node computation                    |
| Jobs submitted over SSH            | Cluster-wide scheduling                   |
| Local data pipelines               | Distributed data processing               |
| Parallel robustness checks         | Resource placement across hosts           |
| Overnight models and simulations   | Work requiring a permanent system service |

Note that Jobman jobs:

- _will_ survive a closed terminal or SSH connection;
- _may_ survive when the operating system user session ends, depending on host configuration;
- _will not_ survive host shutdown or reboot.

For many research workflows, this is the useful middle ground: more reliable and feature-rich than unmanaged background processes, but substantially simpler than a heavy-weight scheduler.

## Basic use demo

<figure>
  <video controls muted playsinline autoplay loop preload="metadata">
    <source src="/videos/jobman-basic-cli.webm" type="video/webm" />
    <a href="/videos/jobman-basic-cli.gif">View the GIF version</a>
  </video>
  <figcaption>Basic Jobman command line behavior.</figcaption>
</figure>

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
