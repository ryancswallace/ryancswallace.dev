---
author: Ryan Wallace
pubDatetime: 2026-08-02T14:23:00Z
modDatetime: 2026-08-02T14:23:00Z
title: "Benchmarking Is an Experiment: Trustworthy Python Regression Checks with benchmatrix"
slug: benchmarking-is-an-experiment-with-benchmatrix
featured: true
draft: false
tags:
  - benchmatrix
  - python
  - benchmarking
  - statistics
  - experimental-design
  - pytest
description: How benchmatrix turns pytest-benchmark timings into paired, matrix-aware, statistically explicit, and auditable performance regression decisions.
---

<!-- markdownlint-disable MD014 -->
<!-- cspell:words benchmatrix Bonferroni estimand lognormal pseudoreplication pyproject untimed worktree worktrees -->

<div
  class="not-prose mx-auto mb-8 flex max-w-3xl justify-center rounded-xl bg-[#545454] px-6 py-5"
>
  <img
    class="h-auto w-full max-w-2xl !border-0"
    src="https://raw.githubusercontent.com/ryancswallace/benchmatrix/main/docs/assets/benchmatrix-logo.svg"
    alt="benchmatrix"
  />
</div>

<div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-start">
  <div>
    <p class="mt-0">
      One benchmark run can tell me how fast some code ran once. It cannot tell
      me whether a pull request caused a performance regression.
    </p>
    <p class="mb-0">
      That second claim needs an experimental unit, comparable environments,
      repeated observations, a design that limits time drift, and a rule for
      distinguishing regression, practical equivalence, and uncertainty. I
      built benchmatrix to add those pieces around pytest-benchmark.
    </p>
  </div>
  <aside class="not-prose rounded-lg border border-border bg-muted/40 p-4">
    <p class="mt-0 mb-3 text-sm font-semibold text-foreground">Project links</p>
    <nav aria-label="benchmatrix links">
      <ul class="m-0 list-none space-y-3 p-0">
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://github.com/ryancswallace/benchmatrix"
          >
            ryancswallace/benchmatrix
          </a>
          <span class="text-xs text-foreground/70">GitHub repository</span>
        </li>
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://ryancswallace.github.io/benchmatrix/"
          >
            Documentation
          </a>
          <span class="text-xs break-words text-foreground/70"
            >ryancswallace.github.io/benchmatrix</span
          >
        </li>
        <li>
          <a
            class="block text-sm font-medium break-words text-foreground underline decoration-dashed underline-offset-4 hover:text-accent"
            href="https://pypi.org/project/benchmatrix/"
          >
            PyPI
          </a>
          <span class="text-xs text-foreground/70">Python package</span>
        </li>
      </ul>
    </nav>
  </aside>
</div>

