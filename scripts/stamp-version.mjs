#!/usr/bin/env node
// ============================================================================
// stamp-version — single source of truth for the version string.
//
// The repo-root VERSION file is canonical. This script copies its value into
// every place the static splash HTML shows a version (the hero badge on
// index.html and the "current" marker on updates.html) by replacing the inner
// text of any element carrying `data-version-stamp`. The app bundle gets the
// same value a different way (vite `define` in frontend/vite.config.ts), so the
// app and the splash can never disagree.
//
// Idempotent: if VERSION already matches what's stamped, files are unchanged.
// Run locally before committing a release, and it runs in CI before the root
// Worker deploy (see .github/workflows/deploy.yml) so a forgotten local stamp
// can never ship a stale badge.
//
// Usage: node scripts/stamp-version.mjs   (from repo root)
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const version = readFileSync(resolve(root, "VERSION"), "utf8").trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`stamp-version: VERSION "${version}" is not x.y.z — refusing.`);
  process.exit(1);
}

const targets = ["splash/index.html", "splash/updates.html"];
// Match an opening tag carrying data-version-stamp, its inner text, and the
// matching close tag. Replaces only the inner text, preserving attributes.
const re = /(<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*\bdata-version-stamp\b[^>]*>)([\s\S]*?)(<\/\2>)/;

let changed = 0;
for (const rel of targets) {
  const path = resolve(root, rel);
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    console.warn(`stamp-version: ${rel} not found — skipping.`);
    continue;
  }
  if (!re.test(src)) {
    console.warn(`stamp-version: no data-version-stamp element in ${rel} — skipping.`);
    continue;
  }
  const out = src.replace(new RegExp(re.source, "g"), `$1${version}$4`);
  if (out !== src) {
    writeFileSync(path, out);
    console.log(`stamp-version: ${rel} → ${version}`);
    changed++;
  } else {
    console.log(`stamp-version: ${rel} already ${version} (no change)`);
  }
}
console.log(`stamp-version: done (${changed} file(s) updated, version ${version}).`);
