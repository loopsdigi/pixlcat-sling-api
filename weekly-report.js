/**
 * weekly-report.js — Automated Weekly Summary Report
 * 
 * Aggregates Mon-Sun data from both locations, compares to prior week.
 * Posts to #pixlcat-intelligence-ops every Monday morning.
 * 
 * Metrics per location:
 * - Net sales (total + daily breakdown)
 * - Mochi: count, revenue, attachment rate
 * - Labor: hours, cost, SPLH
 * - Tickets/orders, avg check
 * - Top mochi flavors
 * - Employee hours breakdown
 * 
 * Requires: SLACK_BOT_TOKEN, TOAST_API_URL, SQUARE_API_URL env vars
 */

const TOAST_URL = process.env.TOAST_API_URL || 'https://toast-api-1.onrender.com';
const SQUARE_URL = process.env.SQUARE_API_URL || 'https://square-api-mi4f.onrender.com';
const FERRY_URL = process.env.FERRY_API_URL || 'https://pixlcat-square-ferry.onrender.com';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL = 'C0AEKJ5UFE0';

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const REPORT_RECIPIENTS = [
  'david@pixlcatcoffee.com',
  'hi@pixlcatcoffee.com',
  'dan@sunsetsquares.com',
  'jeff@pixlcatcoffee.com',
];

const nodemailer = require('nodemailer');

const fmt = n => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (v, base) => base === 0 ? '0.0' : ((v - base) / base * 100).toFixed(1);
const delta = (curr, prev) => {
  const diff = curr - prev;
  const sign = diff >= 0 ? '+' : '';
  const p = prev === 0 ? 'N/A' : `${sign}${pct(curr, prev)}%`;
  return `${sign}${fmt(diff)} (${p})`;
};
const deltaNum = (curr, prev, unit = '') => {
  const diff = curr - prev;
  const sign = diff >= 0 ? '+' : '';
  const p = prev === 0 ? 'N/A' : `${sign}${pct(curr, prev)}%`;
  return `${sign}${diff.toFixed(1)}${unit} (${p})`;
};
const ico = (curr, prev) => curr >= prev ? '🟢' : '🔴';

// ── Fetch week of data ───────────────────────────────────────────────────────

