export const SITE = {
  website: "https://ryancswallace.dev/",
  author: "Ryan Wallace",
  profile: "https://ryancswallace.dev/",
  desc: "Personal portfolio site built with Astro.",
  title: "ryancswallace.dev",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  editPost: {
    enabled: true,
    text: "Edit page",
    url: "https://github.com/ryancswallace/ryancswallace.dev/",
  },
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  dynamicOgImage: true,
  dir: "ltr",
  lang: "en",
  timezone: "US/Eastern",
} as const;
