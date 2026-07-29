import { set } from '../lib/n8n.mjs';

/**
 * Every workflow starts with an "⚙️ Config" Set node.
 * Values come from n8n environment variables with sane, obviously-fake
 * fallbacks so an import never silently posts to the wrong place.
 */
export const CONFIG_FIELDS = [
  // --- infrastructure -------------------------------------------------
  { name: 'supabase_url', value: "={{ $env.SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co' }}" },
  { name: 'evolution_url', value: "={{ ($env.EVOLUTION_API_URL || 'https://your-evolution.up.railway.app').replace(/\\/+$/, '') }}" },
  { name: 'evolution_instance', value: "={{ $env.EVOLUTION_INSTANCE || 'sales-bot' }}" },
  { name: 'n8n_webhook_base', value: "={{ ($env.N8N_WEBHOOK_BASE || $env.WEBHOOK_URL || 'https://your-n8n.example.com').replace(/\\/+$/, '') }}" },
  { name: 'public_site_url', value: "={{ $env.PUBLIC_SITE_URL || 'https://your-agency.example.com' }}" },

  // --- identity -------------------------------------------------------
  { name: 'sender_email', value: "={{ $env.SENDER_EMAIL || 'you@yourdomain.com' }}" },
  { name: 'sender_name', value: "={{ $env.SENDER_NAME || 'Alex' }}" },
  { name: 'agency_name', value: "={{ $env.AGENCY_NAME || 'Studio Nova' }}" },
  { name: 'default_country_code', value: "={{ $env.DEFAULT_COUNTRY_CODE || '91' }}" },

  // --- AI models (OpenRouter slugs) ------------------------------------
  { name: 'model_copywriter', value: "={{ $env.OPENROUTER_MODEL_COPY || 'nousresearch/hermes-3-llama-3.1-405b:free' }}" },
  { name: 'model_triage', value: "={{ $env.OPENROUTER_MODEL_TRIAGE || 'meta-llama/llama-3.3-70b-instruct:free' }}" },
  { name: 'model_coder', value: "={{ $env.OPENROUTER_MODEL_CODER || 'deepseek/deepseek-chat-v3-0324:free' }}" },

  // --- commercials -----------------------------------------------------
  { name: 'price_paise', value: '={{ Number($env.OFFER_PRICE_PAISE || 150000) }}', type: 'number' },
  { name: 'currency', value: "={{ $env.OFFER_CURRENCY || 'INR' }}" },

  // --- lead sourcing ----------------------------------------------------
  { name: 'searches_per_run', value: '={{ Number($env.SEARCHES_PER_RUN || 1) }}', type: 'number' },
  { name: 'apify_max_places', value: '={{ Number($env.APIFY_MAX_PLACES || 20) }}', type: 'number' },

  // --- phase 4 ----------------------------------------------------------
  // 'auto' = Hermes builds the paid site, 'manual' = you build it yourself
  { name: 'build_mode', value: "={{ ($env.BUILD_MODE || 'auto').toLowerCase() === 'manual' ? 'manual' : 'auto' }}" },
  // Leave as $env if you can. Only paste the literal secret here if your n8n
  // blocks $env (n8n Cloud) — the workflow JSON would then contain a secret.
  { name: 'razorpay_webhook_secret', value: "={{ $env.RAZORPAY_WEBHOOK_SECRET || '' }}" },

  // --- guard rails ------------------------------------------------------
  { name: 'max_new_leads_per_run', value: '={{ Number($env.MAX_NEW_LEADS_PER_RUN || 10) }}', type: 'number' },
  { name: 'whatsapp_daily_cap', value: '={{ Number($env.WHATSAPP_DAILY_CAP || 40) }}', type: 'number' },
  // Defaults to TRUE on purpose: a fresh import must not be able to message a
  // real business until the operator explicitly sets DRY_RUN=false.
  { name: 'dry_run', value: "={{ ($env.DRY_RUN || 'true') !== 'false' }}", type: 'boolean' },
  { name: 'alert_channel_url', value: "={{ $env.ALERT_WEBHOOK_URL || '' }}" },
];

export const configNode = (wf, pos = [-40, 0]) =>
  set(wf, '⚙️ Config', pos, CONFIG_FIELDS);

/** Standard header used on every sticky note so the canvas reads top-down. */
export const HEADER_COLOR = 4; // blue-ish
export const WARN_COLOR = 3; // red-ish
export const OK_COLOR = 5; // green-ish
