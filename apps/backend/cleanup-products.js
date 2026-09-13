/**
 * AI-Powered Product Cleanup Script
 *
 * Uses OpenAI to intelligently analyze, classify, and clean product data.
 * Exports valid products with references and prices.
 * Accepts non-duplicated products even without price.
 *
 * Usage:
 *   cd apps/backend
 *   node cleanup-products.js                    # analyze & export only (no DB changes)
 *   node cleanup-products.js --apply            # analyze, export, AND delete junk from DB
 *   node cleanup-products.js --batch-size 30    # custom batch size (default: 40)
 */

const { PrismaClient } = require('@prisma/client');
const OpenAI = require('openai').default;
const fs = require('fs');
const path = require('path');

// ── Load .env from project root ──
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const prisma = new PrismaClient();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const applyMode = process.argv.includes('--apply');
const batchSizeArg = process.argv.indexOf('--batch-size');
const BATCH_SIZE = batchSizeArg !== -1 ? parseInt(process.argv[batchSizeArg + 1], 10) : 40;

// ── OpenAI prompt ──
const SYSTEM_PROMPT = `You are a product data quality analyst for a Tunisian safety equipment company.
You will receive a JSON array of products. Analyze each product and classify it.

Classification rules:
- "valid": Real product with a meaningful name. It has a price OR a reference/SKU. Keep it.
- "valid_no_price": Real product with a meaningful name but no price (unitPrice is 0) and no SKU. Still keep it if it's unique.
- "junk": Not a real product — spreadsheet artifacts (e.g. "Feuil1", "Sheet1"), random numbers ("299", "1.3"), 
  single generic words that aren't product names (e.g. just "EPI" with no other info), or names that are just 
  embedded pricing text. These should be removed.
- "duplicate_candidate": Product name is essentially the same as another product in the batch 
  (different casing, minor typos, abbreviations). Mark the one with LESS data (no price, no SKU) as duplicate.

For each product, also suggest a cleaned-up name if the original has issues (embedded prices, URLs, extra whitespace, etc).

IMPORTANT: Products linked to invoices (linkedInvoices > 0) should ALWAYS be classified as "valid" regardless of data quality.
Non-duplicated products without price are acceptable — classify them as "valid_no_price".

Respond with ONLY a JSON array (no markdown fences) where each element is:
{
  "id": "<product id>",
  "classification": "valid" | "valid_no_price" | "junk" | "duplicate_candidate",
  "cleanedName": "<suggested clean name or null if name is fine>",
  "reason": "<brief explanation>"
}`;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function classifyBatch(products, retries = 3) {
  const payload = products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku || null,
    unitPrice: p.unitPrice,
    description: p.description || null,
    linkedInvoices: p._count.items,
  }));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      });

      const text = (response.choices[0].message.content || '').trim();
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

      try {
        return JSON.parse(cleaned);
      } catch {
        console.error(`  ⚠ Failed to parse response (attempt ${attempt})`);
        if (attempt < retries) { await sleep(2000); continue; }
        return products.map((p) => ({
          id: p.id, classification: 'valid', cleanedName: null,
          reason: 'Parse error — defaulting to valid',
        }));
      }
    } catch (e) {
      const isRateLimit = e.status === 429;
      const wait = isRateLimit ? 15000 * attempt : 3000 * attempt;
      console.error(`  ⚠ API error (attempt ${attempt}/${retries}): ${e.message}`);
      if (attempt < retries) {
        console.log(`    Retrying in ${wait / 1000}s…`);
        await sleep(wait);
      } else {
        return products.map((p) => ({
          id: p.id, classification: 'valid', cleanedName: null,
          reason: 'API error — defaulting to valid',
        }));
      }
    }
  }
}