async function fetchWeekSF(startDate, endDate) {
  const totals = {
    sales: 0, tickets: 0, mochiCount: 0, mochiRevenue: 0,
    laborHours: 0, employees: new Set(),
    mochiTransactions: 0, totalTransactions: 0,
    flavors: {}, employeeHours: {}, dailySales: [],
    categories: {},
    dayparts: { 'Warmup (7-8am)': 0, 'Rush (8-11am)': 0, 'Core (11am-2pm)': 0, 'Drift (2-4pm)': 0 },
  };

  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  while (current <= end) {
    const dateStr = current.toLocaleDateString('en-CA');
    try {
      const res = await fetch(`${TOAST_URL}/sales?date=${dateStr}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success') {
          const m = data.metrics;
          const day = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });

          totals.sales += m.net_sales || 0;
          totals.tickets += m.transaction_count || 0;
          totals.totalTransactions += m.transaction_count || 0;
          totals.dailySales.push({ day, date: dateStr, sales: m.net_sales || 0 });

          // Mochi
          if (m.mochi) {
            totals.mochiCount += m.mochi.total_count || 0;
            totals.mochiRevenue += m.mochi.total_revenue || 0;
            totals.mochiTransactions += m.mochi.transactions_with_mochi || 0;
            if (m.mochi.by_flavor) {
              for (const [name, d] of Object.entries(m.mochi.by_flavor)) {
                if (!totals.flavors[name]) totals.flavors[name] = { count: 0, revenue: 0 };
                totals.flavors[name].count += d.count || 0;
                totals.flavors[name].revenue += d.revenue || 0;
              }
            }
          }

          // Labor
          if (m.labor) {
            totals.laborHours += m.labor.total_hours || 0;
            for (const s of (m.labor.shifts || [])) {
              totals.employees.add(s.employee);
              if (!totals.employeeHours[s.employee]) totals.employeeHours[s.employee] = 0;
              totals.employeeHours[s.employee] += s.hours || 0;
            }
          }

          // Dayparts
          if (m.dayparts) {
            for (const [name, d] of Object.entries(m.dayparts)) {
              if (totals.dayparts[name] !== undefined) {
                totals.dayparts[name] += d.sales || 0;
              }
            }
          }

          // Categories (from Toast menu group mapping)
          if (m.categories) {
            for (const [name, d] of Object.entries(m.categories)) {
              if (!totals.categories[name]) totals.categories[name] = { count: 0, revenue: 0 };
              totals.categories[name].count += d.count || 0;
              totals.categories[name].revenue += d.revenue || 0;
            }
          }
        }
      }
    } catch (e) {
      console.error(`[weekly] SF fetch error for ${dateStr}:`, e.message);
    }
    current.setDate(current.getDate() + 1);
  }

  totals.avgCheck = totals.tickets > 0 ? totals.sales / totals.tickets : 0;
  totals.splh = totals.laborHours > 0 ? totals.sales / totals.laborHours : 0;
  totals.mochiAttachment = totals.totalTransactions > 0
    ? (totals.mochiTransactions / totals.totalTransactions * 100)
    : 0;
  totals.uniqueEmployees = totals.employees.size;

  return totals;
}

async function fetchWeekBoston(startDate, endDate) {
  const totals = {
    sales: 0, grossSales: 0, orders: 0, tips: 0, tax: 0, discounts: 0,
    mochiCount: 0, mochiRevenue: 0, ordersWithMochi: 0,
    laborHours: 0, laborCost: 0,
    flavors: {}, employeeHours: {}, employeeCosts: {}, dailySales: [],
    categories: {},
  };

  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  while (current <= end) {
    const dateStr = current.toLocaleDateString('en-CA');
    try {
      const res = await fetch(`${SQUARE_URL}/sales/${dateStr}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success') {
          const m = data.metrics;
          const day = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });

          totals.sales += m.net_sales || 0;
          totals.grossSales += m.gross_sales || 0;
          totals.orders += m.total_orders || 0;
          totals.tips += m.total_tip || 0;
          totals.tax += m.total_tax || 0;
          totals.discounts += m.total_discount || 0;
          totals.dailySales.push({ day, date: dateStr, sales: m.net_sales || 0 });

          // Mochi
          if (m.mochi) {
            totals.mochiCount += m.mochi.total_mochi_items || 0;
            totals.mochiRevenue += m.mochi.mochi_revenue || 0;
            totals.ordersWithMochi += m.mochi.orders_with_mochi || 0;
            if (m.mochi.flavors) {
              for (const [name, d] of Object.entries(m.mochi.flavors)) {
                if (!totals.flavors[name]) totals.flavors[name] = { count: 0, revenue: 0 };
                totals.flavors[name].count += d.count || 0;
                totals.flavors[name].revenue += d.revenue || 0;
              }
            }
          }

          // Labor
          if (data.labor) {
            totals.laborHours += data.labor.total_hours || 0;
            totals.laborCost += data.labor.total_labor_cost || 0;
            if (data.labor.team) {
              for (const [name, d] of Object.entries(data.labor.team)) {
                if (!totals.employeeHours[name]) totals.employeeHours[name] = { hours: 0, cost: 0, rate: d.hourly_rate || 0 };
                totals.employeeHours[name].hours += d.hours || 0;
                totals.employeeHours[name].cost += d.cost || 0;
              }
            }
          }

          // Categories
          if (m.categories) {
            for (const [name, d] of Object.entries(m.categories)) {
              if (!totals.categories[name]) totals.categories[name] = { count: 0, revenue: 0 };
              totals.categories[name].count += d.count || 0;
              totals.categories[name].revenue += d.revenue || 0;
            }
          }
        }
      }
    } catch (e) {
      console.error(`[weekly] Boston fetch error for ${dateStr}:`, e.message);
    }
    current.setDate(current.getDate() + 1);
  }

  totals.avgCheck = totals.orders > 0 ? totals.sales / totals.orders : 0;
  totals.splh = totals.laborHours > 0 ? totals.sales / totals.laborHours : 0;
  totals.laborPct = totals.sales > 0 ? (totals.laborCost / totals.sales * 100) : 0;
  totals.mochiAttachment = totals.orders > 0
    ? (totals.ordersWithMochi / totals.orders * 100)
    : 0;

  return totals;
}

