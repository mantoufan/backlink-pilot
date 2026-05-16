// submit.js — Dispatch submissions to site-specific or generic adapters

import { readdirSync, readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';
import { utmUrl } from './config.js';
import { recordSubmission } from './tracker.js';

function resolveSiteLang(site) {
  if (!existsSync('targets.yaml')) return null;
  const targets = parse(readFileSync('targets.yaml', 'utf-8'));
  const isUrl = site.startsWith('http');
  for (const group of Object.values(targets || {})) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (isUrl) {
        if (entry.submit_url === site) return entry.lang || null;
      } else if (entry.name && entry.name.toLowerCase().replace(/\s+/g, '') === site.toLowerCase()) {
        return entry.lang || null;
      }
    }
  }
  return null;
}

// Dynamic import of site adapters
async function loadAdapter(site) {
  // URL as site → use generic bb-browser adapter
  if (site.startsWith('http')) {
    const generic = await import('./sites/generic.js');
    return { ...generic.default, _targetUrl: site };
  }

  try {
    const mod = await import(`./sites/${site}.js`);
    return mod.default || mod;
  } catch (e) {
    return null;
  }
}

export async function submit(site, opts) {
  const { config } = opts;

  const adapter = await loadAdapter(site);
  if (!adapter) {
    console.error(`❌ No adapter for "${site}".`);
    console.log('\nAvailable sites:');
    const files = readdirSync(new URL('./sites/', import.meta.url));
    for (const f of files) {
      if (f.endsWith('.js')) console.log(`  - ${f.replace('.js', '')}`);
    }
    console.log('\nOr pass a URL directly for generic submission:');
    console.log('  node src/cli.js submit https://example.com/submit --engine bb');
    process.exit(1);
  }

  // Adapter-level engine override
  if (adapter.engine) config._engine = adapter.engine;

  // Pass target URL for generic adapter
  if (adapter._targetUrl) config._targetUrl = adapter._targetUrl;

  const product = {
    ...config.product,
    utm_url: utmUrl(config, site),
  };

  const lang = resolveSiteLang(site);
  if (lang === 'zh' && product.description_zh) {
    product.description = product.description_zh;
    if (product.long_description_zh) product.long_description = product.long_description_zh;
    console.log(`  🌏 Using Chinese description (site lang: zh)`);
  }

  console.log(`\n🚀 Submitting "${product.name}" to ${site}`);
  if (opts.dryRun) {
    console.log('  [DRY RUN] Would submit:', JSON.stringify(product, null, 2));
    return;
  }

  // Pre-flight HTTP check — catch dead sites before launching browser
  const checkUrl = adapter._targetUrl || adapter.url;
  if (checkUrl) {
    try {
      const res = await fetch(checkUrl, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (res) {
        if (res.status === 404) {
          console.error(`❌ ${checkUrl} returned 404 — submit page no longer exists.`);
          console.log('   Try visiting the site root to find the new submit URL.');
          recordSubmission(site, 'failed', { error: '404 — submit page gone' });
          return;
        }
        if (res.status >= 500) {
          console.error(`❌ ${checkUrl} returned ${res.status} — site appears down.`);
          recordSubmission(site, 'failed', { error: `HTTP ${res.status}` });
          return;
        }
      }
    } catch {}
  }

  try {
    const result = await adapter.submit(product, config);
    recordSubmission(site, 'submitted', {
      url: result?.url,
      confirmation: result?.confirmation,
    });
    console.log(`✅ Submitted to ${site}!`);
    if (result?.confirmation) console.log(`  Confirmation: ${result.confirmation}`);
  } catch (e) {
    recordSubmission(site, 'failed', { error: e.message });
    console.error(`❌ Failed: ${e.message}`);
  }
}
