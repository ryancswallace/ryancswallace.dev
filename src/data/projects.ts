export interface ProjectLink {
  label: string;
  href: string;
}

export interface ProjectComponent {
  name: string;
  summary: string;
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
  titleHref?: string;
  featured?: boolean;
  components?: ProjectComponent[];
}

export const PROJECTS: Project[] = [
  {
    index: "01",
    name: "Jobman",
    category: "Job execution platform",
    summary:
      "A job execution platform with daemonless local operation and an optional shared control plane for durable background work, scheduling, retries, logs, and failure analysis.",
    significance:
      "Built around transactional state transitions, concurrent coordination, cross-platform process control, and explicit failure recovery.",
    technologies: [
      "Go",
      "SQLite",
      "PostgreSQL",
      "OIDC",
      "Distributed systems",
      "LLM integration",
    ],
    titleHref: "https://jobman.tech/",
    links: [
      {
        label: "Articles",
        href: "/tags/jobman/",
      },
      {
        label: "GitHub",
        href: "https://github.com/ryancswallace/Jobman",
      },
      {
        label: "Docs",
        href: "https://jobman.tech/",
      },
    ],
    featured: true,
    components: [
      {
        name: "Jobman",
        summary:
          "Local job execution, process supervision, SQLite-backed state, and the command-line interface.",
        href: "https://github.com/ryancswallace/Jobman",
      },
      {
        name: "Jobman Control",
        summary:
          "PostgreSQL-backed coordination and authenticated control across machines.",
        href: "https://github.com/ryancswallace/Jobman-Control",
      },
      {
        name: "Jobman Diagnose",
        summary: "Deterministic and AI-assisted failure analysis.",
        href: "https://github.com/ryancswallace/Jobman-Diagnose",
      },
    ],
  },
  {
    index: "02",
    name: "benchmatrix",
    category: "Performance engineering",
    summary:
      "A Python toolkit for running reproducible benchmark matrices, collecting repeated measurements, and detecting performance regressions.",
    significance:
      "Treats performance testing as an experiment, with paired designs, evidence thresholds, statistical comparisons, and machine-readable reports.",
    technologies: ["Python", "pytest", "Statistics", "CI"],
    links: [
      {
        label: "Technical deep dive",
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
      {
        label: "PyPI",
        href: "https://pypi.org/project/benchmatrix/",
      },
    ],
  },
  {
    index: "03",
    name: "Python Project Foundry",
    category: "Developer experience",
    summary:
      "An opinionated project generator that creates production-ready Python package repositories from a short interactive questionnaire.",
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
