const { WebClient } = require('@slack/web-api');

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const CHANNEL = process.env.SLACK_CHANNEL_ID;
const TOAST_URL = process.env.TOAST_API_URL || 'https://toast-api-1.onrender.com';
const SQUARE_URL = process.env.SQUARE_API_URL || 'https://square-api-mi4f.onrender.com';
const SLING_URL = process.env.SLING_API_URL || 'https://pixlcat-sling-api.onrender.com';

// SF benchmarks (established)
const SF_BENCH = {
  weekday: { sales: 1807, splh: 96 },
  weekend: { sales: 3610, splh: 111 }
};

// Boston benchmarks (early stage)
const BOS_BENCH = {
  weekday: { sales: 500, splh: 25 },
  weekend: { sales: 800, splh: 40 }
};

const fmt = n => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const ico = (v, target) => v >= target ? '🟢' : '🔴';

function fmtTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles'
  }).toLowerCase();
}

function fmtTimeET(isoStr) {
  return new Date(isoStr).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
  }).toLowerCase();
}

function today() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', timeZone: 'America/Los_Angeles'
  });
}

// ─── Sling Schedule ──────────────────────────────────────

async function fetchSchedule(dateStr) {
  try {
    const endpoint = dateStr ? '/schedule/' + dateStr : '/schedule/today';
    const res = await fetch(SLING_URL + endpoint);
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch (e) {
    console.error('Sling schedule error:', e.message);
    return null;
  }
}

function formatScheduleSection(schedule, dateStr) {
  if (!schedule || !schedule.shifts || schedule.shifts.length === 0) return '';

  const targetDate = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const shifts = schedule.shifts
    .filter(s => {
      const shiftDate = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      return shiftDate === targetDate;
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  if (shifts.length === 0) return '';

  const clement = shifts.filter(s => (s.location || '').includes('Clement'));
  const ninth = shifts.filter(s => (s.location || '').includes('9th'));
  const totalHours = shifts.reduce((sum, s) => sum + (s.duration || 0), 0);

  let msg = `\n*Scheduled:* ${shifts.length} shifts | ${totalHours.toFixed(1)}h total\n`;

  if (clement.length > 0) {
    for (const s of clement) {
      msg += `  ${fmtTime(s.start)}-${fmtTime(s.end)}  ${s.employee} _(${s.position})_\n`;
    }
  }

  if (ninth.length > 0) {
    msg += `  _9th St:_\n`;
    for (const s of ninth) {
      msg += `  ${fmtTime(s.start)}-${fmtTime(s.end)}  ${s.employee} _(${s.position})_\n`;
    }
  }

  return msg;
}

// ─── SF (Toast API) ──────────────────────────────────────

async function fetchSF() {
  const res = await fetch(TOAST_URL + '/sales/yesterday');
  if (!res.ok) throw new Error('Toast /sales/yesterday -> ' + res.status);
  const data = await res.json();
  if (data.status !== 'success') throw new Error('Toast API error: ' + data.status);

  const m = data.metrics;
  const date = data.date;
  const day = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
  const isWE = ['Saturday', 'Sunday'].includes(day);
  const bench = isWE ? SF_BENCH.weekend : SF_BENCH.weekday;

  const sales = m.net_sales || 0;
  const tix = m.transaction_count || 0;
  const avgChk = m.average_check || 0;
  const splh = m.splh || 0;
  const mochiAtt = m.mochi?.attachment_rate || 0;
  const mochiRev = m.mochi?.total_revenue || 0;
  const mochiCount = m.mochi?.total_count || 0;
  const totalHours = m.labor?.total_hours || 0;
  const delta = ((sales - bench.sales) / bench.sales * 100).toFixed(1);

  let msg = `*☕ SAN FRANCISCO — ${day}, ${date}*\n\n`;
  msg += `${ico(sales, bench.sales)} *Net Sales:* ${fmt(sales)} (${delta > 0 ? '+' : ''}${delta}% vs ${isWE ? 'weekend' : 'weekday'} avg)\n`;
  msg += `🧾 *Tickets:* ${tix} | *Avg Check:* ${fmt(avgChk)}\n`;
  msg += `${ico(mochiAtt, 25)} *Mochi Attachment:* ${mochiAtt.toFixed(1)}% (target: 25%) | ${fmt(mochiRev)} rev | ${mochiCount} pieces\n`;

  if (totalHours > 0) {
    msg += `${ico(splh, bench.splh)} *SPLH:* ${fmt(splh)} | *Labor:* ${totalHours.toFixed(1)}h\n`;
  }

  // Labor report
  const shifts = m.labor?.shifts || [];
  if (shifts.length > 0) {
    msg += `\n*Labor Report:*\n`;
    shifts.sort((a, b) => (b.hours || 0) - (a.hours || 0));
    for (const s of shifts) {
      msg += `  • ${s.employee}: ${(s.hours || 0).toFixed(1)}h\n`;
    }
    msg += `  *Total: ${totalHours.toFixed(1)}h across ${shifts.length} shifts*\n`;
  }

  // Mochi product mix
  const flavors = m.mochi?.by_flavor || {};
  const flavorList = Object.entries(flavors)
    .map(([name, d]) => ({ name, count: d.count || 0, revenue: d.revenue || 0 }))
    .filter(f => f.count > 0 || f.revenue > 0)
    .sort((a, b) => b.count - a.count);

  if (flavorList.length > 0) {
    msg += `\n*Mochi Product Mix:*\n`;
    for (const f of flavorList) {
      const pct = mochiCount > 0 ? ((f.count / mochiCount) * 100).toFixed(0) : 0;
      msg += `  • ${f.name}: ${f.count} sold (${pct}%) — ${fmt(f.revenue)}\n`;
    }
  }

  return { msg, date, day };
}

// ─── BOSTON (Square API) ──────────────────────────────────

async function fetchBoston() {
  const res = await fetch(SQUARE_URL + '/sales/yesterday');
  if (!res.ok) throw new Error('Square /sales/yesterday -> ' + res.status);
  const data = await res.json();
  if (data.status !== 'success') throw new Error('Square API error: ' + data.status);

  const m = data.metrics;
  const date = data.date;
  const day = data.day_of_week || new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
  const isWE = ['Saturday', 'Sunday'].includes(day);
  const bench = isWE ? BOS_BENCH.weekend : BOS_BENCH.weekday;

  const sales = m.net_sales || 0;
  const tix = m.total_orders || 0;
  const avgChk = m.avg_check || 0;
  const mochiAtt = m.mochi?.attachment_rate || 0;
  const mochiRev = m.mochi?.mochi_revenue || 0;
  const mochiCount = m.mochi?.total_mochi_items || 0;
  const splh = data.splh?.splh || 0;
  const totalHours = data.splh?.total_labor_hours || data.labor?.total_hours || 0;
  const laborCost = data.splh?.total_labor_cost || data.labor?.total_labor_cost || 0;
  const laborPct = data.splh?.labor_percentage || 0;
  const delta = ((sales - bench.sales) / bench.sales * 100).toFixed(1);

  let msg = `*🦞 BOSTON / CHARLESTOWN — ${day}, ${date}*\n\n`;
  msg += `${ico(sales, bench.sales)} *Net Sales:* ${fmt(sales)} (${delta > 0 ? '+' : ''}${delta}% vs ${isWE ? 'weekend' : 'weekday'} avg)\n`;
  msg += `🧾 *Tickets:* ${tix} | *Avg Check:* ${fmt(avgChk)}\n`;
  msg += `${ico(mochiAtt, 25)} *Mochi Attachment:* ${mochiAtt.toFixed(1)}% (target: 25%) | ${fmt(mochiRev)} rev | ${mochiCount} pieces\n`;

  if (totalHours > 0) {
    msg += `${ico(splh, bench.splh)} *SPLH:* ${fmt(splh)} | *Labor:* ${totalHours.toFixed(1)}h | *Cost:* ${fmt(laborCost)} (${laborPct.toFixed(1)}%)\n`;
  }

  // Labor report
  const team = data.labor?.team || {};
  const teamList = Object.entries(team)
    .map(([name, d]) => ({ name, hours: d.hours || 0, cost: d.cost || 0, rate: d.hourly_rate || 0 }))
    .sort((a, b) => b.hours - a.hours);

  if (teamList.length > 0) {
    msg += `\n*Labor Report:*\n`;
    for (const t of teamList) {
      msg += `  • ${t.name}: ${t.hours.toFixed(1)}h @ ${fmt(t.rate)}/hr → ${fmt(t.cost)}\n`;
    }
    msg += `  *Total: ${totalHours.toFixed(1)}h | ${fmt(laborCost)} labor cost | Avg ${fmt(data.labor?.avg_hourly_cost || 0)}/hr*\n`;
  }

  // Mochi product mix
  const flavors = m.mochi?.flavors || {};
  const flavorList = Object.entries(flavors)
    .map(([name, d]) => ({ name, count: d.count || 0, revenue: d.revenue || 0 }))
    .filter(f => f.count > 0 || f.revenue > 0)
    .sort((a, b) => b.count - a.count || b.revenue - a.revenue);

  if (flavorList.length > 0) {
    msg += `\n*Mochi Product Mix:*\n`;
    for (const f of flavorList) {
      const pct = mochiCount > 0 ? ((f.count / mochiCount) * 100).toFixed(0) : 0;
      if (f.count > 0) {
        msg += `  • ${f.name}: ${f.count} sold (${pct}%) — ${fmt(f.revenue)}\n`;
      } else {
        msg += `  • ${f.name}: ${fmt(f.revenue)}\n`;
      }
    }
  }

  return { msg, date, day };
}

// ─── Boston Schedule (Square ScheduledShift API) ─────────

async function fetchBostonSchedule(dateStr) {
  try {
    const endpoint = dateStr ? '/schedule/' + dateStr : '/schedule/today';
    const res = await fetch(SQUARE_URL + endpoint);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return data;
  } catch (e) {
    console.error('Boston schedule error:', e.message);
    return null;
  }
}

function formatBostonScheduleSection(scheduleData, dateStr) {
  if (!scheduleData || !scheduleData.shifts || scheduleData.shifts.length === 0) return '';

  const targetDate = dateStr || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const shifts = scheduleData.shifts
    .filter(s => {
      const shiftDate = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return shiftDate === targetDate;
    })
    .sort((a, b) => a.start.localeCompare(b.start));

  if (shifts.length === 0) return '';

  const totalHours = shifts.reduce((sum, s) => sum + (s.duration || 0), 0);
  let msg = `\n*Scheduled:* ${shifts.length} shifts | ${totalHours.toFixed(1)}h total\n`;
  for (const s of shifts) {
    msg += `  ${fmtTimeET(s.start)}-${fmtTimeET(s.end)}  ${s.employee} _(${s.position})_\n`;
  }
  return msg;
}

// ─── MAIN ────────────────────────────────────────────────

async function main() {
  let sfMsg = '', bosMsg = '';
  let date = '', day = '';

  try {
    const sf = await fetchSF();
    sfMsg = sf.msg;
    date = sf.date;
    day = sf.day;
  } catch (e) {
    sfMsg = `*☕ SAN FRANCISCO* — ⚠️ Error: ${e.message}\n`;
    console.error('SF error:', e.message);
  }

  try {
    const bos = await fetchBoston();
    bosMsg = bos.msg;
    if (!date) { date = bos.date; day = bos.day; }
  } catch (e) {
    bosMsg = `*🦞 BOSTON / CHARLESTOWN* — ⚠️ Error: ${e.message}\n`;
    console.error('Boston error:', e.message);
  }

  // Fetch yesterday's Sling schedule (matches sales report date)
  let scheduleMsg = '';
  try {
    const schedule = await fetchSchedule(date);
    scheduleMsg = formatScheduleSection(schedule, date);
  } catch (e) {
    console.error('Schedule error:', e.message);
  }

  // Insert schedule after SF labor report
  if (scheduleMsg) {
    sfMsg += scheduleMsg;
  }

  // Fetch yesterday's Boston schedule from Square
  let bosScheduleMsg = '';
  try {
    const bosSchedule = await fetchBostonSchedule(date);
    bosScheduleMsg = formatBostonScheduleSection(bosSchedule, date);
  } catch (e) {
    console.error('Boston schedule error:', e.message);
  }

  if (bosScheduleMsg) {
    bosMsg += bosScheduleMsg;
  }

  const todayName = today();
  const header = `*📊 Pixlcat Daily Ops Brief — ${day}, ${date}*\n${'─'.repeat(40)}\n\n`;
  const divider = `\n${'─'.repeat(40)}\n\n`;

  // Schedule section label
  let scheduleHeader = '';
  if (scheduleMsg) {
    // Already included in sfMsg above
  }

  const fullMsg = header + sfMsg + divider + bosMsg;

  await slack.chat.postMessage({
    channel: CHANNEL,
    text: fullMsg,
    mrkdwn: true,
    unfurl_links: false
  });

  console.log('Posted combined brief for ' + date);
}

main().catch(e => { console.error(e); process.exit(1); });
