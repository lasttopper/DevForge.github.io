/**
 * Tiny helper library used to author the n8n workflow JSON files in this repo.
 *
 * Why a builder instead of hand-written JSON?
 *  - deterministic node ids (stable diffs in git)
 *  - one place to keep node type-versions in sync
 *  - connections are validated at build time (typos become build errors)
 *
 * Run `npm run build` to regenerate everything in /workflows.
 */
import { createHash } from 'node:crypto';

/** Deterministic UUID v4-looking id derived from the workflow + node name. */
export function stableId(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Node type-versions pinned to n8n >= 1.60 */
export const V = {
  scheduleTrigger: 1.2,
  webhook: 2,
  emailReadImap: 2,
  set: 3.4,
  code: 2,
  httpRequest: 4.2,
  if: 2.2,
  filter: 2.2,
  switch: 3.2,
  merge: 3.2,
  noOp: 1,
  wait: 1.1,
  splitInBatches: 3,
  splitOut: 1,
  removeDuplicates: 1.1,
  emailSend: 2.1,
  crypto: 1,
  extractFromFile: 1,
  stickyNote: 1,
  respondToWebhook: 1.1,
};

export class Workflow {
  constructor(name, { description = '', tags = [] } = {}) {
    this.name = name;
    this.description = description;
    this.tags = tags;
    this.nodes = [];
    this.connections = {};
    this._names = new Set();
  }

  /** Low level node factory. */
  add(name, type, typeVersion, position, parameters = {}, extra = {}) {
    if (this._names.has(name)) throw new Error(`Duplicate node name: ${name}`);
    this._names.add(name);
    const node = {
      parameters,
      type,
      typeVersion,
      position,
      id: stableId(`${this.name}::${name}`),
      name,
      ...extra,
    };
    this.nodes.push(node);
    return node;
  }

  /** Sticky note (documentation right on the canvas). */
  note(content, position, width = 380, height = 260, color = 7) {
    const name = `Note ${this.nodes.filter((n) => n.type.endsWith('stickyNote')).length + 1}`;
    return this.add(name, 'n8n-nodes-base.stickyNote', V.stickyNote, position, {
      content,
      width,
      height,
      color,
    });
  }

  /** Connect `from` output index -> `to` input index. */
  connect(from, to, fromIndex = 0, toIndex = 0) {
    if (!this._names.has(from)) throw new Error(`connect(): unknown source node "${from}"`);
    if (!this._names.has(to)) throw new Error(`connect(): unknown target node "${to}"`);
    const entry = (this.connections[from] ??= { main: [] });
    while (entry.main.length <= fromIndex) entry.main.push([]);
    entry.main[fromIndex].push({ node: to, type: 'main', index: toIndex });
    return this;
  }

  /** Connect a linear chain of nodes. */
  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
    return this;
  }

  toJSON() {
    return {
      name: this.name,
      nodes: this.nodes,
      connections: this.connections,
      active: false,
      pinData: {},
      settings: {
        executionOrder: 'v1',
        saveManualExecutions: true,
        callerPolicy: 'workflowsFromSameOwner',
        errorWorkflow: '',
      },
      staticData: null,
      meta: { templateCredsSetupCompleted: false },
      tags: this.tags,
      versionId: stableId(`${this.name}::version`),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Node shorthands                                                     *
 * ------------------------------------------------------------------ */

export const set = (wf, name, pos, assignments, opts = {}) =>
  wf.add(
    name,
    'n8n-nodes-base.set',
    V.set,
    pos,
    {
      mode: 'manual',
      duplicateItem: false,
      assignments: {
        assignments: assignments.map((a, i) => ({
          id: stableId(`${name}::${a.name}::${i}`),
          name: a.name,
          value: a.value,
          type: a.type ?? 'string',
        })),
      },
      includeOtherFields: opts.includeOtherFields ?? false,
      options: {},
    },
    opts.extra ?? {},
  );

export const code = (wf, name, pos, jsCode, opts = {}) =>
  wf.add(
    name,
    'n8n-nodes-base.code',
    V.code,
    pos,
    { mode: opts.mode ?? 'runOnceForAllItems', jsCode },
    opts.extra ?? {},
  );

export const http = (wf, name, pos, params, extra = {}) =>
  wf.add(
    name,
    'n8n-nodes-base.httpRequest',
    V.httpRequest,
    pos,
    { method: 'GET', options: {}, ...params },
    extra,
  );

export const noOp = (wf, name, pos) => wf.add(name, 'n8n-nodes-base.noOp', V.noOp, pos, {});

export const merge = (wf, name, pos, numberInputs = 2) =>
  wf.add(name, 'n8n-nodes-base.merge', V.merge, pos, {
    mode: 'append',
    numberInputs,
    options: {},
  });

/** Build a v2 filter/if condition. */
export const cond = (leftValue, operator, rightValue = '', extra = {}) => ({
  id: stableId(`${leftValue}::${JSON.stringify(operator)}::${rightValue}`),
  leftValue,
  rightValue,
  operator,
  ...extra,
});

export const OP = {
  strEquals: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
  strNotEquals: { type: 'string', operation: 'notEquals', name: 'filter.operator.notEquals' },
  strContains: { type: 'string', operation: 'contains', name: 'filter.operator.contains' },
  strNotEmpty: { type: 'string', operation: 'notEmpty', singleValue: true },
  strEmpty: { type: 'string', operation: 'empty', singleValue: true },
  numGt: { type: 'number', operation: 'gt' },
  numGte: { type: 'number', operation: 'gte' },
  boolTrue: { type: 'boolean', operation: 'true', singleValue: true },
  boolFalse: { type: 'boolean', operation: 'false', singleValue: true },
  arrContains: { type: 'array', operation: 'contains', rightType: 'any' },
};

const conditionBlock = (conditions, combinator = 'and', typeValidation = 'loose') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation, version: 2 },
  conditions,
  combinator,
});

