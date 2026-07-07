export const SITE = {
  website: "https://ryancswallace.dev/",
  author: "Ryan Wallace",
  profile: "https://ryancswallace.dev/",
  desc: "Ryan Wallace's personal portfolio, blog, and reference site.",
  title: "Ryan Wallace",
  ogImage: "rw_favicons/android-chrome-512x512.png",
  lightAndDarkMode: true,
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/ryancswallace/ryancswallace.dev/",
  },
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: false,
  showBackButton: true,
  dynamicOgImage: true,
  dir: "ltr",
  lang: "en",
  timezone: "US/Eastern",
} as const;
