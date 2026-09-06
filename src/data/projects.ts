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
    name: "benchmatrix",
    category: "Performance measurement",
    summary:
      "benchmatrix wraps pytest-benchmark with experiment design and statistical checks for comparing performance across code changes.",
    significance:
      "It treats each comparison as an experiment instead of relying on one noisy timing run.",
    technologies: ["Python", "pytest", "Statistics", "CI"],
    links: [
      {
        label: "Read more",
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
    index: "02",
    name: "Python Project Foundry",
    category: "Developer tooling",
    summary:
      "Python Project Foundry asks a few questions, then creates a ready-to-use Python repository.",
    significance:
      "The generated project includes tests, documentation, CI, packaging, containers, and release automation.",
    technologies: ["Python", "uv", "GitHub Actions", "Containers"],
    links: [
      {
        label: "Read more",
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
  {
    index: "03",
    name: "Jobman",
    category: "Research computing",
    summary:
      "Jobman keeps long-running commands alive and adds dependencies, retries, timeouts, logs, and notifications.",
    significance:
      "It is for research jobs that have outgrown nohup and shell scripts but do not need a distributed scheduler.",
    technologies: ["Go", "SQLite", "CLI", "Process control"],
    links: [
      {
        label: "Read more",
        href: "/posts/jobman-a-practical-job-manager-for-research-computing/",
      },
      {
        label: "GitHub",
        href: "https://github.com/ryancswallace/jobman",
      },
      {
        label: "Docs",
        href: "https://jobman.tech/",
      },
    ],
  },
];
