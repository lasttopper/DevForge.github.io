/* ============================================================
   SITE CONFIGURATION
   ------------------------------------------------------------
   Defaults for local development live below. In production the
   GitHub Pages workflow injects values from the repository's
   Actions variables (Settings → Secrets and variables →
   Actions) via assets/js/env.js — those always win over the
   defaults, so you can reconfigure the live site without
   touching the code.
   ============================================================ */
(function () {
  "use strict";

  var env = window.SITE_ENV || {};
  function pick(key, fallback) {
    return env[key] != null && String(env[key]).trim() !== "" ? String(env[key]) : fallback;
  }

  window.SITE_CONFIG = {
    // Brand
    BRAND_NAME: pick("BRAND_NAME", "DevForge"),

    // Contact — WhatsApp number in international format, digits only
    WHATSAPP_NUMBER: pick("WHATSAPP_NUMBER", "15551234567"),

    // Contact — email used for mailto links
    EMAIL: pick("EMAIL", "hello@devforge.dev"),

    // Social profiles
    INSTAGRAM_URL: pick("INSTAGRAM_URL", "https://instagram.com/devforge"),
    LINKEDIN_URL: pick("LINKEDIN_URL", "https://linkedin.com/company/devforge"),
    GITHUB_URL: pick("GITHUB_URL", "https://github.com/devforge"),

    // Lead form endpoint.
    // Leave empty ("") and submissions are simulated locally (nothing
    // is sent). Point it at your backend API route or a form service
    // (Formspree / Basin / serverless function) to receive real leads:
    //   FORM_ENDPOINT: "https://formspree.io/f/your-form-id"
    FORM_ENDPOINT: pick("FORM_ENDPOINT", ""),
  };
})();