// ── Cross-batch duplicate detection ──
function detectCrossBatchDuplicates(allProducts, classifications) {
  const classMap = new Map(classifications.map((c) => [c.id, c]));
  const nameGroups = new Map();

  for (const p of allProducts) {
    const cls = classMap.get(p.id);
    if (!cls || cls.classification === 'junk') continue;

    const normName = (p.name || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const normSku = (p.sku || '').toLowerCase().trim();
    const key = `${normName}|${normSku}`;

    if (!nameGroups.has(key)) nameGroups.set(key, []);
    nameGroups.get(key).push(p);
  }

  let dupCount = 0;
  for (const [key, group] of nameGroups) {
    if (group.length <= 1) continue;

    // Sort: prefer linked products, then with price, then with SKU, then oldest
    group.sort((a, b) => {
      if (b._count.items !== a._count.items) return b._count.items - a._count.items;
      if (b.unitPrice !== a.unitPrice) return b.unitPrice - a.unitPrice;
      if ((b.sku ? 1 : 0) !== (a.sku ? 1 : 0)) return (b.sku ? 1 : 0) - (a.sku ? 1 : 0);
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    // Keep first, mark rest as duplicates
    for (let i = 1; i < group.length; i++) {
      const cls = classMap.get(group[i].id);
      if (cls && cls.classification !== 'junk') {
        cls.classification = 'duplicate_candidate';
        cls.reason = `Duplicate of ${group[0].id} (${group[0].name})`;
        dupCount++;
      }
    }
  }

  return dupCount;
}

(async () => {
  try {
    console.log(applyMode
      ? '🧹 APPLY MODE — will delete junk & duplicates from DB\n'
      : '🔍 ANALYSIS MODE — no DB changes, exports clean data\n');

    // ── Fetch all products ──
    const all = await prisma.product.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { items: true } } },
    });
    console.log(`Total products: ${all.length}`);
    console.log(`Batch size: ${BATCH_SIZE} → ${Math.ceil(all.length / BATCH_SIZE)} batches\n`);

    // ── Process in batches through OpenAI ──
    const allClassifications = [];
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      const batch = all.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(all.length / BATCH_SIZE);
      process.stdout.write(`  Batch ${batchNum}/${totalBatches} (${batch.length} products)… `);

      const results = await classifyBatch(batch);
      allClassifications.push(...results);
      console.log('done');

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < all.length) await sleep(1500);
    }

    // ── Cross-batch duplicate detection ──
    console.log('\nRunning cross-batch duplicate detection…');
    const crossDups = detectCrossBatchDuplicates(all, allClassifications);
    console.log(`  Found ${crossDups} cross-batch duplicates\n`);

    // ── Build classification map ──
    const classMap = new Map(allClassifications.map((c) => [c.id, c]));
    const prodMap = new Map(all.map((p) => [p.id, p]));

    const valid = [];
    const validNoPrice = [];
    const junk = [];
    const duplicates = [];
    const unclassified = [];

    for (const p of all) {
      const cls = classMap.get(p.id);
      if (!cls) { unclassified.push(p); continue; }

      switch (cls.classification) {
        case 'valid': valid.push({ ...p, _cleanedName: cls.cleanedName }); break;
        case 'valid_no_price': validNoPrice.push({ ...p, _cleanedName: cls.cleanedName }); break;
        case 'junk': junk.push({ ...p, _reason: cls.reason }); break;
        case 'duplicate_candidate': duplicates.push({ ...p, _reason: cls.reason }); break;
        default: unclassified.push(p);
      }
    }

    // ── Summary ──
    console.log('═'.repeat(55));
    console.log('  CLASSIFICATION RESULTS');
    console.log('═'.repeat(55));
    console.log(`  ✅ Valid (with price/SKU):     ${valid.length}`);
    console.log(`  ✅ Valid (no price, unique):    ${validNoPrice.length}`);
    console.log(`  🗑  Junk / artifacts:           ${junk.length}`);
    console.log(`  🔄 Duplicates:                 ${duplicates.length}`);
    if (unclassified.length) console.log(`  ❓ Unclassified:               ${unclassified.length}`);
    console.log('─'.repeat(55));

    // ── Show junk details ──
    if (junk.length) {
      console.log('\n🗑  JUNK products:');
      for (const p of junk.slice(0, 30)) {
        const linked = p._count.items > 0 ? ` [${p._count.items} invoices]` : '';
        console.log(`    ✗ "${p.name}" (${p.sku || 'no SKU'}, ${p.unitPrice} DT)${linked} — ${p._reason}`);
      }
      if (junk.length > 30) console.log(`    … and ${junk.length - 30} more`);
    }

    // ── Show duplicate details ──
    if (duplicates.length) {
      console.log('\n🔄 DUPLICATE products:');
      for (const p of duplicates.slice(0, 20)) {
        const linked = p._count.items > 0 ? ` [${p._count.items} invoices]` : '';
        console.log(`    ✗ "${p.name}" (${p.sku || 'no SKU'}, ${p.unitPrice} DT)${linked} — ${p._reason}`);
      }
      if (duplicates.length > 20) console.log(`    … and ${duplicates.length - 20} more`);
    }

    // ── Export valid products ──
    const exportData = [...valid, ...validNoPrice].map((p) => ({
      id: p.id,
      name: p._cleanedName || p.name,
      originalName: p._cleanedName ? p.name : undefined,
      sku: p.sku || null,
      unitPrice: p.unitPrice,
      description: p.description || null,
      linkedInvoices: p._count.items,
    }));

    const outDir = path.resolve(__dirname, '../../');
    const outFile = path.join(outDir, 'clean_products.json');
    fs.writeFileSync(outFile, JSON.stringify(exportData, null, 2), 'utf-8');
    console.log(`\n📦 Exported ${exportData.length} valid products → ${outFile}`);

    // ── Full report ──
    const reportFile = path.join(outDir, 'process_result.json');
    fs.writeFileSync(reportFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: all.length,
        valid: valid.length,
        validNoPrice: validNoPrice.length,
        junk: junk.length,
        duplicates: duplicates.length,
      },
      junkProducts: junk.map((p) => ({ id: p.id, name: p.name, sku: p.sku, price: p.unitPrice, reason: p._reason })),
      duplicateProducts: duplicates.map((p) => ({ id: p.id, name: p.name, sku: p.sku, price: p.unitPrice, reason: p._reason })),
    }, null, 2), 'utf-8');
    console.log(`📊 Full report → ${reportFile}`);

    // ── Apply deletions if requested ──
    if (applyMode) {
      // Only delete products NOT linked to invoices
      const toDelete = [...junk, ...duplicates].filter((p) => p._count.items === 0);
      const skippedLinked = [...junk, ...duplicates].filter((p) => p._count.items > 0);

      console.log(`\n🧹 Deleting ${toDelete.length} unlinked junk/duplicate products…`);
      if (skippedLinked.length) {
        console.log(`  ⚠ Skipping ${skippedLinked.length} products linked to invoices`);
      }

      let deleted = 0;
      for (const p of toDelete) {
        await prisma.product.delete({ where: { id: p.id } });
        deleted++;
      }
      console.log(`  ✅ Deleted ${deleted} products`);

      // Apply name corrections on remaining valid products
      let updated = 0;
      for (const p of [...valid, ...validNoPrice]) {
        if (p._cleanedName && p._cleanedName !== p.name) {
          await prisma.product.update({
            where: { id: p.id },
            data: { name: p._cleanedName },
          });
          updated++;
        }
      }
      if (updated) console.log(`  ✏️  Updated ${updated} product names`);

      const remaining = await prisma.product.count();
      console.log(`\n  Remaining products: ${remaining}`);
    } else {
      const removable = [...junk, ...duplicates].filter((p) => p._count.items === 0).length;
      console.log(`\n💡 ${removable} products can be safely removed.`);
      console.log('   Run with --apply to delete junk & duplicates from DB:');
      console.log('   node cleanup-products.js --apply');
    }

    console.log('\n✅ Done.');
  } catch (e) {
    console.error('Error:', e.message);
    if (e.response) console.error('OpenAI error:', e.response?.data || e.status);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