export const ifNode = (wf, name, pos, conditions, opts = {}) =>
  wf.add(name, 'n8n-nodes-base.if', V.if, pos, {
    conditions: conditionBlock(conditions, opts.combinator ?? 'and', opts.typeValidation ?? 'loose'),
    // NB: looseTypeValidation lives INSIDE options for if v2.1+ / switch v3.1+
    options: { looseTypeValidation: true },
  });

export const filterNode = (wf, name, pos, conditions, opts = {}) =>
  wf.add(name, 'n8n-nodes-base.filter', V.filter, pos, {
    conditions: conditionBlock(conditions, opts.combinator ?? 'and', opts.typeValidation ?? 'loose'),
    options: { looseTypeValidation: true },
  });

/**
 * Switch node (v3.2).
 * rules: [{ key: 'INTERESTED', conditions: [...] }]
 */
export const switchNode = (wf, name, pos, rules, opts = {}) =>
  wf.add(name, 'n8n-nodes-base.switch', V.switch, pos, {
    rules: {
      values: rules.map((r) => ({
        conditions: conditionBlock(r.conditions, r.combinator ?? 'and', 'loose'),
        renameOutput: true,
        outputKey: r.key,
      })),
    },
    options: {
      looseTypeValidation: true,
      ...(opts.allMatchingOutputs ? { allMatchingOutputs: true } : {}),
      ...(opts.fallbackOutput ? { fallbackOutput: opts.fallbackOutput } : {}),
    },
  });

export const wait = (wf, name, pos, amount, unit = 'seconds') =>
  wf.add(name, 'n8n-nodes-base.wait', V.wait, pos, { amount, unit }, {
    webhookId: stableId(`${name}::webhook`),
  });

/* ------------------------------------------------------------------ *
 * Domain-specific shorthands (Supabase / OpenRouter / Evolution ...)  *
 * ------------------------------------------------------------------ */

export const SUPA_AUTH = {
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'supabaseApi',
};

export const HEADER_AUTH = {
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
};

export const BASIC_AUTH = {
  authentication: 'genericCredentialType',
  genericAuthType: 'httpBasicAuth',
};

