const primaryColorScheme = ""; // "light" | "dark"
const storageKey = "theme";
const sharedCookieName = "rw-theme";
const sharedCookieDomain = "ryancswallace.dev";
const sharedCookieMaxAge = 60 * 60 * 24 * 365;

function isTheme(value) {
  return value === "light" || value === "dark";
}

function getSharedTheme() {
  const cookie = document.cookie
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(`${sharedCookieName}=`));
  const value = cookie?.slice(sharedCookieName.length + 1);

  return isTheme(value) ? value : null;
}

function getLocalTheme() {
  try {
    const value = localStorage.getItem(storageKey);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function setLocalTheme(theme) {
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    // The shared cookie still preserves the preference when storage is unavailable.
  }
}

function setSharedTheme(theme) {
  document.cookie = `${sharedCookieName}=${theme}; Path=/; Domain=${sharedCookieDomain}; Max-Age=${sharedCookieMaxAge}; SameSite=Lax; Secure`;
}

function getSavedTheme() {
  return getSharedTheme() || getLocalTheme();
}

function saveTheme(theme) {
  setLocalTheme(theme);
  setSharedTheme(theme);
}

const sharedTheme = getSharedTheme();
const localTheme = getLocalTheme();

if (sharedTheme) {
  setLocalTheme(sharedTheme);
} else if (localTheme) {
  // Migrate the existing origin-specific preference to both sites.
  saveTheme(localTheme);
}

function getPreferTheme() {
  // Return the shared or legacy origin-specific preference if it is set.
  const savedTheme = getSavedTheme();
  if (savedTheme) return savedTheme;

  // return primary color scheme if it is set
  if (primaryColorScheme) return primaryColorScheme;

  // return user device's prefer color scheme
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

let themeValue = getPreferTheme();

function setPreference() {
  saveTheme(themeValue);
  reflectPreference();
}

function reflectPreference() {
  document.firstElementChild.setAttribute("data-theme", themeValue);

  const nextTheme = themeValue === "light" ? "dark" : "light";
  const themeButton = document.querySelector("#theme-btn");
  themeButton?.setAttribute("aria-label", "Switch to " + nextTheme + " theme");
  themeButton?.setAttribute("title", "Switch to " + nextTheme + " theme");
  themeButton?.setAttribute("aria-pressed", String(themeValue === "dark"));

  // Get a reference to the body element
  const body = document.body;

  // Check if the body element exists before using getComputedStyle
  if (body) {
    // Get the computed styles for the body element
    const computedStyles = window.getComputedStyle(body);

    // Get the background color property
    const bgColor = computedStyles.backgroundColor;

    // Set the background color in <meta theme-color ... />
    document
      .querySelector("meta[name='theme-color']")
      ?.setAttribute("content", bgColor);
  }
}

// set early so no page flashes / CSS is made aware
reflectPreference();

window.onload = () => {
  function setThemeFeature() {
    // set on load so screen readers can get the latest value on the button
    reflectPreference();

    // now this script can find and listen for clicks on the control
    document.querySelector("#theme-btn")?.addEventListener("click", () => {
      themeValue = themeValue === "light" ? "dark" : "light";
      setPreference();
    });
  }

  setThemeFeature();

  // Runs on view transitions navigation
  document.addEventListener("astro:after-swap", setThemeFeature);
};

function syncSharedTheme() {
  const latestTheme = getSharedTheme();

  if (latestTheme && latestTheme !== themeValue) {
    themeValue = latestTheme;
    setLocalTheme(themeValue);
    reflectPreference();
  }
}

window.addEventListener("focus", syncSharedTheme);
window.addEventListener("pageshow", syncSharedTheme);

// Set theme-color value before page transition
// to avoid navigation bar color flickering in Android dark mode
document.addEventListener("astro:before-swap", event => {
  const bgColor = document
    .querySelector("meta[name='theme-color']")
    ?.getAttribute("content");

  event.newDocument
    .querySelector("meta[name='theme-color']")
    ?.setAttribute("content", bgColor);
});

// sync with system changes
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", ({ matches: isDark }) => {
    if (!getSavedTheme()) {
      themeValue = isDark ? "dark" : "light";
      reflectPreference();
    }
  });