**[benchmatrix](https://github.com/ryancswallace/benchmatrix)** is a Python package that adds benchmark matrices, repeated-run collection, paired experiments, and regression checks to [pytest-benchmark](https://pytest-benchmark.readthedocs.io/). pytest-benchmark remains responsible for calibration, timing, and raw benchmark statistics. benchmatrix is the layer that turns those measurements into a reproducible comparison.

The shortest workflow is three commands:

```console
$ uv run benchmatrix measure --runs 5 --output baseline tests/test_benchmarks.py
$ uv run benchmatrix measure --runs 5 --output candidate tests/test_benchmarks.py
$ uv run benchmatrix compare baseline candidate --fail-on-regression
```

The commands are simple. Deciding what they are allowed to conclude is the harder part.

## Build a matrix, not a pile of benchmark functions

Performance questions usually have more than one dimension. An implementation may be fast for small inputs and slow for large ones. A change may improve throughput while making tail latency worse. A regression gate therefore needs to preserve the identity of every measured combination.

benchmatrix represents that combination as an implementation, case, and metric:

```python
from collections.abc import Callable

from benchmatrix import BenchmarkCase, make_benchmark_test


def loop_sum(values: list[int]) -> int:
    total = 0
    for value in values:
        total += value
    return total


implementations: dict[str, Callable[[list[int]], int]] = {
    "builtin": sum,
    "loop": loop_sum,
}

cases = [
    BenchmarkCase.from_values("small", list(range(10_000))),
    BenchmarkCase.from_values("large", list(range(100_000))),
]

test_sum_matrix = make_benchmark_test(
    implementations,
    cases,
    metrics=("single_call_latency",),
)
```

pytest collects one parametrized benchmark for each of the four cells. benchmatrix attaches strict JSON metadata identifying the cell and its measurement context, while pytest-benchmark performs the timing.

The generated test is not a substitute for correctness tests. I keep an ordinary test that checks every implementation against the expected result. benchmatrix also supports an untimed result validator, but a fast wrong answer is still a wrong answer regardless of where validation happens.

The same matrix can expose three views of pytest-benchmark timings:

| Metric              | Question                                                     | Direction |
| ------------------- | ------------------------------------------------------------ | --------- |
| Single-call latency | How long does one completed synchronous call take?           | Lower     |
| Batch throughput    | How many declared units of work are completed per second?    | Higher    |
| Tail latency        | How slow is the p95 end of the retained timing distribution? | Lower     |

This identity matters later. A comparison should not silently align different cases, confuse throughput with latency, or compare tail samples collected under incompatible iteration settings.

## The process is the experimental unit

pytest-benchmark may execute a target many times while it calibrates loops and gathers rounds. Those observations are valuable: they make the statistic for that invocation more stable and reveal within-run variation.

They are not independent repetitions of the code change.

Rounds from one process share interpreter state, allocator history, imports, CPU conditions, and other process-level effects. Treating 1,000 rounds from one Python process as 1,000 independent experimental units would be pseudoreplication. It would make the reported uncertainty look far smaller than the experiment supports.

benchmatrix instead treats each separately launched pytest process as one independent run:

<div class="mermaid">
flowchart LR
    C["Code variant"] --> P1["pytest process 1"]
    C --> P2["pytest process 2"]
    C --> P3["pytest process 3"]
    P1 --> R1["Nested timing rounds"]
    P2 --> R2["Nested timing rounds"]
    P3 --> R3["Nested timing rounds"]
    R1 --> S1["One run statistic"]
    R2 --> S2["One run statistic"]
    R3 --> S3["One run statistic"]
    S1 --> I["Run-level inference"]
    S2 --> I
    S3 --> I
</div>

For single-call latency, that run statistic is mean latency. For throughput it is mean work per second, and for tail latency it is p95 latency. Raw rounds remain nested within the process. Collecting more rounds can improve a run statistic, but it cannot replace collecting more process runs.

That is why `measure --runs 5` launches pytest five times instead of asking one pytest process for five times as many rounds.

## Independent groups still drift

Five baseline processes followed by five candidate processes are better evidence than one run on each side, but the groups are separated in time. The machine may warm up, cool down, change frequency, or acquire background work between the two phases. A slow drift can look like a code effect.

The problem becomes more pronounced with a matrix. pytest runs matrix cells sequentially, so the first cell and the last cell repeatedly occupy different thermal and carryover positions.

When both revisions are available at once, benchmatrix can collect a paired experiment instead:

```console
$ uv run benchmatrix collect-paired \
    --random-seed 20260801 \
    --output paired-runs \
    --baseline-cwd ../project-baseline \
    --candidate-cwd . \
    -- \
    uv run pytest --benchmark-only tests/test_benchmarks.py \
    ::: \
    uv run pytest --benchmark-only tests/test_benchmarks.py

$ uv run benchmatrix compare paired-runs \
    --paired \
    --fail-on-regression
```

The baseline and candidate commands run from separate working trees. Each scheduled pair is an adjacent two-command block. One possible portion of the schedule looks like this:

| Pair | Command order        | Matrix-order row |
| ---: | -------------------- | ---------------: |
|    1 | Baseline → Candidate |                1 |
|    2 | Candidate → Baseline |                1 |
|    3 | Baseline → Candidate |                2 |
|    4 | Candidate → Baseline |                2 |

Three design choices work together.

First, adjacency makes the two variants in a pair more likely to experience the same local machine conditions. Paired inference can then retain their dependence instead of treating them as unrelated samples.

Second, the blocks alternate between baseline-first (`AB`) and candidate-first (`BA`). A fixed first-run or second-run effect cannot always favor the same variant.

Third, both members of a pair execute their matrix cells in the same order. Across pairs, benchmatrix uses deterministic Williams-style order rows that balance each cell's ordinal position. Over a complete cycle, the rows also balance directed first-order carryover. The joint design crosses every matrix-order row with both AB and BA orientation.

<div class="mermaid">
sequenceDiagram
    participant C as Paired collector
    participant A as Baseline worktree
    participant B as Candidate worktree
    participant M as Durable manifest
    C->>A: Pair 1, order row 1
    A-->>C: Benchmark JSON
    C->>M: Record baseline attempt
    C->>B: Pair 1, order row 1
    B-->>C: Benchmark JSON
    C->>M: Record candidate attempt
    Note over C,M: Pair 1 is evidence only if both commands succeeded
    C->>B: Pair 2, order row 1
    B-->>C: Benchmark JSON
    C->>A: Pair 2, order row 1
    A-->>C: Benchmark JSON
</div>

The random seed does not make the experiment random in the sense of choosing new behavior every time. It makes the schedule reproducible while avoiding a base order derived from incidental dictionary or filename ordering.

## A pair is atomic evidence

Collection has to preserve the design when commands fail. Suppose the baseline command in a block succeeds and the candidate crashes. Using the successful baseline beside some later candidate would break adjacency and silently manufacture a pair that the experiment never collected.

benchmatrix keeps the successful file for audit but excludes it from paired inference. Resuming a partially persisted block or retrying a failed block runs a fresh adjacent pair. Earlier records are never rewritten.

The manifest is updated after every completed command and records:

- pair and block-attempt identity;
- AB or BA orientation;
- matrix-order row;
- command, working directory, and result path;
- start time, duration, and return code;
- accepted commit and environment fingerprint; and
- validation warnings or the reason an attempt was rejected.

A successful command is not automatically accepted evidence. Its JSON must be valid, its matrix must match the established matrix, its cells must appear in the scheduled order, its variant's commit must remain stable, and its environment must remain compatible with earlier accepted runs.

This turns resume into revalidation rather than “continue from the next filename.” The collector reloads the manifest and referenced files, checks the original commands and working directories, and reconstructs complete pairs from durable records. Collection failure remains part of the evidence trail instead of disappearing behind a retry loop.

## Estimate a change at the run level

For each matrix cell, benchmatrix aggregates the process-run statistics with a median. If `b` is the baseline median and `c` is the candidate median, the reported effect is direction aware:

```text
higher is better: 100 × (c / b − 1)
lower is better:  100 × (1 − c / b)
```

Positive values therefore always mean improvement. A candidate latency of 1.10 seconds against a 1.00-second baseline is a 10% regression, while candidate throughput of 110 items per second against 100 is a 10% improvement.

The default inference method forms a bias-corrected and accelerated bootstrap interval around that ratio-of-marginal-medians estimand. Independent comparisons resample the two run groups separately. Paired comparisons resample complete `(baseline, candidate)` tuples, preserving the match.

Manifest-backed paired comparisons also preserve the observed AB and BA counts as fixed strata. If running second has an effect, the bootstrap should not pretend that the experiment randomly produced an arbitrary number of baseline-first and candidate-first blocks. Within each bootstrap replicate, benchmatrix samples pairs inside their recorded orientation strata.

The implementation derives a stable seed from the configured seed and the matrix-cell identity. Reordering input files or matrix output does not give a cell a different pseudorandom stream. If the jackknife adjustment required for BCa is degenerate, benchmatrix reports the condition and uses a percentile-bootstrap interval rather than silently changing the estimand.

## A confidence interval is not yet a regression policy

A statistical difference can be too small to matter, and an observed difference can remain too uncertain to classify. benchmatrix combines uncertainty with a practical threshold, such as 5%.

<div class="mermaid">
flowchart TB
    I["Adjusted confidence interval"] --> R{"Where is the complete interval?"}
    R -->|"Below −5%"| REG["Regressed"]
    R -->|"Inside −5% to +5%"| SAME["Unchanged"]
    R -->|"Above +5%"| IMP["Improved"]
    R -->|"Crosses a boundary"| INC["Inconclusive"]
</div>

`unchanged` is a positive claim of practical equivalence under the configured rule: the complete interval is inside the region from −5% to +5%. It does not mean merely that the analysis failed to detect a regression.

Likewise, `inconclusive` is not a pass disguised as uncertainty. It means the evidence cannot distinguish the relevant regions. When `--fail-on-regression` is acting as a CI gate, regressions and inconclusive cells both produce a failing comparison. Missing cells, inadequate evidence, incomplete collections, and blocking environment differences fail as well.

A matrix creates another statistical problem. If I inspect enough independent 95% intervals, the chance that at least one excludes the truth by chance is greater than 5%. benchmatrix defines the comparison family before classification and applies a Bonferroni adjustment by default:

```text
cell confidence = 1 − (1 − family confidence) / comparable cells
```

For a four-cell matrix and a 95% family confidence target, each cell receives a 98.75% interval. This is conservative, especially for a large matrix, but it prevents the gate from presenting per-cell confidence as matrix-wide confidence.

The policy belongs in `pyproject.toml` so local and CI decisions use the same reviewed settings:

```toml
[tool.benchmatrix.evidence]
minimum_runs = 5

[tool.benchmatrix.inference]
method = "bca_bootstrap"
confidence_level = 0.95
resamples = 50000
random_seed = 0
multiplicity = "bonferroni"

[tool.benchmatrix.regression]
default_threshold_percent = 5.0

[tool.benchmatrix.regression.by_metric]
tail_latency = 8.0
```

Thresholds can also target a case, implementation, or exact matrix cell. A latency-sensitive endpoint does not have to share a tolerance with a coarse batch-throughput benchmark.

## Three gates before classification

The comparison engine separates three questions that are easy to conflate:

1. **Are the run environments comparable?** Python, machine, dependency, and pytest-benchmark metadata are checked according to a strict, permissive, or disabled compatibility policy.
2. **Does the matrix cell have matching measurement context?** Work units, input-copy behavior, tail-percentile declarations, units, and other metric metadata must agree.
3. **Is the evidence adequate?** Every cell must appear in enough independent runs, and each run must retain the required rounds, iterations, and raw timing observations.

Only then can an interval support a regression classification. Tail latency has stronger defaults: at least 100 round-duration observations per process and one target iteration per round. Averaging several calls into one round would hide the call-level variation that p95 is supposed to describe.

This separation is useful when a gate fails. “The candidate regressed” is a different diagnosis from “the candidate was measured under Python 3.14 while the baseline used 3.13” or “one run omitted this cell.” The report preserves those differences rather than collapsing every failure into a red status.

## The report is a decision record

benchmatrix writes a strict, versioned JSON report containing the sources, collection lifecycle, compatibility findings, effective policy, threshold provenance, evidence diagnostics, confidence interval, multiplicity family, derived seed, and final classification for every cell.

Text, Markdown, and the GitHub Actions step summary are renderings of that report model. They do not independently recompute the decision. A machine consumer can load the JSON through the Python API, while a reviewer can read the same result in a pull-request job summary.

The distinction matters over time. Versioned report loading makes an old decision inspectable even as the package evolves. The current schema can still identify older, non-inferential reports rather than interpreting them as though they had been produced by the current method.

## Testing statistical software needs more than example values

The ordinary test suite checks exact behavior: input validation, deterministic seeds, matrix alignment, policy precedence, report round-trips, retries, resume behavior, and public API compatibility. Property-based tests exercise JSON-safe metadata and verify that tail percentiles remain order invariant and bounded by the observed samples.

Exact tests are necessary, but they do not reveal whether a confidence-interval implementation has obviously bad operating behavior. benchmatrix also has fixed-seed simulation tests that generate repeated synthetic experiments and check broad expectations:

- BCa intervals have reasonable null coverage under lognormal timing noise;
- paired intervals retain shared block-level noise;
- orientation-stratified intervals behave sensibly when AB and BA have fixed effects;
- Bonferroni-adjusted families limit false directional conclusions; and
- regression, equivalence, and inconclusive decisions concentrate in the expected regions around a practical boundary.

These tests are deliberately not claims of exact finite-sample calibration. Their bounds are broad enough to tolerate harmless implementation changes and strict enough to catch a badly broken method. That is a useful boundary for simulation in a software test suite: it detects statistical regressions without turning one Monte Carlo run into an oracle.

The repository complements those tests with a 95% branch-coverage gate, static type checking, linting, minimum-dependency and Python-version matrices, strict documentation builds, dependency audits, distribution smoke tests, and versioned compatibility fixtures. Statistical correctness and package reliability are tested as related but distinct concerns.

## What benchmatrix cannot promise

Careful design narrows uncertainty; it does not abolish it.

Five runs is the default minimum evidence policy, not a universal guarantee of useful precision. A shared CI runner can remain too noisy for a small effect. Pairing can remove shared block-level drift, but it cannot turn an unstable host into a laboratory. Bonferroni protects the matrix-wide claim by making individual intervals wider, and the cost grows with the number of cells.

Optional paired precision planning estimates the pair count for a fresh future fixed-size collection from pilot log-ratio variability. It is a planning proxy, not power analysis, not the formal median-ratio estimand, and not permission to keep adding pairs until a gate passes. The confirmatory sample size should be fixed before inspecting its outcomes.

Those limitations are part of the interface. benchmatrix reports inadequate and inconclusive evidence instead of converting either into a confident result. It cannot decide whether a 5% threshold is important to a particular application, whether the benchmark represents production work, or whether the machine is controlled well enough for the effect of interest. Those remain experiment-design decisions for the project using it.

## From timings to evidence

A performance regression gate has two jobs. It has to measure code, and it has to limit what may be inferred from those measurements.

pytest-benchmark already provides a mature timing engine. benchmatrix builds the surrounding experiment: explicit matrix identity, independent process runs, adjacent matched blocks, balanced execution order, compatibility checks, evidence requirements, run-level intervals, multiplicity control, practical thresholds, and durable reports.

The result is not a promise that every comparison will be decisive. It is a workflow that can say why a conclusion is supported, why it is not, and exactly which evidence produced the answer.

That is the standard I want from a regression check before it blocks a change.

<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

  mermaid.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "default",
  });

  await mermaid.run({ querySelector: ".mermaid" });
</script>
