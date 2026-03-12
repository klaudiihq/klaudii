#!/usr/bin/env node
/**
 * Post-install patch check.
 *
 * Verifies that installed versions of patched packages match a vetted version
 * in patches/registry.json. Warns loudly if an unvetted version is installed —
 * the patch may silently fail or apply to changed code.
 *
 * Run automatically via postinstall after patch-package applies patches.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REGISTRY = path.join(__dirname, "registry.json");
const NODE_MODULES = path.join(__dirname, "..", "node_modules");

try {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
  const patches = registry.patches || {};
  let warnings = 0;

  for (const [pkg, info] of Object.entries(patches)) {
    const pkgJsonPath = path.join(NODE_MODULES, ...pkg.split("/"), "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      // Package not installed (optional dep) — skip
      continue;
    }

    const installed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")).version;
    const vetted = info.vetted || [];

    if (!vetted.includes(installed)) {
      warnings++;
      console.error("");
      console.error(`\x1b[33m⚠  UNVETTED PATCH VERSION\x1b[0m`);
      console.error(`   Package: ${pkg}`);
      console.error(`   Installed: ${installed}`);
      console.error(`   Vetted: ${vetted.join(", ")}`);
      console.error(`   Bug: ${info.bug}`);
      console.error(`   File: ${info.file}`);
      console.error("");
      console.error(`   → Check if the bug is fixed upstream, or create a new patch:`);
      console.error(`     1. Verify the fix is still needed in ${info.file}`);
      console.error(`     2. Apply the fix manually in node_modules/`);
      console.error(`     3. Run: npx patch-package ${pkg}`);
      console.error(`     4. Add "${installed}" to patches/registry.json vetted array`);
      console.error("");
    }
  }

  if (warnings > 0) {
    console.error(`\x1b[33m⚠  ${warnings} package(s) on unvetted versions. Patches may not work correctly.\x1b[0m\n`);
  }
} catch (err) {
  // Don't fail the install — just warn
  console.error(`[patch-check] Warning: ${err.message}`);
}
