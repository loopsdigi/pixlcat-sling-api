/**
 * claude-ops.js — Claude-powered Analytics NLP for Pixlcat Ops
 * 
 * Handles conversational queries in #pixlcat-intelligence-ops about:
 * - Sales data (SF via Toast, Boston via Square)
 * - Mochi attachment rates, flavors, counts
 * - Labor hours, SPLH, costs
 * - Schedules (SF via Sling, Boston via Square)
 * - Daypart breakdowns, category analysis
 * - Cross-location comparisons
 * 
 * Requires: ANTHROPIC_API_KEY env var
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TOAST_URL = process.env.TOAST_API_URL || 'https://toast-api-1.onrender.com';
const SQUARE_URL = process.env.SQUARE_API_URL || 'https://square-api-mi4f.onrender.com';
const FERRY_URL = process.env.FERRY_API_URL || 'https://pixlcat-square-ferry.onrender.com';
const SLING_URL = process.env.SLING_API_URL || 'https://pixlcat-sling-api.onrender.com';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// SF Clement benchmarks
const SF_BENCH = {
  weekday: { sales: 1807, splh: 96 },
  weekend: { sales: 3610, splh: 111 },
};

// Boston benchmarks
const BOS_BENCH = {
  weekday: { sales: 500, splh: 25 },
  weekend: { sales: 800, splh: 40 },
};

// Ferry Building benchmarks (new location — TBD, using placeholder)
const FERRY_BENCH = {
  weekday: { sales: 0, splh: 0 },
  weekend: { sales: 0, splh: 0 },
};

// ── Date range detection ─────────────────────────────────────────────────────

function determineDateRange(text) {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = new Date(pst.getFullYear(), pst.getMonth(), pst.getDate());

  const fmt = (d) => d.toLocaleDateString('en-CA');
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const t = text.toLowerCase();

  // "this week"
  if (/\b(this\s+week|the\s+week|weekly)\b/.test(t)) {
    const dow = today.getDay();
    const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
    return { startDate: fmt(monday), endDate: fmt(addDays(monday, 6)), range: 'week' };
  }

  // "last week"
  if (/\blast\s+week\b/.test(t)) {
    const dow = today.getDay();
    const monday = addDays(today, dow === 0 ? -13 : -6 - dow);
    return { startDate: fmt(monday), endDate: fmt(addDays(monday, 6)), range: 'week' };
  }

  // "weekend"
  if (/\b(this\s+)?weekend\b/.test(t) && !/next|last/.test(t)) {
    const dow = today.getDay();
    let sat;
    if (dow === 6) sat = today;
    else if (dow === 0) sat = addDays(today, -1);
    else sat = addDays(today, 6 - dow);
    return { startDate: fmt(sat), endDate: fmt(addDays(sat, 1)), range: 'weekend' };
  }

  // "last weekend"
  if (/\blast\s+weekend\b/.test(t)) {
    const dow = today.getDay();
    const lastSun = addDays(today, -dow);
    const lastSat = addDays(lastSun, -1);
    return { startDate: fmt(lastSat), endDate: fmt(lastSun), range: 'weekend' };
  }

  // Specific date YYYY-MM-DD
  const dateMatch = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    return { startDate: dateMatch[1], endDate: dateMatch[1], range: 'day' };
  }

  // "today"
  if (/\btoday\b/.test(t)) {
    return { startDate: fmt(today), endDate: fmt(today), range: 'day' };
  }

  // "yesterday"
  if (/\byesterday\b/.test(t)) {
    return { startDate: fmt(addDays(today, -1)), endDate: fmt(addDays(today, -1)), range: 'day' };
  }

  // Day of week
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < dayNames.length; i++) {
    const re = new RegExp(`\\b${dayNames[i]}\\b`);
    if (re.test(t)) {
      const currentDow = today.getDay();
      let diff = (i - currentDow + 7) % 7;
      // Default to last occurrence for past-looking queries (sales, mochi sold, etc.)
      if (/\b(last|sold|sales|revenue|mochi|labor|splh|how many|how much)\b/.test(t)) {
        if (diff === 0) diff = -7;
        else diff = diff - 7;
      }
      if (/\bnext\b/.test(t)) {
        if (diff === 0) diff = 7;
      }
      if (/\blast\b/.test(t) && diff > 0) {
        diff = diff - 7;
      }
      const d = addDays(today, diff);
      return { startDate: fmt(d), endDate: fmt(d), range: 'day' };
    }
  }

  // Default: yesterday (most common for "how did we do" type questions)
  return { startDate: fmt(addDays(today, -1)), endDate: fmt(addDays(today, -1)), range: 'day' };
}


// ── Detect which location(s) the user is asking about ────────────────────────

function detectLocation(text) {
  const t = text.toLowerCase();
  // Specific location detection
  const hasFerry = /\b(ferry|ferry\s*building|fb)\b/.test(t);
  const hasBoston = /\b(boston|charlestown|bos)\b/.test(t);
  const hasSF = /\b(clement|richmond|toast)\b/.test(t);
  const hasAll = /\b(all|every|each|company|combined|total)\b/.test(t);

  // If they say "all locations" or multiple specific ones
  if (hasAll) return 'all';
  
  // Specific single locations
  if (hasFerry && !hasBoston && !hasSF) return 'ferry';
  if (hasBoston && !hasFerry && !hasSF) return 'boston';
  if (hasSF && !hasBoston && !hasFerry) return 'sf';

  // "SF" alone could mean Clement or Ferry — default to all SF if ambiguous
  if (/\b(sf|san\s*francisco)\b/.test(t) && !hasFerry && !hasSF) return 'all';

  // Default: all locations
  return 'all';
}


// ── Fetch data from APIs ─────────────────────────────────────────────────────

async function fetchToastData(date) {
  try {
    const res = await fetch(`${TOAST_URL}/sales?date=${date}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return data;
  } catch (e) {
    console.error(`Toast fetch error for ${date}:`, e.message);
    return null;
  }
}

async function fetchSquareData(date) {
  try {
    const res = await fetch(`${SQUARE_URL}/sales/${date}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return data;
  } catch (e) {
    console.error(`Square fetch error for ${date}:`, e.message);
    return null;
  }
}

async function fetchFerryData(date) {
  try {
    const res = await fetch(`${FERRY_URL}/sales/${date}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return data;
  } catch (e) {
    console.error(`Ferry fetch error for ${date}:`, e.message);
    return null;
  }
}

async function fetchSFSchedule(date) {
  try {
    const res = await fetch(`${SLING_URL}/schedule/${date}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`Sling schedule fetch error for ${date}:`, e.message);
    return null;
  }
}

async function fetchBostonSchedule(date) {
  try {
    const res = await fetch(`${SQUARE_URL}/schedule/${date}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error(`Square schedule fetch error for ${date}:`, e.message);
    return null;
  }
}


// ── Build context for Claude ─────────────────────────────────────────────────

function formatSFContext(date, data) {
  if (!data) return `\nSF (${date}): No data available.\n`;

  const m = data.metrics;
  const day = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' });
  const isWE = ['Saturday', 'Sunday'].includes(day);
  const bench = isWE ? SF_BENCH.weekend : SF_BENCH.weekday;

  let ctx = `\n=== SF / SAN FRANCISCO — ${day}, ${date} ===\n`;
  ctx += `Benchmarks: ${isWE ? 'Weekend' : 'Weekday'} avg sales $${bench.sales}, SPLH $${bench.splh}\n`;
  ctx += `Net Sales: $${(m.net_sales || 0).toFixed(2)}\n`;
  ctx += `Tickets: ${m.transaction_count || 0} | Avg Check: $${(m.average_check || 0).toFixed(2)}\n`;
  ctx += `SPLH: $${(m.splh || 0).toFixed(2)}\n`;

  // Mochi
  if (m.mochi) {
    ctx += `Mochi Attachment Rate: ${(m.mochi.attachment_rate || 0).toFixed(1)}% (target: 25%)\n`;
    ctx += `Mochi Revenue: $${(m.mochi.total_revenue || 0).toFixed(2)} | Count: ${m.mochi.total_count || 0}\n`;
    if (m.mochi.by_flavor) {
      ctx += `Mochi Flavors:\n`;
      for (const [name, d] of Object.entries(m.mochi.by_flavor)) {
        ctx += `  ${name}: ${d.count || 0} sold, $${(d.revenue || 0).toFixed(2)}\n`;
      }
    }
  }

  // Labor
  if (m.labor) {
    ctx += `Labor: ${(m.labor.total_hours || 0).toFixed(1)}h total, ${m.labor.unique_employees || 0} employees\n`;
    if (m.labor.shifts) {
      ctx += `Shifts:\n`;
      for (const s of m.labor.shifts) {
        ctx += `  ${s.employee}: ${(s.hours || 0).toFixed(1)}h (${s.clock_in} - ${s.clock_out})\n`;
      }
    }
  }

  // Dayparts
  if (m.dayparts) {
    ctx += `Dayparts:\n`;
    for (const [name, d] of Object.entries(m.dayparts)) {
      ctx += `  ${name}: $${(d.sales || 0).toFixed(2)} sales, ${d.tickets || 0} tickets\n`;
    }
  }

  return ctx;
}

function formatBostonContext(date, data) {
  if (!data) return `\nBoston (${date}): No data available.\n`;

  const m = data.metrics;
  const day = data.day_of_week || new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
  const isWE = ['Saturday', 'Sunday'].includes(day);
  const bench = isWE ? BOS_BENCH.weekend : BOS_BENCH.weekday;

  let ctx = `\n=== BOSTON / CHARLESTOWN — ${day}, ${date} ===\n`;
  ctx += `Benchmarks: ${isWE ? 'Weekend' : 'Weekday'} avg sales $${bench.sales}, SPLH $${bench.splh}\n`;
  ctx += `Net Sales: $${(m.net_sales || 0).toFixed(2)}\n`;
  ctx += `Total Orders: ${m.total_orders || 0} | Avg Check: $${(m.avg_check || 0).toFixed(2)}\n`;
  ctx += `Gross Sales: $${(m.gross_sales || 0).toFixed(2)} | Discounts: $${(m.total_discount || 0).toFixed(2)}\n`;
  ctx += `Tips: $${(m.total_tip || 0).toFixed(2)} | Tax: $${(m.total_tax || 0).toFixed(2)}\n`;

  // SPLH
  if (data.splh) {
    ctx += `SPLH: $${(data.splh.splh || 0).toFixed(2)} | Labor Cost: $${(data.splh.total_labor_cost || 0).toFixed(2)} | Labor %: ${(data.splh.labor_percentage || 0).toFixed(1)}%\n`;
  }

  // Mochi
  if (m.mochi) {
    ctx += `Mochi Attachment Rate: ${(m.mochi.attachment_rate || 0).toFixed(1)}% (target: 25%)\n`;
    ctx += `Mochi Revenue: $${(m.mochi.mochi_revenue || 0).toFixed(2)} | Count: ${m.mochi.total_mochi_items || 0}\n`;
    if (m.mochi.flavors) {
      ctx += `Mochi Flavors:\n`;
      for (const [name, d] of Object.entries(m.mochi.flavors)) {
        ctx += `  ${name}: ${d.count || 0} sold, $${(d.revenue || 0).toFixed(2)}\n`;
      }
    }
  }

  // Labor
  if (data.labor) {
    ctx += `Labor: ${(data.labor.total_hours || 0).toFixed(1)}h total, ${data.labor.total_shifts || 0} shifts\n`;
    ctx += `Labor Cost: $${(data.labor.total_labor_cost || 0).toFixed(2)} | Avg Rate: $${(data.labor.avg_hourly_cost || 0).toFixed(2)}/hr\n`;
    if (data.labor.team) {
      ctx += `Team:\n`;
      for (const [name, d] of Object.entries(data.labor.team)) {
        ctx += `  ${name}: ${(d.hours || 0).toFixed(1)}h @ $${(d.hourly_rate || 0).toFixed(2)}/hr = $${(d.cost || 0).toFixed(2)}\n`;
      }
    }
  }

  // Categories
  if (m.categories) {
    ctx += `Categories:\n`;
    for (const [name, d] of Object.entries(m.categories)) {
      ctx += `  ${name}: ${d.count || 0} items, $${(d.revenue || 0).toFixed(2)}\n`;
    }
  }

  // Hourly
  if (m.hourly) {
    ctx += `Hourly Breakdown:\n`;
    for (const [hour, d] of Object.entries(m.hourly)) {
      ctx += `  ${hour}: ${d.orders || 0} orders, ${d.items || 0} items, $${(d.revenue || 0).toFixed(2)}\n`;
    }
  }

  // Items sold
  if (m.items) {
    ctx += `Items Sold:\n`;
    const sorted = Object.entries(m.items).sort((a, b) => b[1].count - a[1].count);
    for (const [name, d] of sorted) {
      ctx += `  ${name}: ${d.count || 0} sold, $${(d.revenue || 0).toFixed(2)}\n`;
    }
  }

  return ctx;
}

function formatFerryContext(date, data) {
  if (!data) return `\nFerry Building (${date}): No data available.\n`;

  const m = data.metrics;
  const day = data.day_of_week || new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });

  let ctx = `\n=== SF / FERRY BUILDING — ${day}, ${date} ===\n`;
  ctx += `Net Sales: $${(m.net_sales || 0).toFixed(2)}\n`;
  ctx += `Total Orders: ${m.total_orders || 0} | Avg Check: $${(m.avg_check || 0).toFixed(2)}\n`;
  ctx += `Gross Sales: $${(m.gross_sales || 0).toFixed(2)} | Discounts: $${(m.total_discount || 0).toFixed(2)}\n`;
  ctx += `Tips: $${(m.total_tip || 0).toFixed(2)} | Tax: $${(m.total_tax || 0).toFixed(2)}\n`;

  if (data.splh) {
    ctx += `SPLH: $${(data.splh.splh || 0).toFixed(2)} | Labor Cost: $${(data.splh.total_labor_cost || 0).toFixed(2)} | Labor %: ${(data.splh.labor_percentage || 0).toFixed(1)}%\n`;
  }

  if (m.mochi) {
    ctx += `Mochi Attachment Rate: ${(m.mochi.attachment_rate || 0).toFixed(1)}% (target: 25%)\n`;
    ctx += `Mochi Revenue: $${(m.mochi.mochi_revenue || 0).toFixed(2)} | Count: ${m.mochi.total_mochi_items || 0}\n`;
    if (m.mochi.flavors) {
      ctx += `Mochi Flavors:\n`;
      for (const [name, d] of Object.entries(m.mochi.flavors)) {
        ctx += `  ${name}: ${d.count || 0} sold, $${(d.revenue || 0).toFixed(2)}\n`;
      }
    }
  }

  if (data.labor) {
    ctx += `Labor: ${(data.labor.total_hours || 0).toFixed(1)}h total, ${data.labor.total_shifts || 0} shifts\n`;
    ctx += `Labor Cost: $${(data.labor.total_labor_cost || 0).toFixed(2)}\n`;
    if (data.labor.team) {
      ctx += `Team:\n`;
      for (const [name, d] of Object.entries(data.labor.team)) {
        ctx += `  ${name}: ${(d.hours || 0).toFixed(1)}h @ $${(d.hourly_rate || 0).toFixed(2)}/hr = $${(d.cost || 0).toFixed(2)}\n`;
      }
    }
  }

  if (m.categories) {
    ctx += `Categories:\n`;
    for (const [name, d] of Object.entries(m.categories)) {
      ctx += `  ${name}: ${d.count || 0} items, $${(d.revenue || 0).toFixed(2)}\n`;
    }
  }

  return ctx;
}

function formatScheduleContext(location, date, data) {
  if (!data) return '';
  const shifts = data.shifts || [];
  if (shifts.length === 0) return '';

  const totalHours = shifts.reduce((sum, s) => sum + (s.duration || 0), 0);
  let ctx = `\n${location} Schedule (${date}): ${shifts.length} shifts, ${totalHours.toFixed(1)}h\n`;
  for (const s of shifts.sort((a, b) => (a.start || '').localeCompare(b.start || ''))) {
    const st = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: location === 'SF' ? 'America/Los_Angeles' : 'America/New_York' });
    const et = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: location === 'SF' ? 'America/Los_Angeles' : 'America/New_York' });
    ctx += `  ${s.employee} — ${s.position || 'Team Member'} (${st}-${et}) ${(s.duration || 0).toFixed(1)}h\n`;
  }
  return ctx;
}


// ── Fetch all data for a date range ──────────────────────────────────────────

async function fetchAllData(startDate, endDate, location) {
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  let context = '';

  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toLocaleDateString('en-CA');

    if (location === 'sf' || location === 'all') {
      const toastData = await fetchToastData(dateStr);
      context += formatSFContext(dateStr, toastData);
      const sfSched = await fetchSFSchedule(dateStr);
      context += formatScheduleContext('SF Clement', dateStr, sfSched);
    }

    if (location === 'boston' || location === 'all') {
      const squareData = await fetchSquareData(dateStr);
      context += formatBostonContext(dateStr, squareData);
      const bosSched = await fetchBostonSchedule(dateStr);
      context += formatScheduleContext('Boston', dateStr, bosSched);
    }

    if (location === 'ferry' || location === 'all') {
      const ferryData = await fetchFerryData(dateStr);
      context += formatFerryContext(dateStr, ferryData);
    }

    current.setDate(current.getDate() + 1);
  }

  return context || 'No data available for the requested dates and location(s).';
}


// ── Ask Claude ───────────────────────────────────────────────────────────────

async function askClaude(userMessage, dataContext) {
  if (!ANTHROPIC_API_KEY) {
    console.error('No ANTHROPIC_API_KEY set');
    return null;
  }

  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const todayStr = pst.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const timeStr = pst.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const systemPrompt = `You are the Pixlcat business intelligence assistant in Slack. You answer questions about sales, mochi, labor, scheduling, and operations across both Pixlcat locations.

LOCATIONS:
- SF / San Francisco / Clement: 519 Clement St, Inner Richmond. POS: Toast. Scheduling: Sling. Timezone: Pacific.
- SF / Ferry Building: San Francisco Ferry Building. POS: Square. No scheduling yet. Timezone: Pacific. New location. Open Saturdays only, 8am-2pm.
- Boston / Charlestown: New location. POS: Square. Scheduling: Square. Timezone: Eastern.

Current date/time: ${todayStr}, ${timeStr} PT

BUSINESS CONTEXT:
- Butter mochi is the signature product. Target attachment rate: 25%.
- SF benchmarks: Weekday avg $1,807 sales, $96 SPLH. Weekend avg $3,610 sales, $111 SPLH.
- Boston benchmarks: Weekday avg $500 sales, $25 SPLH. Weekend avg $800 sales, $40 SPLH.
- SF dayparts: Warmup 7-8am, Rush 8-11am, Core 11am-2pm, Drift 2-4pm, Dead 4-5pm.
- Boston is newer, still ramping up.
- Sat-Sun = ~47% of weekly revenue in SF. Sunday is typically peak.
- Key metrics: Net sales, mochi attachment rate, SPLH, avg check, labor hours.

DATA:
${dataContext}

RULES:
- Use ONLY Slack mrkdwn formatting. NEVER use markdown headers (#, ##, ###) — they don't render in Slack.
- For section headers, use *bold* with emoji: e.g. *☕ SF / SAN FRANCISCO — Wednesday, Feb 11*
- Use *bold* for labels and emphasis, _italic_ for secondary info
- Use • for bullet points, not - or *
- Separate sections with a blank line
- Be concise and analytical — this is a CEO dashboard channel
- When comparing to benchmarks, show: value (delta vs benchmark, ±%)
- Use 🟢 for above benchmark/target, 🔴 for below
- Calculate percentages, deltas, and trends when data supports it
- If asked for a "brief" or "report", format like this example:

*☕ SF / SAN FRANCISCO — Wednesday, Feb 11, 2026*

🟢 *Net Sales:* $1,669.15 (+$62.15 vs $1,607 avg, +3.9%)
🧾 *Tickets:* 152 | *Avg Check:* $10.98
🟢 *Mochi Attachment:* 26.3% (+1.3% vs 25% target) | $313.50 rev | 48 pieces
🔴 *SPLH:* $87.03 | *Labor:* 19.2h

*Top Mochi Flavors:* Classic (12), Black Sesame (9), Ube (7)

- If data is missing or unavailable, say so — never make up numbers
- For multi-day queries, summarize totals and highlight best/worst days
- Round dollar amounts to 2 decimal places
- Keep answers focused — don't dump all data unless asked for a full report
- End briefs/reports with *Key Takeaways:* section (2-3 bullet points max)
- If the question has nothing to do with Pixlcat operations, politely redirect`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Claude API error: ${res.status} - ${errText}`);
      return null;
    }

    const data = await res.json();
    return data.content[0].text;
  } catch (e) {
    console.error('Claude API request error:', e.message);
    return null;
  }
}


// ── Reply in Slack ───────────────────────────────────────────────────────────

async function replyInOpsChannel(channel, threadTs, text) {
  if (!SLACK_BOT_TOKEN) {
    console.error('No SLACK_BOT_TOKEN for ops reply');
    return;
  }
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        thread_ts: threadTs,
        text,
        mrkdwn: true,
        unfurl_links: false,
      }),
    });
    const result = await res.json();
    if (!result.ok) console.error('Ops reply error:', result.error);
  } catch (e) {
    console.error('Ops reply fetch error:', e.message);
  }
}


// ── Main handler ─────────────────────────────────────────────────────────────

async function handleOpsQuery(messageText, channel, threadTs) {
  if (!ANTHROPIC_API_KEY) {
    console.log('[ops] No ANTHROPIC_API_KEY, skipping');
    return false;
  }

  try {
    const { startDate, endDate } = determineDateRange(messageText);
    const location = detectLocation(messageText);

    console.log(`[ops] Query: "${messageText}" -> ${startDate} to ${endDate}, location: ${location}`);

    const dataContext = await fetchAllData(startDate, endDate, location);
    const response = await askClaude(messageText, dataContext);

    if (response) {
      await replyInOpsChannel(channel, threadTs, response);
      console.log('[ops] Claude responded');
      return true;
    }

    return false;
  } catch (e) {
    console.error('[ops] Error:', e.message);
    return false;
  }
}

module.exports = { handleOpsQuery, determineDateRange, detectLocation, fetchAllData, askClaude, generateWeeklyReport };


// ── Weekly Report Generator ──────────────────────────────────────────────────

async function generateWeeklyReport() {
  if (!ANTHROPIC_API_KEY) {
    console.error('[weekly] No ANTHROPIC_API_KEY');
    return null;
  }

  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = new Date(pst.getFullYear(), pst.getMonth(), pst.getDate());
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const fmt = (d) => d.toLocaleDateString('en-CA');

  // Last week = Mon-Sun ending yesterday (or most recent Sunday)
  const dow = today.getDay();
  const lastSunday = addDays(today, dow === 0 ? -7 : -dow);
  const lastMonday = addDays(lastSunday, -6);
  
  // Previous week = the week before last
  const prevSunday = addDays(lastMonday, -1);
  const prevMonday = addDays(prevSunday, -6);

  console.log(`[weekly] Last week: ${fmt(lastMonday)} to ${fmt(lastSunday)}`);
  console.log(`[weekly] Prev week: ${fmt(prevMonday)} to ${fmt(prevSunday)}`);

  // Fetch raw data for both weeks, both locations
  const lastWeekSF = [];
  const lastWeekBOS = [];
  const prevWeekSF = [];
  const prevWeekBOS = [];

  for (let i = 0; i < 7; i++) {
    const lwDate = fmt(addDays(lastMonday, i));
    const pwDate = fmt(addDays(prevMonday, i));

    const [lwToast, lwSquare, pwToast, pwSquare] = await Promise.all([
      fetchToastData(lwDate),
      fetchSquareData(lwDate),
      fetchToastData(pwDate),
      fetchSquareData(pwDate),
    ]);

    lastWeekSF.push({ date: lwDate, data: lwToast });
    lastWeekBOS.push({ date: lwDate, data: lwSquare });
    prevWeekSF.push({ date: pwDate, data: pwToast });
    prevWeekBOS.push({ date: pwDate, data: pwSquare });
  }

  // Aggregate weekly totals
  function aggregateToast(days) {
    let sales = 0, tickets = 0, mochiCount = 0, mochiRev = 0, mochiTxns = 0, hours = 0, totalTxns = 0;
    const dailyData = [];
    const flavorTotals = {};

    for (const { date, data } of days) {
      if (!data) continue;
      const m = data.metrics;
      const daySales = m.net_sales || 0;
      sales += daySales;
      tickets += m.transaction_count || 0;
      totalTxns += m.transaction_count || 0;
      hours += m.labor?.total_hours || 0;
      mochiCount += m.mochi?.total_count || 0;
      mochiRev += m.mochi?.total_revenue || 0;
      mochiTxns += m.mochi?.transactions_with_mochi || 0;

      if (m.mochi?.by_flavor) {
        for (const [name, d] of Object.entries(m.mochi.by_flavor)) {
          if (!flavorTotals[name]) flavorTotals[name] = { count: 0, revenue: 0 };
          flavorTotals[name].count += d.count || 0;
          flavorTotals[name].revenue += d.revenue || 0;
        }
      }

      const dayName = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      dailyData.push({ date, dayName, sales: daySales, mochi_att: m.mochi?.attachment_rate || 0, splh: m.splh || 0 });
    }

    const avgCheck = tickets > 0 ? sales / tickets : 0;
    const splh = hours > 0 ? sales / hours : 0;
    const mochiAtt = totalTxns > 0 ? (mochiTxns / totalTxns * 100) : 0;

    return { sales, tickets, avgCheck, splh, hours, mochiCount, mochiRev, mochiAtt, mochiTxns, dailyData, flavorTotals, daysWithData: days.filter(d => d.data).length };
  }

  function aggregateSquare(days) {
    let sales = 0, orders = 0, mochiCount = 0, mochiRev = 0, mochiOrders = 0, hours = 0, laborCost = 0;
    const dailyData = [];
    const flavorTotals = {};

    for (const { date, data } of days) {
      if (!data) continue;
      const m = data.metrics;
      const daySales = m.net_sales || 0;
      sales += daySales;
      orders += m.total_orders || 0;
      hours += data.labor?.total_hours || 0;
      laborCost += data.labor?.total_labor_cost || 0;
      mochiCount += m.mochi?.total_mochi_items || 0;
      mochiRev += m.mochi?.mochi_revenue || 0;
      mochiOrders += m.mochi?.orders_with_mochi || 0;

      if (m.mochi?.flavors) {
        for (const [name, d] of Object.entries(m.mochi.flavors)) {
          if (!flavorTotals[name]) flavorTotals[name] = { count: 0, revenue: 0 };
          flavorTotals[name].count += d.count || 0;
          flavorTotals[name].revenue += d.revenue || 0;
        }
      }

      const dayName = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      dailyData.push({ date, dayName, sales: daySales, mochi_att: m.mochi?.attachment_rate || 0, splh: data.splh?.splh || 0 });
    }

    const avgCheck = orders > 0 ? sales / orders : 0;
    const splh = hours > 0 ? sales / hours : 0;
    const mochiAtt = orders > 0 ? (mochiOrders / orders * 100) : 0;

    return { sales, orders, avgCheck, splh, hours, laborCost, mochiCount, mochiRev, mochiAtt, mochiOrders, dailyData, flavorTotals, daysWithData: days.filter(d => d.data).length };
  }

  const lwSF = aggregateToast(lastWeekSF);
  const pwSF = aggregateToast(prevWeekSF);
  const lwBOS = aggregateSquare(lastWeekBOS);
  const pwBOS = aggregateSquare(prevWeekBOS);

  // Build context string for Claude
  const lwLabel = `${lastMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${lastSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const pwLabel = `${prevMonday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${prevSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

  let context = `=== WEEKLY REPORT DATA ===\n`;
  context += `Last Week: ${lwLabel} | Previous Week: ${pwLabel}\n\n`;

  context += `--- SF LAST WEEK (${lwLabel}) ---\n`;
  context += `Total Sales: $${lwSF.sales.toFixed(2)} (${lwSF.daysWithData} days with data)\n`;
  context += `Tickets: ${lwSF.tickets} | Avg Check: $${lwSF.avgCheck.toFixed(2)}\n`;
  context += `SPLH: $${lwSF.splh.toFixed(2)} | Labor Hours: ${lwSF.hours.toFixed(1)}h\n`;
  context += `Mochi: ${lwSF.mochiCount} pieces, $${lwSF.mochiRev.toFixed(2)} rev, ${lwSF.mochiAtt.toFixed(1)}% attachment\n`;
  context += `Daily: ${lwSF.dailyData.map(d => `${d.dayName} $${d.sales.toFixed(0)}`).join(', ')}\n`;
  context += `Top Flavors: ${Object.entries(lwSF.flavorTotals).sort((a, b) => b[1].count - a[1].count).map(([n, d]) => `${n}(${d.count})`).join(', ')}\n\n`;

  context += `--- SF PREVIOUS WEEK (${pwLabel}) ---\n`;
  context += `Total Sales: $${pwSF.sales.toFixed(2)} (${pwSF.daysWithData} days with data)\n`;
  context += `Tickets: ${pwSF.tickets} | Avg Check: $${pwSF.avgCheck.toFixed(2)}\n`;
  context += `SPLH: $${pwSF.splh.toFixed(2)} | Labor Hours: ${pwSF.hours.toFixed(1)}h\n`;
  context += `Mochi: ${pwSF.mochiCount} pieces, $${pwSF.mochiRev.toFixed(2)} rev, ${pwSF.mochiAtt.toFixed(1)}% attachment\n`;
  context += `Daily: ${pwSF.dailyData.map(d => `${d.dayName} $${d.sales.toFixed(0)}`).join(', ')}\n\n`;

  context += `--- BOSTON LAST WEEK (${lwLabel}) ---\n`;
  context += `Total Sales: $${lwBOS.sales.toFixed(2)} (${lwBOS.daysWithData} days with data)\n`;
  context += `Orders: ${lwBOS.orders} | Avg Check: $${lwBOS.avgCheck.toFixed(2)}\n`;
  context += `SPLH: $${lwBOS.splh.toFixed(2)} | Labor Hours: ${lwBOS.hours.toFixed(1)}h | Labor Cost: $${lwBOS.laborCost.toFixed(2)}\n`;
  context += `Mochi: ${lwBOS.mochiCount} pieces, $${lwBOS.mochiRev.toFixed(2)} rev, ${lwBOS.mochiAtt.toFixed(1)}% attachment\n`;
  context += `Daily: ${lwBOS.dailyData.map(d => `${d.dayName} $${d.sales.toFixed(0)}`).join(', ')}\n`;
  context += `Top Flavors: ${Object.entries(lwBOS.flavorTotals).sort((a, b) => b[1].count - a[1].count).map(([n, d]) => `${n}(${d.count})`).join(', ')}\n\n`;

  context += `--- BOSTON PREVIOUS WEEK (${pwLabel}) ---\n`;
  context += `Total Sales: $${pwBOS.sales.toFixed(2)} (${pwBOS.daysWithData} days with data)\n`;
  context += `Orders: ${pwBOS.orders} | Avg Check: $${pwBOS.avgCheck.toFixed(2)}\n`;
  context += `SPLH: $${pwBOS.splh.toFixed(2)} | Labor Hours: ${pwBOS.hours.toFixed(1)}h | Labor Cost: $${pwBOS.laborCost.toFixed(2)}\n`;
  context += `Mochi: ${pwBOS.mochiCount} pieces, $${pwBOS.mochiRev.toFixed(2)} rev, ${pwBOS.mochiAtt.toFixed(1)}% attachment\n`;
  context += `Daily: ${pwBOS.dailyData.map(d => `${d.dayName} $${d.sales.toFixed(0)}`).join(', ')}\n\n`;

  context += `--- COMBINED TOTALS ---\n`;
  context += `Last Week Combined Sales: $${(lwSF.sales + lwBOS.sales).toFixed(2)}\n`;
  context += `Previous Week Combined Sales: $${(pwSF.sales + pwBOS.sales).toFixed(2)}\n`;
  context += `Last Week Combined Mochi: ${lwSF.mochiCount + lwBOS.mochiCount} pieces, $${(lwSF.mochiRev + lwBOS.mochiRev).toFixed(2)}\n`;

  // Ask Claude to generate the report
  const reportPrompt = `Generate a weekly performance report comparing last week to the previous week. Use ONLY Slack mrkdwn formatting (NEVER use # headers).

Format it like this structure:

*📊 WEEKLY REPORT — [last week date range]*

*☕ SF / SAN FRANCISCO*
Use a table-like format showing key metrics with WoW (week-over-week) deltas:
- Net Sales with $ and % change
- Tickets/Orders with change  
- Avg Check with change
- SPLH with change
- Mochi attachment % with change
- Mochi count & revenue with change
- Best and worst day of the week
- Top 3 mochi flavors

*🦞 BOSTON / CHARLESTOWN*
Same format as SF

*📈 COMBINED / COMPANY-WIDE*
- Total combined sales with WoW change
- Total mochi pieces and revenue
- Which location grew more

*🎯 KEY TAKEAWAYS*
- 3-4 bullet points: wins, concerns, and one action item
- Be specific with numbers
- Flag any metric that moved more than ±10% WoW`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: `You are the Pixlcat business intelligence assistant. Generate a weekly performance report for the CEO. Use ONLY Slack mrkdwn formatting — NEVER use markdown headers (#, ##). Use *bold* with emoji for section headers. Use 🟢 for improvements and 🔴 for declines. Be analytical and specific.

BENCHMARKS:
SF: Weekday avg $1,807/day, Weekend avg $3,610/day, SPLH $96 weekday/$111 weekend
Boston: Weekday avg $500/day, Weekend avg $800/day, SPLH $25 weekday/$40 weekend
Mochi target: 25% attachment rate at both locations

DATA:
${context}`,
        messages: [{ role: 'user', content: reportPrompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[weekly] Claude API error: ${res.status} - ${errText}`);
      return null;
    }

    const data = await res.json();
    return data.content[0].text;
  } catch (e) {
    console.error('[weekly] Claude error:', e.message);
    return null;
  }
}
