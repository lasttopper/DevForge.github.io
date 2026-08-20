# DevForge — Web Design & Development Studio

A complete, production-ready marketing website for a premium web design &
development agency. Dependency-free static site (semantic HTML + one
stylesheet + vanilla JS) for maximum speed, accessibility and ease of
hosting — GitHub Pages included.

**Primary goal:** generate qualified leads via project inquiries and the
free website audit form.

## Structure

```
index.html                  Full single-page homepage
privacy.html / terms.html   Legal pages
robots.txt                  Crawler rules
assets/
  css/styles.css            All styles (tokens, sections, motion system)
  js/env.js                 ← written by CI from GitHub Actions variables
  js/config.js              Defaults + env merge (brand, contact, socials)
  js/main.js                Interactions (navbar, menu, slider, FAQ, form)
  og-cover.jpg              Open Graph / social share image
scripts/inject-config.mjs   CI helper: variables → assets/js/env.js
.github/workflows/deploy.yml  GitHub Pages deployment
```

## Run locally

```bash
python3 -m http.server 8000   # or: npx serve
```

Then open http://localhost:8000.

## Configuration (variables)

Values are resolved in this order: **GitHub Actions variables → defaults
in `assets/js/config.js`**. On the deployed site, variables win; locally,
defaults apply.

| Variable        | Purpose                                   | Default (placeholder)                 |
| --------------- | ----------------------------------------- | ------------------------------------- |
| `BRAND_NAME`    | Navbar/footer/title brand                 | `DevForge`                            |
| `WHATSAPP_NUMBER` | Digits-only intl number for WhatsApp CTAs | `15551234567`                         |
| `EMAIL`         | mailto links                              | `hello@devforge.dev`                  |
| `INSTAGRAM_URL` | Instagram icon                            | `https://instagram.com/devforge`      |
| `LINKEDIN_URL`  | LinkedIn icon                             | `https://linkedin.com/company/devforge` |
| `GITHUB_URL`    | GitHub icon                               | `https://github.com/devforge`         |
| `FORM_ENDPOINT` | Lead-form receiver (Formspree/API/…)      | `""` (simulated locally, nothing sent) |

> These are **public** client-side values — never store secrets or API
> keys in them.

### Setting variables from your machine (repo admin)

```bash
gh variable set BRAND_NAME      --body "DevForge"
gh variable set WHATSAPP_NUMBER --body "919876543210"
gh variable set EMAIL           --body "hello@devforge.dev"
gh variable set INSTAGRAM_URL   --body "https://instagram.com/devforge"
gh variable set LINKEDIN_URL    --body "https://linkedin.com/company/devforge"
gh variable set GITHUB_URL      --body "https://github.com/devforge"
```

Or in the UI: **Settings → Secrets and variables → Actions → Variables**.
The next deploy picks them up automatically (`scripts/inject-config.mjs`
rewrites `assets/js/env.js` during the build).

## Hosting on GitHub Pages

The workflow `.github/workflows/deploy.yml` builds and deploys on every
push to `main` (and `arena/**`) plus manual runs.

**One-time setup (repo admin, in the GitHub UI):**

1. **Settings → Pages → Build and deployment → Source:** select
   **GitHub Actions**.
2. Add any variables you want to override (see above).
3. Push — the workflow publishes the site and shows the live URL on the
   run/deployment page.

### About the `https://devforge.github.io/` URL

A `*.github.io` **user/org site** is served only from a repository named
`<username>.github.io` on that account. To publish at exactly
`https://devforge.github.io/` do one of:

- **Option A (recommended):** create/rename the repository to
  `devforge.github.io` under the `devforge` account and push this code
  there — the workflow deploys it to the root URL.
- **Option B:** transfer this repository to the `devforge` account and
  rename it `devforge.github.io`.
- **Option C:** keep the current repo; the site then lives at
  `https://<owner>.github.io/<repo>/` (all asset links are relative, so
  it works unchanged), or attach a **custom domain** in Settings → Pages.

Meta/OG/canonical tags already target `https://devforge.github.io/`; if
you deploy elsewhere, search-and-replace that origin in `index.html`,
`privacy.html`, `terms.html` and `robots.txt`.

## Honesty by design

No fake testimonials, awards or client statistics. Portfolio pieces are
labeled **Concept Project / Selected Concepts**, and the About section
positions the studio truthfully as new and growing with introductory
rates.

## Accessibility & performance

- Semantic HTML, single H1, logical heading order, skip link
- Keyboard-operable mobile menu, accordion and before/after slider
- `prefers-reduced-motion` fully respected
- GPU-friendly animations (transform/opacity only), no build step,
  no frameworks, no blocking assets