/** POST to a Supabase Postgres function (RPC). */
export const supabaseRpc = (wf, name, pos, fnName, jsonBody, extra = {}) =>
  http(
    wf,
    name,
    pos,
    {
      method: 'POST',
      url: `={{ $json.supabase_url || $('⚙️ Config').first().json.supabase_url }}/rest/v1/rpc/${fnName}`,
      ...SUPA_AUTH,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: { timeout: 30000 },
    },
    extra,
  );

/** PATCH rows through PostgREST. */
export const supabasePatch = (wf, name, pos, table, filter, jsonBody, extra = {}) =>
  http(
    wf,
    name,
    pos,
    {
      method: 'PATCH',
      url: `={{ $('⚙️ Config').first().json.supabase_url }}/rest/v1/${table}?${filter}`,
      ...SUPA_AUTH,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Prefer', value: 'return=representation' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: { timeout: 30000 },
    },
    extra,
  );

export const supabaseInsert = (wf, name, pos, table, jsonBody, extra = {}) =>
  http(
    wf,
    name,
    pos,
    {
      method: 'POST',
      url: `={{ $('⚙️ Config').first().json.supabase_url }}/rest/v1/${table}`,
      ...SUPA_AUTH,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'Prefer', value: 'return=representation' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody,
      options: { timeout: 30000 },
    },
    extra,
  );

export const supabaseSelect = (wf, name, pos, query, extra = {}) =>
  http(
    wf,
    name,
    pos,
    {
      method: 'GET',
      url: `={{ $('⚙️ Config').first().json.supabase_url }}/rest/v1/${query}`,
      ...SUPA_AUTH,
      options: { timeout: 30000 },
    },
    extra,
  );

/**
 * OpenRouter (Hermes) chat completion.
 * Expects the incoming item to expose `prompt` (and optionally `system_prompt`).
 */
export const openRouter = (wf, name, pos, { model, maxTokens = 900, temperature = 0.7, promptExpr = '$json.prompt', systemExpr = '$json.system_prompt' }, extra = {}) =>
  http(
    wf,
    name,
    pos,
    {
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      ...HEADER_AUTH,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'HTTP-Referer', value: '={{ $(\'⚙️ Config\').first().json.public_site_url }}' },
          { name: 'X-Title', value: 'Omnichannel AI Sales Machine' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={\n  "model": {{ JSON.stringify(${model}) }},\n  "temperature": ${temperature},\n  "max_tokens": ${maxTokens},\n  "messages": [\n    { "role": "system", "content": {{ JSON.stringify(${systemExpr} || 'You are a helpful assistant.') }} },\n    { "role": "user", "content": {{ JSON.stringify(${promptExpr}) }} }\n  ]\n}`,
      options: { timeout: 180000, response: { response: { neverError: false } } },
    },
    { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, ...extra },
  );

/** Evolution API – send a WhatsApp text message. */
export const evolutionSendText = (wf, name, pos, { numberExpr, textExpr }, extra = {}) =>
  http(
    wf,
    name,
    pos,
    {
      method: 'POST',
      url: `={{ $('⚙️ Config').first().json.evolution_url }}/message/sendText/{{ $('⚙️ Config').first().json.evolution_instance }}`,
      ...HEADER_AUTH,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={\n  "number": {{ JSON.stringify(${numberExpr}) }},\n  "delay": 1200,\n  "linkPreview": true,\n  "text": {{ JSON.stringify(${textExpr}) }}\n}`,
      options: { timeout: 60000 },
    },
    { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, ...extra },
  );

/** SMTP e-mail (Gmail app password friendly). */
export const sendEmail = (wf, name, pos, { toExpr, subjectExpr, textExpr, htmlExpr }, extra = {}) =>
  wf.add(
    name,
    'n8n-nodes-base.emailSend',
    V.emailSend,
    pos,
    {
      // explicit rather than relying on the node default
      operation: 'send',
      fromEmail: "={{ $('⚙️ Config').first().json.sender_email }}",
      toEmail: `=${toExpr}`,
      subject: `=${subjectExpr}`,
      emailFormat: htmlExpr ? 'both' : 'text',
      text: `=${textExpr}`,
      ...(htmlExpr ? { html: `=${htmlExpr}` } : {}),
      options: { appendAttribution: false },
    },
    { onError: 'continueRegularOutput', ...extra },
  );
