#!/usr/bin/env node
/* ============================================================
   inject-config.mjs — run by the GitHub Pages workflow.

   Reads the Actions variables exposed as environment variables
   and rewrites assets/js/env.js so the deployed site picks up
   the repository configuration. Values that are not set are
   simply omitted and the defaults in config.js apply.
   ============================================================ */
import { writeFileSync } from "node:fs";

const KEYS = [
  "BRAND_NAME",
  "WHATSAPP_NUMBER",
  "EMAIL",
  "INSTAGRAM_URL",
  "LINKEDIN_URL",
  "GITHUB_URL",
  "FORM_ENDPOINT",
];

const env = {};
for (const key of KEYS) {
  const value = process.env[key];
  if (value != null && value.trim() !== "") env[key] = value.trim();
}

const banner = "/* Injected at deploy time by .github/workflows/deploy.yml from GitHub Actions variables. */\n";
writeFileSync(
  new URL("../assets/js/env.js", import.meta.url),
  banner + "window.SITE_ENV = " + JSON.stringify(env, null, 2) + ";\n"
);

console.log("[inject-config] wrote env.js with keys:", Object.keys(env).join(", ") || "(none — using defaults)");
