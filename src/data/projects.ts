export interface ProjectLink {
  label: string;
  href: string;
}

export interface Project {
  index: string;
  name: string;
  category: string;
  summary: string;
  significance: string;
  technologies: string[];
  links: ProjectLink[];
}

export const PROJECTS: Project[] = [
  {
    index: "01",
    name: "Jobman ecosystem",
    category: "Systems engineering",
    summary:
      "A set of Go services and command-line tools I built for durable background jobs, shared coordination, and AI-assisted diagnostics.",
    significance:
      "The system spans process-tree control, SQLite and PostgreSQL state, concurrency coordination, OIDC, and failure analysis.",
    technologies: ["Go", "SQLite/PostgreSQL", "Distributed systems", "AI"],
    links: [
      {
        label: "Case study",
        href: "/posts/jobman-a-practical-job-manager-for-research-computing/",
      },
      {
        label: "GitHub",
        href: "https://github.com/ryancswallace/Jobman",
      },
      {
        label: "Control plane",
        href: "https://github.com/ryancswallace/Jobman-Control",
      },
      {
        label: "AI diagnostics",
        href: "https://github.com/ryancswallace/Jobman-Diagnose",
      },
    ],
  },
  {
    index: "02",
    name: "benchmatrix",
    category: "Performance engineering",
    summary:
      "A Python toolkit I built to turn pytest-benchmark results into reproducible performance experiments.",
    significance:
      "It supports process-level replication, paired designs, matrix-aware comparisons, and statistical regression gates for CI.",
    technologies: ["Python", "pytest", "Statistics", "CI"],
    links: [
      {
        label: "Case study",
        href: "/posts/benchmatrix-performance-benchmarking-as-an-experiment/",
      },
      {
        label: "GitHub",
        href: "https://github.com/ryancswallace/benchmatrix",
      },
      {
        label: "Docs",
        href: "https://ryancswallace.github.io/benchmatrix/",
      },
    ],
  },
  {
    index: "03",
    name: "Vector Search Study",
    category: "ML systems",
    summary:
      "A benchmark suite I built to compare exact vector-search implementations under deterministic, correctness-checked workloads.",
    significance:
      "It validates every measured cell against an oracle and separates pilot analysis from paired confirmatory experiments.",
    technologies: ["Python", "Vector search", "NumPy", "scikit-learn"],
    links: [
      {
        label: "GitHub",
        href: "https://github.com/ryancswallace/vector-search-study",
      },
      {
        label: "Docs",
        href: "https://ryancswallace.github.io/vector-search-study/",
      },
    ],
  },
  {
    index: "04",
    name: "Python Project Foundry",
    category: "Developer experience",
    summary:
      "A project generator I built to create production-ready Python repositories from a short interactive questionnaire.",
    significance:
      "Generated projects include typed source layouts, tests, documentation, security checks, packaging, containers, CI, and release automation.",
    technologies: ["Python", "uv", "GitHub Actions", "Containers"],
    links: [
      {
        label: "Case study",
        href: "/posts/python-project-foundry-a-production-ready-repository-in-one-command/",
      },
      {
        label: "GitHub",
        href: "https://github.com/ryancswallace/python-project-foundry",
      },
      {
        label: "Docs",
        href: "https://ryancswallace.github.io/python-project-foundry/",
      },
    ],
  },
];
