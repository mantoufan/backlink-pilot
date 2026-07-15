// generic.js — Universal directory submission adapter using bb-browser
// Works with any directory site by auto-detecting form fields via snapshot

import { withBrowser, delay } from '../browser.js';

// Field detection patterns (reused from batch-submit.js proven selectors)
const FIELD_PATTERNS = {
  name: /name|title|product|app.?name|tool.?name/i,
  url: /url|website|link|homepage|site/i,
  email: /email|mail|e-mail/i,
  description: /desc|description|about|summary|detail|intro/i,
};

const SUBMIT_PATTERNS = /submit|send|add|post|create|list|suggest|save/i;

/**
 * Parse bb-browser snapshot output to find interactive elements.
 *
 * bb-browser 0.11.6 snapshot format is: `<role> [ref=<N>] "<label>"`, e.g.
 *   label   [ref=8]  "Tool URL *"
 *   textbox [ref=9]  "Tool URL"
 *   button  [ref=20] "Submit"
 * (The old format was `@3 [textbox] Name`.) Fields are matched by the label — we
 * prefer the preceding `label` line (explicit field labels like "Email *") over the
 * input's own placeholder, because placeholders like "username@gmail.com" false-match
 * the name/email patterns. Refs are returned as `@N`, which bb-browser's fill/click want.
 */
const INPUT_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'textarea']);

function parseSnapshot(snapshot) {
  const fields = { name: null, url: null, email: null, description: null, submit: null };
  const lines = snapshot.split('\n');
  let pendingLabel = ''; // text of the most recent `label` line

  for (const line of lines) {
    const m = line.match(/^\s*([\w-]+)\s+\[ref=(\d+)\]\s*(?:"([^"]*)")?/);
    if (!m) continue;
    const [, role, num, rawLabel = ''] = m;
    const ref = `@${num}`;

    if (role === 'label') {
      pendingLabel = rawLabel;
      continue;
    }

    // Prefer the explicit preceding label; fall back to the element's own label.
    const label = (pendingLabel || rawLabel).toLowerCase();

    if (INPUT_ROLES.has(role)) {
      // A textarea is almost always the description/message body.
      if (!fields.description && (role === 'textarea' || FIELD_PATTERNS.description.test(label))) fields.description = ref;
      else if (!fields.url && FIELD_PATTERNS.url.test(label)) fields.url = ref;
      else if (!fields.email && FIELD_PATTERNS.email.test(label)) fields.email = ref;
      else if (!fields.name && FIELD_PATTERNS.name.test(label)) fields.name = ref;
      pendingLabel = ''; // consumed
    } else if ((role === 'button' || role === 'link') && SUBMIT_PATTERNS.test((rawLabel || '').toLowerCase())) {
      if (!fields.submit) fields.submit = ref;
    }
  }

  return fields;
}

export default {
  name: 'generic',
  url: null,
  auth: 'none',
  captcha: 'none',
  engine: 'bb', // forces bb-browser

  async submit(product, config) {
    const targetUrl = config._genericUrl || config._targetUrl;
    if (!targetUrl) throw new Error('No target URL provided for generic submission');

    return withBrowser({ ...config, _engine: 'bb' }, async ({ page }) => {
      // 1. Navigate to submission page
      console.log(`  📄 Opening ${targetUrl}`);
      await page.goto(targetUrl);
      await delay(2000);

      // 1.5. Validate page — check for dead/login/paid pages
      const pageUrl = typeof page.url === 'function' ? page.url() : '';
      const pageTitle = await page.textContent('title').catch(() => '');
      const bodyText = await page.textContent('body').catch(() => '');
      const bodySnippet = bodyText.substring(0, 500).toLowerCase();

      if (/404|not found|page not found/.test(bodySnippet) || /404/.test(pageTitle)) {
        throw new Error(`Page returned 404 — submit URL may have changed. Check the site root.`);
      }
      if (/500|server error|internal error/.test(bodySnippet)) {
        throw new Error(`Page returned 500 Server Error — site may be down.`);
      }
      if (/login|sign.?in|log.?in|create.?account/.test(pageUrl.toLowerCase()) ||
          (/login|sign.?in/.test(bodySnippet) && !/submit|add.*tool|description/.test(bodySnippet))) {
        throw new Error(`Page redirected to login — this site now requires an account.`);
      }
      if (/stripe\.com|checkout|payment|pricing|buy now|\$\d+/.test(bodySnippet) &&
          !/free/.test(bodySnippet)) {
        throw new Error(`Page appears to be a payment page — this site may no longer be free.`);
      }

      // 2. Take interactive snapshot
      console.log('  🔍 Scanning form fields...');
      const snapshot = await page.snapshot();
      const fields = parseSnapshot(snapshot);

      const detected = Object.entries(fields)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`  📋 Detected: ${detected || 'none'}`);

      if (!fields.name && !fields.url && !fields.description) {
        throw new Error('No recognizable form fields found. Use scout first.');
      }

      // 3. Fill detected fields
      if (fields.name) {
        console.log(`  ✏️  Filling name: ${product.name}`);
        await page.fill(fields.name, product.name);
        await delay(300);
      }

      if (fields.url) {
        const url = product.utm_url || product.url;
        console.log(`  ✏️  Filling URL: ${url}`);
        await page.fill(fields.url, url);
        await delay(300);
      }

      if (fields.email) {
        console.log(`  ✏️  Filling email: ${product.email}`);
        await page.fill(fields.email, product.email);
        await delay(300);
      }

      if (fields.description) {
        const desc = product.long_description || product.description;
        console.log(`  ✏️  Filling description`);
        await page.fill(fields.description, desc);
        await delay(300);
      }

      // 4. Screenshot before submit
      try {
        const screenshotDir = config.browser?.screenshot_dir || './screenshots';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await page.screenshot(`${screenshotDir}/generic-${timestamp}.png`);
      } catch {}

      // 5. Submit
      if (fields.submit) {
        console.log(`  🚀 Clicking submit (${fields.submit})`);
        await page.click(fields.submit);
        await delay(3000);
      } else {
        console.log('  ⚠️  No submit button found — form filled but not submitted');
      }

      const currentUrl = page.url();
      return {
        url: currentUrl,
        confirmation: fields.submit
          ? 'Generic submission completed — verify manually'
          : 'Form filled but no submit button found',
      };
    });
  },
};
