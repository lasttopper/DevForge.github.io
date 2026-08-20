/* ============================================================
   SITE CONFIGURATION
   Edit these values to customize the site — nothing else needs
   to change. All contact links, socials and form handling read
   from this single object.
   ============================================================ */
window.SITE_CONFIG = {
  // Brand
  BRAND_NAME: "VYROX",

  // Contact — WhatsApp number in international format, digits only
  // TODO: replace with the real number before launch
  WHATSAPP_NUMBER: "15551234567",

  // Contact — email used for mailto links and the audit fallback
  // TODO: replace with the real inbox before launch
  EMAIL: "hello@vyrox.studio",

  // Social profiles
  // TODO: replace placeholder URLs with real profiles
  INSTAGRAM_URL: "https://instagram.com/",
  LINKEDIN_URL: "https://linkedin.com/",
  GITHUB_URL: "https://github.com/",

  // Lead form endpoint.
  // Leave empty ("") to preview the form locally — submissions are
  // simulated and the success state is shown without sending data.
  // In production, point this at your backend API route or a form
  // service such as Formspree / Basin / a serverless function:
  //   FORM_ENDPOINT: "https://formspree.io/f/your-form-id"
  FORM_ENDPOINT: "",
};