async function fetchWeekFerry(startDate, endDate) {
  // Same Square data structure as Boston, different API endpoint
  const totals = {
    sales: 0, grossSales: 0, orders: 0, tips: 0, tax: 0, discounts: 0,
    mochiCount: 0, mochiRevenue: 0, ordersWithMochi: 0,
    laborHours: 0, laborCost: 0,
    flavors: {}, employeeHours: {}, employeeCosts: {}, dailySales: [],
    categories: {},
  };

  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');

  while (current <= end) {
    const dateStr = current.toLocaleDateString('en-CA');
    try {
      const res = await fetch(`${FERRY_URL}/sales/${dateStr}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success') {
          const m = data.metrics;
          const day = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });

          totals.sales += m.net_sales || 0;
          totals.grossSales += m.gross_sales || 0;
          totals.orders += m.total_orders || 0;
          totals.tips += m.total_tip || 0;
          totals.tax += m.total_tax || 0;
          totals.discounts += m.total_discount || 0;
          totals.dailySales.push({ day, date: dateStr, sales: m.net_sales || 0 });

          if (m.mochi) {
            totals.mochiCount += m.mochi.total_mochi_items || 0;
            totals.mochiRevenue += m.mochi.mochi_revenue || 0;
            totals.ordersWithMochi += m.mochi.orders_with_mochi || 0;
            if (m.mochi.flavors) {
              for (const [name, d] of Object.entries(m.mochi.flavors)) {
                if (!totals.flavors[name]) totals.flavors[name] = { count: 0, revenue: 0 };
                totals.flavors[name].count += d.count || 0;
                totals.flavors[name].revenue += d.revenue || 0;
              }
            }
          }

          if (data.labor) {
            totals.laborHours += data.labor.total_hours || 0;
            totals.laborCost += data.labor.total_labor_cost || 0;
            if (data.labor.team) {
              for (const [name, d] of Object.entries(data.labor.team)) {
                if (!totals.employeeHours[name]) totals.employeeHours[name] = { hours: 0, cost: 0, rate: d.hourly_rate || 0 };
                totals.employeeHours[name].hours += d.hours || 0;
                totals.employeeHours[name].cost += d.cost || 0;
              }
            }
          }

          if (m.categories) {
            for (const [name, d] of Object.entries(m.categories)) {
              if (!totals.categories[name]) totals.categories[name] = { count: 0, revenue: 0 };
              totals.categories[name].count += d.count || 0;
              totals.categories[name].revenue += d.revenue || 0;
            }
          }
        }
      }
    } catch (e) {
      console.error(`[weekly] Ferry fetch error for ${dateStr}:`, e.message);
    }
    current.setDate(current.getDate() + 1);
  }

  totals.avgCheck = totals.orders > 0 ? totals.sales / totals.orders : 0;
  totals.splh = totals.laborHours > 0 ? totals.sales / totals.laborHours : 0;
  totals.laborPct = totals.sales > 0 ? (totals.laborCost / totals.sales * 100) : 0;
  totals.mochiAttachment = totals.orders > 0
    ? (totals.ordersWithMochi / totals.orders * 100)
    : 0;

  return totals;
}


// ── Format the report ────────────────────────────────────────────────────────

function getWeekDates(weeksAgo = 0) {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = new Date(pst.getFullYear(), pst.getMonth(), pst.getDate());
  const dow = today.getDay();

  // Monday of the target week
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) - (weeksAgo * 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    startDate: monday.toLocaleDateString('en-CA'),
    endDate: sunday.toLocaleDateString('en-CA'),
    label: `${monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
  };
}

function formatWeeklyReport(currWeek, prevWeek, sfCurr, sfPrev, bosCurr, bosPrev, ferryCurr, ferryPrev) {
  let msg = `*📊 WEEKLY SUMMARY — ${currWeek.label}*\n`;
  msg += `_vs prior week: ${prevWeek.label}_\n\n`;

  // ── Combined Totals ──
  const totalSalesCurr = sfCurr.sales + bosCurr.sales + ferryCurr.sales;
  const totalSalesPrev = sfPrev.sales + bosPrev.sales + ferryPrev.sales;
  const totalMochiCurr = sfCurr.mochiCount + bosCurr.mochiCount + ferryCurr.mochiCount;
  const totalMochiPrev = sfPrev.mochiCount + bosPrev.mochiCount + ferryPrev.mochiCount;
  const totalMochiRevCurr = sfCurr.mochiRevenue + bosCurr.mochiRevenue + ferryCurr.mochiRevenue;
  const totalMochiRevPrev = sfPrev.mochiRevenue + bosPrev.mochiRevenue + ferryPrev.mochiRevenue;
  const totalLaborCurr = sfCurr.laborHours + bosCurr.laborHours + ferryCurr.laborHours;
  const totalLaborPrev = sfPrev.laborHours + bosPrev.laborHours + ferryPrev.laborHours;

  msg += `*🏢 COMBINED TOTALS*\n`;
  msg += `${ico(totalSalesCurr, totalSalesPrev)} *Net Sales:* ${fmt(totalSalesCurr)} | Δ ${delta(totalSalesCurr, totalSalesPrev)}\n`;
  msg += `🍡 *Mochi:* ${totalMochiCurr} pieces (${fmt(totalMochiRevCurr)}) | Δ ${deltaNum(totalMochiCurr, totalMochiPrev, ' pcs')}\n`;
  msg += `⏱️ *Labor:* ${totalLaborCurr.toFixed(1)}h | Δ ${deltaNum(totalLaborCurr, totalLaborPrev, 'h')}\n\n`;

  // ── SF Section ──
  msg += `*☕ SF / SAN FRANCISCO*\n\n`;
  msg += `${ico(sfCurr.sales, sfPrev.sales)} *Net Sales:* ${fmt(sfCurr.sales)} | Δ ${delta(sfCurr.sales, sfPrev.sales)}\n`;
  msg += `🧾 *Tickets:* ${sfCurr.tickets} | *Avg Check:* ${fmt(sfCurr.avgCheck)}\n`;
  msg += `${ico(sfCurr.mochiAttachment, 25)} *Mochi Attachment:* ${sfCurr.mochiAttachment.toFixed(1)}% | ${sfCurr.mochiCount} pcs | ${fmt(sfCurr.mochiRevenue)}\n`;
  msg += `${ico(sfCurr.splh, sfPrev.splh)} *SPLH:* ${fmt(sfCurr.splh)} | *Labor:* ${sfCurr.laborHours.toFixed(1)}h (${sfCurr.uniqueEmployees} employees)\n\n`;

  // SF Daily breakdown
  msg += `*Daily Sales:*\n`;
  for (const d of sfCurr.dailySales) {
    const prevDay = sfPrev.dailySales.find(p => p.day === d.day);
    const prevSales = prevDay ? prevDay.sales : 0;
    msg += `  ${d.day}: ${fmt(d.sales)} ${ico(d.sales, prevSales)} ${prevDay ? `(prev: ${fmt(prevSales)})` : ''}\n`;
  }
  msg += '\n';

  // SF Top mochi flavors
  const sfFlavors = Object.entries(sfCurr.flavors)
    .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
    .filter(f => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (sfFlavors.length > 0) {
    msg += `*Top Mochi:* ${sfFlavors.map(f => `${f.name} (${f.count})`).join(', ')}\n\n`;
  }

  // SF Employee hours
  const sfEmpList = Object.entries(sfCurr.employeeHours)
    .map(([name, hours]) => ({ name, hours }))
    .sort((a, b) => b.hours - a.hours);
  if (sfEmpList.length > 0) {
    msg += `*Team Hours:*\n`;
    for (const e of sfEmpList) {
      const prevHours = sfPrev.employeeHours[e.name] || 0;
      msg += `  • ${e.name}: ${e.hours.toFixed(1)}h ${prevHours > 0 ? `(prev: ${prevHours.toFixed(1)}h)` : ''}\n`;
    }
    msg += '\n';
  }

  // SF categories
  const sfCats = Object.entries(sfCurr.categories || {})
    .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
    .sort((a, b) => b.revenue - a.revenue);
  if (sfCats.length > 0) {
    msg += `*Category Mix:*\n`;
    for (const c of sfCats) {
      const catPct = sfCurr.sales > 0 ? (c.revenue / sfCurr.sales * 100).toFixed(0) : 0;
      msg += `  • ${c.name}: ${fmt(c.revenue)} (${catPct}%) — ${c.count} items\n`;
    }
    msg += '\n';
  }

  // ── Boston Section ──
  msg += `*🦞 BOSTON / CHARLESTOWN*\n\n`;
  msg += `${ico(bosCurr.sales, bosPrev.sales)} *Net Sales:* ${fmt(bosCurr.sales)} | Δ ${delta(bosCurr.sales, bosPrev.sales)}\n`;
  msg += `🧾 *Orders:* ${bosCurr.orders} | *Avg Check:* ${fmt(bosCurr.avgCheck)}\n`;
  msg += `${ico(bosCurr.mochiAttachment, 25)} *Mochi Attachment:* ${bosCurr.mochiAttachment.toFixed(1)}% | ${bosCurr.mochiCount} pcs | ${fmt(bosCurr.mochiRevenue)}\n`;
  msg += `${ico(bosCurr.splh, bosPrev.splh)} *SPLH:* ${fmt(bosCurr.splh)} | *Labor:* ${bosCurr.laborHours.toFixed(1)}h | *Cost:* ${fmt(bosCurr.laborCost)} (${bosCurr.laborPct.toFixed(1)}%)\n`;
  msg += `💰 *Tips:* ${fmt(bosCurr.tips)} | *Discounts:* ${fmt(bosCurr.discounts)}\n\n`;

  // Boston Daily breakdown
  msg += `*Daily Sales:*\n`;
  for (const d of bosCurr.dailySales) {
    const prevDay = bosPrev.dailySales.find(p => p.day === d.day);
    const prevSales = prevDay ? prevDay.sales : 0;
    msg += `  ${d.day}: ${fmt(d.sales)} ${ico(d.sales, prevSales)} ${prevDay ? `(prev: ${fmt(prevSales)})` : ''}\n`;
  }
  msg += '\n';

  // Boston Top mochi flavors
  const bosFlavors = Object.entries(bosCurr.flavors)
    .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
    .filter(f => f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  if (bosFlavors.length > 0) {
    msg += `*Top Mochi:* ${bosFlavors.map(f => `${f.name} (${f.count})`).join(', ')}\n\n`;
  }

  // Boston Employee hours with costs
  const bosEmpList = Object.entries(bosCurr.employeeHours)
    .map(([name, d]) => ({ name, hours: d.hours, cost: d.cost, rate: d.rate }))
    .sort((a, b) => b.hours - a.hours);
  if (bosEmpList.length > 0) {
    msg += `*Team Labor:*\n`;
    for (const e of bosEmpList) {
      const prev = bosPrev.employeeHours[e.name];
      const prevHours = prev ? prev.hours : 0;
      msg += `  • ${e.name}: ${e.hours.toFixed(1)}h @ ${fmt(e.rate)}/hr → ${fmt(e.cost)} ${prevHours > 0 ? `(prev: ${prevHours.toFixed(1)}h)` : ''}\n`;
    }
    msg += `  *Total: ${bosCurr.laborHours.toFixed(1)}h | ${fmt(bosCurr.laborCost)}*\n\n`;
  }

  // Boston categories
  const bosCats = Object.entries(bosCurr.categories)
    .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
    .sort((a, b) => b.revenue - a.revenue);
  if (bosCats.length > 0) {
    msg += `*Category Mix:*\n`;
    for (const c of bosCats) {
      const catPct = bosCurr.sales > 0 ? (c.revenue / bosCurr.sales * 100).toFixed(0) : 0;
      msg += `  • ${c.name}: ${fmt(c.revenue)} (${catPct}%) — ${c.count} items\n`;
    }
    msg += '\n';
  }

  // ── Ferry Building Section ──
  if (ferryCurr.sales > 0 || ferryPrev.sales > 0) {
    msg += `*🌉 SF / FERRY BUILDING*\n\n`;
    msg += `${ico(ferryCurr.sales, ferryPrev.sales)} *Net Sales:* ${fmt(ferryCurr.sales)} | Δ ${delta(ferryCurr.sales, ferryPrev.sales)}\n`;
    msg += `🧾 *Orders:* ${ferryCurr.orders} | *Avg Check:* ${fmt(ferryCurr.avgCheck)}\n`;
    msg += `${ico(ferryCurr.mochiAttachment, 25)} *Mochi Attachment:* ${ferryCurr.mochiAttachment.toFixed(1)}% | ${ferryCurr.mochiCount} pcs | ${fmt(ferryCurr.mochiRevenue)}\n`;
    if (ferryCurr.laborHours > 0) {
      msg += `${ico(ferryCurr.splh, ferryPrev.splh)} *SPLH:* ${fmt(ferryCurr.splh)} | *Labor:* ${ferryCurr.laborHours.toFixed(1)}h | *Cost:* ${fmt(ferryCurr.laborCost)} (${ferryCurr.laborPct.toFixed(1)}%)\n`;
    }
    msg += `💰 *Tips:* ${fmt(ferryCurr.tips)} | *Discounts:* ${fmt(ferryCurr.discounts)}\n\n`;

    if (ferryCurr.dailySales.length > 0) {
      msg += `*Daily Sales:*\n`;
      for (const d of ferryCurr.dailySales) {
        const prevDay = ferryPrev.dailySales.find(p => p.day === d.day);
        const prevSales = prevDay ? prevDay.sales : 0;
        msg += `  ${d.day}: ${fmt(d.sales)} ${ico(d.sales, prevSales)} ${prevDay ? `(prev: ${fmt(prevSales)})` : ''}\n`;
      }
      msg += '\n';
    }

    const ferryFlavors = Object.entries(ferryCurr.flavors)
      .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
      .filter(f => f.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    if (ferryFlavors.length > 0) {
      msg += `*Top Mochi:* ${ferryFlavors.map(f => `${f.name} (${f.count})`).join(', ')}\n\n`;
    }

    // Ferry categories
    const ferryCats = Object.entries(ferryCurr.categories)
      .map(([name, d]) => ({ name, count: d.count, revenue: d.revenue }))
      .sort((a, b) => b.revenue - a.revenue);
    if (ferryCats.length > 0) {
      msg += `*Category Mix:*\n`;
      for (const c of ferryCats) {
        const catPct = ferryCurr.sales > 0 ? (c.revenue / ferryCurr.sales * 100).toFixed(0) : 0;
        msg += `  • ${c.name}: ${fmt(c.revenue)} (${catPct}%) — ${c.count} items\n`;
      }
      msg += '\n';
    }

    const ferryEmpList = Object.entries(ferryCurr.employeeHours)
      .map(([name, d]) => ({ name, hours: d.hours, cost: d.cost, rate: d.rate }))
      .sort((a, b) => b.hours - a.hours);
    if (ferryEmpList.length > 0) {
      msg += `*Team Labor:*\n`;
      for (const e of ferryEmpList) {
        const prev = ferryPrev.employeeHours[e.name];
        const prevHours = prev ? prev.hours : 0;
        msg += `  • ${e.name}: ${e.hours.toFixed(1)}h @ ${fmt(e.rate)}/hr → ${fmt(e.cost)} ${prevHours > 0 ? `(prev: ${prevHours.toFixed(1)}h)` : ''}\n`;
      }
      msg += `  *Total: ${ferryCurr.laborHours.toFixed(1)}h | ${fmt(ferryCurr.laborCost)}*\n\n`;
    }
  }

  return msg;
}


// ── Post to Slack ────────────────────────────────────────────────────────────

async function postWeeklyReport(msg) {
  if (!SLACK_BOT_TOKEN) {
    console.error('[weekly] No SLACK_BOT_TOKEN');
    return false;
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: OPS_CHANNEL, text: msg, mrkdwn: true, unfurl_links: false }),
    });
    const result = await res.json();
    if (!result.ok) console.error('[weekly] Slack error:', result.error);
    return result.ok;
  } catch (e) {
    console.error('[weekly] Slack post error:', e.message);
    return false;
  }
}


// ── HTML Email Formatter ─────────────────────────────────────────────────────

function htmlIco(curr, prev) { return curr >= prev ? '🟢' : '🔴'; }

function formatEmailHTML(currWeek, prevWeek, sfCurr, sfPrev, bosCurr, bosPrev, ferryCurr, ferryPrev) {
  const totalSalesCurr = sfCurr.sales + bosCurr.sales + ferryCurr.sales;
  const totalSalesPrev = sfPrev.sales + bosPrev.sales + ferryPrev.sales;
  const totalMochiCurr = sfCurr.mochiCount + bosCurr.mochiCount + ferryCurr.mochiCount;
  const totalMochiPrev = sfPrev.mochiCount + bosPrev.mochiCount + ferryPrev.mochiCount;
  const totalMochiRevCurr = sfCurr.mochiRevenue + bosCurr.mochiRevenue + ferryCurr.mochiRevenue;
  const totalLaborCurr = sfCurr.laborHours + bosCurr.laborHours + ferryCurr.laborHours;
  const totalLaborPrev = sfPrev.laborHours + bosPrev.laborHours + ferryPrev.laborHours;

  const row = (label, curr, prev, fmtFn = fmt, unit = '') => {
    const d = curr - prev;
    const sign = d >= 0 ? '+' : '';
    const p = prev === 0 ? 'N/A' : `${sign}${((curr - prev) / prev * 100).toFixed(1)}%`;
    const color = curr >= prev ? '#22c55e' : '#ef4444';
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;">${label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${fmtFn(curr)}${unit}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${fmtFn(prev)}${unit}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;color:${color};font-weight:600;">${sign}${fmtFn(Math.abs(d))}${unit} (${p})</td>
    </tr>`;
  };

  const numFmt = n => n.toFixed(1);
  const pctFmt = n => n.toFixed(1) + '%';

  const dailyRows = (dailyCurr, dailyPrev) => {
    return dailyCurr.map(d => {
      const prev = dailyPrev.find(p => p.day === d.day);
      const prevSales = prev ? prev.sales : 0;
      const color = d.sales >= prevSales ? '#22c55e' : '#ef4444';
      return `<tr>
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;">${d.day} (${d.date})</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:600;">${fmt(d.sales)}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;text-align:right;">${fmt(prevSales)}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;text-align:right;color:${color};">${d.sales >= prevSales ? '+' : ''}${fmt(d.sales - prevSales)}</td>
      </tr>`;
    }).join('');
  };

  const empRows = (empList, prevData, showCost = false) => {
    return empList.map(e => {
      const prevHours = typeof prevData[e.name] === 'number' ? prevData[e.name] : (prevData[e.name]?.hours || 0);
      const color = e.hours <= prevHours ? '#22c55e' : '#ef4444';
      return `<tr>
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;">${e.name}</td>
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;text-align:right;">${e.hours.toFixed(1)}h</td>
        ${showCost ? `<td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;text-align:right;">${fmt(e.cost || 0)}</td>` : ''}
        <td style="padding:4px 12px;border-bottom:1px solid #f5f5f5;text-align:right;color:${color};">${prevHours > 0 ? prevHours.toFixed(1) + 'h' : '—'}</td>
      </tr>`;
    }).join('');
  };

  const sfFlavors = Object.entries(sfCurr.flavors)
    .map(([name, d]) => ({ name, count: d.count })).filter(f => f.count > 0)
    .sort((a, b) => b.count - a.count).slice(0, 5);
  const bosFlavors = Object.entries(bosCurr.flavors)
    .map(([name, d]) => ({ name, count: d.count })).filter(f => f.count > 0)
    .sort((a, b) => b.count - a.count).slice(0, 5);

  const sfEmpList = Object.entries(sfCurr.employeeHours)
    .map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours);
  const bosEmpList = Object.entries(bosCurr.employeeHours)
    .map(([name, d]) => ({ name, hours: d.hours, cost: d.cost, rate: d.rate }))
    .sort((a, b) => b.hours - a.hours);

  const tableHeader = `background:#1a1a2e;color:#fff;padding:8px 12px;text-align:left;font-size:13px;`;
  const tableHeaderR = `background:#1a1a2e;color:#fff;padding:8px 12px;text-align:right;font-size:13px;`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7f7f7;margin:0;padding:20px;">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

  <!-- Header -->
  <div style="background:#1a1a2e;padding:28px 32px;">
    <h1 style="color:#fff;margin:0;font-size:22px;">📊 Pixlcat Weekly Report</h1>
    <p style="color:#a0a0c0;margin:6px 0 0;font-size:14px;">${currWeek.label} vs ${prevWeek.label}</p>
  </div>

  <div style="padding:24px 32px;">

    <!-- Combined Totals -->
    <h2 style="color:#1a1a2e;font-size:16px;margin:0 0 12px;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">🏢 Combined Totals</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px;">
      <tr><th style="${tableHeader}">Metric</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${row('Net Sales', totalSalesCurr, totalSalesPrev)}
      ${row('Mochi Pieces', totalMochiCurr, totalMochiPrev, n => n.toFixed(0), '')}
      ${row('Mochi Revenue', totalMochiRevCurr, sfPrev.mochiRevenue + bosPrev.mochiRevenue)}
      ${row('Labor Hours', totalLaborCurr, totalLaborPrev, numFmt, 'h')}
    </table>

    <!-- SF Section -->
    <h2 style="color:#1a1a2e;font-size:16px;margin:0 0 12px;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">☕ SF / San Francisco</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
      <tr><th style="${tableHeader}">Metric</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${row('Net Sales', sfCurr.sales, sfPrev.sales)}
      ${row('Tickets', sfCurr.tickets, sfPrev.tickets, n => n.toFixed(0), '')}
      ${row('Avg Check', sfCurr.avgCheck, sfPrev.avgCheck)}
      ${row('SPLH', sfCurr.splh, sfPrev.splh)}
      ${row('Mochi Attachment', sfCurr.mochiAttachment, sfPrev.mochiAttachment, n => n.toFixed(1), '%')}
      ${row('Mochi Count', sfCurr.mochiCount, sfPrev.mochiCount, n => n.toFixed(0), '')}
      ${row('Mochi Revenue', sfCurr.mochiRevenue, sfPrev.mochiRevenue)}
      ${row('Labor Hours', sfCurr.laborHours, sfPrev.laborHours, numFmt, 'h')}
    </table>

    <p style="font-size:13px;color:#666;margin:0 0 4px;"><strong>Top Mochi:</strong> ${sfFlavors.map(f => `${f.name} (${f.count})`).join(', ')}</p>

    <table style="width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:13px;">
      <tr><th style="${tableHeader}">Day</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${dailyRows(sfCurr.dailySales, sfPrev.dailySales)}
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px;">
      <tr><th style="${tableHeader}">Employee</th><th style="${tableHeaderR}">Hours</th><th style="${tableHeaderR}">Prev Week</th></tr>
      ${empRows(sfEmpList, sfPrev.employeeHours)}
    </table>

    <!-- Boston Section -->
    <h2 style="color:#1a1a2e;font-size:16px;margin:0 0 12px;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">🦞 Boston / Charlestown</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
      <tr><th style="${tableHeader}">Metric</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${row('Net Sales', bosCurr.sales, bosPrev.sales)}
      ${row('Orders', bosCurr.orders, bosPrev.orders, n => n.toFixed(0), '')}
      ${row('Avg Check', bosCurr.avgCheck, bosPrev.avgCheck)}
      ${row('SPLH', bosCurr.splh, bosPrev.splh)}
      ${row('Mochi Attachment', bosCurr.mochiAttachment, bosPrev.mochiAttachment, n => n.toFixed(1), '%')}
      ${row('Mochi Count', bosCurr.mochiCount, bosPrev.mochiCount, n => n.toFixed(0), '')}
      ${row('Mochi Revenue', bosCurr.mochiRevenue, bosPrev.mochiRevenue)}
      ${row('Labor Hours', bosCurr.laborHours, bosPrev.laborHours, numFmt, 'h')}
      ${row('Labor Cost', bosCurr.laborCost, bosPrev.laborCost)}
      ${row('Tips', bosCurr.tips, bosPrev.tips)}
      ${row('Discounts', bosCurr.discounts, bosPrev.discounts)}
    </table>

    <p style="font-size:13px;color:#666;margin:0 0 4px;"><strong>Top Mochi:</strong> ${bosFlavors.map(f => `${f.name} (${f.count})`).join(', ')}</p>

    <table style="width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:13px;">
      <tr><th style="${tableHeader}">Day</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${dailyRows(bosCurr.dailySales, bosPrev.dailySales)}
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px;">
      <tr><th style="${tableHeader}">Employee</th><th style="${tableHeaderR}">Hours</th><th style="${tableHeaderR}">Cost</th><th style="${tableHeaderR}">Prev Hours</th></tr>
      ${empRows(bosEmpList, bosPrev.employeeHours, true)}
      <tr style="font-weight:700;background:#f9f9f9;">
        <td style="padding:6px 12px;">Total</td>
        <td style="padding:6px 12px;text-align:right;">${bosCurr.laborHours.toFixed(1)}h</td>
        <td style="padding:6px 12px;text-align:right;">${fmt(bosCurr.laborCost)}</td>
        <td style="padding:6px 12px;text-align:right;">${bosPrev.laborHours.toFixed(1)}h</td>
      </tr>
    </table>

    ${(ferryCurr.sales > 0 || ferryPrev.sales > 0) ? `
    <!-- Ferry Building Section -->
    <h2 style="color:#1a1a2e;font-size:16px;margin:0 0 12px;border-bottom:2px solid #f0f0f0;padding-bottom:8px;">🌉 SF / Ferry Building</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
      <tr><th style="${tableHeader}">Metric</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${row('Net Sales', ferryCurr.sales, ferryPrev.sales)}
      ${row('Orders', ferryCurr.orders, ferryPrev.orders, n => n.toFixed(0), '')}
      ${row('Avg Check', ferryCurr.avgCheck, ferryPrev.avgCheck)}
      ${ferryCurr.laborHours > 0 ? row('SPLH', ferryCurr.splh, ferryPrev.splh) : ''}
      ${row('Mochi Attachment', ferryCurr.mochiAttachment, ferryPrev.mochiAttachment, n => n.toFixed(1), '%')}
      ${row('Mochi Count', ferryCurr.mochiCount, ferryPrev.mochiCount, n => n.toFixed(0), '')}
      ${row('Mochi Revenue', ferryCurr.mochiRevenue, ferryPrev.mochiRevenue)}
      ${ferryCurr.laborHours > 0 ? row('Labor Hours', ferryCurr.laborHours, ferryPrev.laborHours, numFmt, 'h') : ''}
      ${ferryCurr.laborCost > 0 ? row('Labor Cost', ferryCurr.laborCost, ferryPrev.laborCost) : ''}
      ${row('Tips', ferryCurr.tips, ferryPrev.tips)}
      ${row('Discounts', ferryCurr.discounts, ferryPrev.discounts)}
    </table>

    ${ferryCurr.dailySales.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;margin:12px 0 16px;font-size:13px;">
      <tr><th style="${tableHeader}">Day</th><th style="${tableHeaderR}">This Week</th><th style="${tableHeaderR}">Prev Week</th><th style="${tableHeaderR}">Delta</th></tr>
      ${dailyRows(ferryCurr.dailySales, ferryPrev.dailySales)}
    </table>` : ''}
    ` : '<!-- Ferry Building: No data yet -->'}

  </div>

  <!-- Footer -->
  <div style="background:#f9f9f9;padding:16px 32px;text-align:center;font-size:12px;color:#999;">
    Pixlcat Coffee — Automated Weekly Report<br>
    Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'short' })}
  </div>

</div>
</body>
</html>`;
}


// ── Send Email ───────────────────────────────────────────────────────────────

async function sendWeeklyEmail(subject, html) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('[weekly] Gmail credentials not set');
    return false;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  try {
    const info = await transporter.sendMail({
      from: `"Pixlcat Ops" <${GMAIL_USER}>`,
      to: REPORT_RECIPIENTS.join(', '),
      subject,
      html,
    });
    console.log(`[weekly] Email sent: ${info.messageId}`);
    return true;
  } catch (e) {
    console.error('[weekly] Email error:', e.message);
    return false;
  }
}


// ── Main: generate and post report ───────────────────────────────────────────

async function generateWeeklyReport() {
  const currWeek = getWeekDates(1); // last completed week
  const prevWeek = getWeekDates(2); // week before that

  console.log(`[weekly] Generating report: ${currWeek.label} vs ${prevWeek.label}`);

  const [sfCurr, sfPrev, bosCurr, bosPrev, ferryCurr, ferryPrev] = await Promise.all([
    fetchWeekSF(currWeek.startDate, currWeek.endDate),
    fetchWeekSF(prevWeek.startDate, prevWeek.endDate),
    fetchWeekBoston(currWeek.startDate, currWeek.endDate),
    fetchWeekBoston(prevWeek.startDate, prevWeek.endDate),
    fetchWeekFerry(currWeek.startDate, currWeek.endDate),
    fetchWeekFerry(prevWeek.startDate, prevWeek.endDate),
  ]);

  // Post to Slack
  const msg = formatWeeklyReport(currWeek, prevWeek, sfCurr, sfPrev, bosCurr, bosPrev, ferryCurr, ferryPrev);
  const posted = await postWeeklyReport(msg);

  // Send email
  const html = formatEmailHTML(currWeek, prevWeek, sfCurr, sfPrev, bosCurr, bosPrev, ferryCurr, ferryPrev);
  const subject = `📊 Pixlcat Weekly Report — ${currWeek.label}`;
  const emailed = await sendWeeklyEmail(subject, html);

  return { success: posted, emailed, currWeek: currWeek.label, prevWeek: prevWeek.label };
}

module.exports = { generateWeeklyReport, getWeekDates, fetchWeekSF, fetchWeekBoston };