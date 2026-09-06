import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const errors = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : path;
    })
  );
  return files.flat();
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return match?.[1] ?? match?.[2];
}

function isLocalReference(value) {
  return (
    value?.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/cdn-cgi/")
  );
}

async function resolveLocalReference(value) {
  const pathname = decodeURIComponent(new URL(value, "https://example.test").pathname);
  const path = join(distRoot, pathname);

  if (extname(pathname)) return (await exists(path)) ? path : null;

  const candidates = [join(path, "index.html"), `${path}.html`];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function report(page, message) {
  errors.push(`${relative(distRoot, page)}: ${message}`);
}

const files = await walk(distRoot);
const htmlFiles = files.filter(path => path.endsWith(".html"));

for (const page of htmlFiles) {
  const html = await readFile(page, "utf8");
  const refreshMeta = (html.match(/<meta\b[^>]*>/gi) ?? []).find(
    tag => getAttribute(tag, "http-equiv")?.toLowerCase() === "refresh"
  );

  if (refreshMeta) {
    const refreshTarget = getAttribute(refreshMeta, "content")
      ?.match(/url\s*=\s*(.+)$/i)?.[1]
      ?.trim();
    if (
      !refreshTarget ||
      (isLocalReference(refreshTarget) &&
        !(await resolveLocalReference(refreshTarget)))
    ) {
      report(page, `invalid redirect target: ${refreshTarget ?? "missing"}`);
    }
    continue;
  }

  if (!/<html\b[^>]*\slang=(?:"[^"]+"|'[^']+')/i.test(html)) {
    report(page, "missing a language declaration");
  }
  if (!/<title>\S[\s\S]*?<\/title>/i.test(html)) {
    report(page, "missing a non-empty title");
  }
  if (!/<meta\b[^>]*\bname=(?:"description"|'description')[^>]*\bcontent=(?:"[^"]+"|'[^']+')/i.test(html)) {
    report(page, "missing a meta description");
  }
  if (!/<main\b[^>]*\bid=(?:"main-content"|'main-content')/i.test(html)) {
    report(page, "missing the main-content landmark");
  }
  if (!/<h1\b/i.test(html)) report(page, "missing an h1 heading");

  for (const image of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (getAttribute(image, "alt") === undefined) {
      report(page, `image is missing alt text: ${image.slice(0, 120)}`);
    }
  }

  for (const button of html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) ?? []) {
    const accessibleText = button
      .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!accessibleText && !getAttribute(button, "aria-label")) {
      report(page, `button has no accessible name: ${button.slice(0, 120)}`);
    }
  }

  const tags = html.match(/<(?:a|link|script|img|source)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const reference = getAttribute(tag, "href") ?? getAttribute(tag, "src");
    if (!isLocalReference(reference)) continue;
    if (!(await resolveLocalReference(reference))) {
      report(page, `broken local reference: ${reference}`);
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${htmlFiles.length} HTML pages.\n`);
}
