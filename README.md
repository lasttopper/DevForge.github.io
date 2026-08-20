# VYROX — Web Design & Development Studio

A complete, production-ready marketing website for a premium web design &
development agency. Built as a dependency-free static site (semantic HTML +
one stylesheet + vanilla JS) for maximum speed, accessibility and ease of
hosting.

**Primary goal:** generate qualified leads via project inquiries and the
free website audit form.

## Structure

```
index.html              Full single-page homepage
privacy.html            Privacy policy
terms.html              Terms of service
robots.txt              Crawler rules (add your sitemap)
assets/
  css/styles.css        All styles (tokens, sections, motion system)
  js/config.js          ← EDIT THIS: brand, WhatsApp, email, socials, form endpoint
  js/main.js            Interactions (navbar, menu, reveal, slider, FAQ, form)
  og-cover.jpg          Open Graph / social share image
```

## Run locally

Any static server works, e.g.:

```bash
python3 -m http.server 8000
# or
npx serve
```

Then open http://localhost:8000.

## Configuration

All contact details and integrations live in `assets/js/config.js`:

- `BRAND_NAME` — shown in navbar/footer/title
- `WHATSAPP_NUMBER` — international digits, powers every WhatsApp CTA
- `EMAIL` — mailto links + audit fallback
- `INSTAGRAM_URL` / `LINKEDIN_URL` / `GITHUB_URL` — social icons
- `FORM_ENDPOINT` — leave `""` to preview locally (submissions are simulated
  locally and *not* sent anywhere). Point it at your backend, a serverless
  function, or a form service (Formspree/Basin/…) to receive real leads.

## Before going live

1. Set your domain in the canonical/OG meta tags in `index.html`,
   `privacy.html`, `terms.html` (search for `yourdomain.com`).
2. Fill real contact values in `assets/js/config.js`.
3. Optionally add a `sitemap.xml` and reference it in `robots.txt`.

## Notes on honesty

The site is intentionally free of fake testimonials, awards or client
statistics. Portfolio pieces are labeled **Concept Project / Selected
Concepts**, and the About section positions the studio truthfully as new and
growing, offering introductory rates.

## Accessibility & performance

- Semantic HTML, single H1, logical heading order, skip link
- Keyboard-operable mobile menu, accordion and before/after slider
- `prefers-reduced-motion` fully respected
- GPU-friendly animations (transform/opacity only), no build step,
  no frameworks, no blocking assets
