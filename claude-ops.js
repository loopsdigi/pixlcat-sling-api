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
const SLING_URL = process.env.SLING_API_URL || 'https://pixlcat-sling-api.onrender.com';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// SF benchmarks
const SF_BENCH = {
  weekday: { sales: 1807, splh: 96 },
  weekend: { sales: 3610, splh: 111 },
};

// Boston benchmarks
const BOS_BENCH = {
  weekday: { sales: 500, splh: 25 },
  weekend: { sales: 800, splh: 40 },
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
  if (/\b(boston|charlestown|bos|square)\b/.test(t) && /\b(sf|san\s*francisco|clement|richmond|toast)\b/.test(t)) {
    return 'both';
  }
  if (/\b(boston|charlestown|bos)\b/.test(t)) return 'boston';
  if (/\b(sf|san\s*francisco|clement|richmond)\b/.test(t)) return 'sf';
  // Default: both locations
  return 'both';
}


// ── Fetch data from APIs ─────────────────────────────────────────────────────

async function fetchToastData(date) {
  try {
    const res = await fetch(`${TOAST_URL}/sales/${date}`);
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

    if (location === 'sf' || location === 'both') {
      const toastData = await fetchToastData(dateStr);
      context += formatSFContext(dateStr, toastData);
      const sfSched = await fetchSFSchedule(dateStr);
      context += formatScheduleContext('SF', dateStr, sfSched);
    }

    if (location === 'boston' || location === 'both') {
      const squareData = await fetchSquareData(dateStr);
      context += formatBostonContext(dateStr, squareData);
      const bosSched = await fetchBostonSchedule(dateStr);
      context += formatScheduleContext('Boston', dateStr, bosSched);
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
- SF / San Francisco: 519 Clement St, Inner Richmond. POS: Toast. Scheduling: Sling. Timezone: Pacific.
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
- Respond in Slack mrkdwn format (*bold*, _italic_, bullet points with •)
- Be concise and analytical — this is a CEO dashboard channel
- When comparing to benchmarks, note if above/below and by how much
- Calculate percentages, deltas, and trends when the data supports it
- If asked for a "brief" or "report", format like the daily brief with key metrics
- If data is missing or unavailable, say so — never make up numbers
- For multi-day queries, summarize totals and highlight best/worst days
- Round dollar amounts to 2 decimal places
- Use 🟢 for above benchmark, 🔴 for below
- Keep answers focused — don't dump all data unless asked for a full report
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

module.exports = { handleOpsQuery, determineDateRange, detectLocation, fetchAllData, askClaude };
