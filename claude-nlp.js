/**
 * claude-nlp.js — Claude-powered NLP for Pixlcat Sling Bot
 * 
 * Replaces regex-based parseScheduleQuestion with Claude API.
 * Fetches relevant schedule data, sends it as context to Claude,
 * and returns a natural Slack-formatted response.
 * 
 * Requires: ANTHROPIC_API_KEY env var
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLING_API_BASE = `http://localhost:${process.env.PORT || 3000}`;

/**
 * Determine what date range to fetch based on the user's message.
 * Returns { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
 */
function determineDateRange(text) {
  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = new Date(pst.getFullYear(), pst.getMonth(), pst.getDate());

  const fmt = (d) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const t = text.toLowerCase();

  // "this week"
  if (/\b(this\s+week|the\s+week|weekly|full\s+week)\b/.test(t)) {
    const dow = today.getDay(); // 0=Sun
    const monday = addDays(today, dow === 0 ? -6 : 1 - dow);
    return { startDate: fmt(monday), endDate: fmt(addDays(monday, 6)) };
  }

  // "next week"
  if (/\bnext\s+week\b/.test(t)) {
    const dow = today.getDay();
    const monday = addDays(today, dow === 0 ? 1 : 8 - dow);
    return { startDate: fmt(monday), endDate: fmt(addDays(monday, 6)) };
  }

  // "last week"
  if (/\blast\s+week\b/.test(t)) {
    const dow = today.getDay();
    const monday = addDays(today, dow === 0 ? -13 : -6 - dow);
    return { startDate: fmt(monday), endDate: fmt(addDays(monday, 6)) };
  }

  // "weekend" / "this weekend"
  if (/\b(this\s+)?weekend\b/.test(t) && !/next/.test(t)) {
    const dow = today.getDay();
    let sat;
    if (dow === 6) sat = today;
    else if (dow === 0) sat = addDays(today, -1);
    else sat = addDays(today, 6 - dow);
    return { startDate: fmt(sat), endDate: fmt(addDays(sat, 1)) };
  }

  // "next weekend"
  if (/\bnext\s+weekend\b/.test(t)) {
    const dow = today.getDay();
    const daysToSat = (6 - dow + 7) % 7 || 7;
    const sat = addDays(today, daysToSat + (dow <= 6 ? 7 : 0));
    return { startDate: fmt(sat), endDate: fmt(addDays(sat, 1)) };
  }

  // Specific date YYYY-MM-DD
  const dateMatch = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    return { startDate: dateMatch[1], endDate: dateMatch[1] };
  }

  // "today"
  if (/\btoday\b/.test(t)) {
    return { startDate: fmt(today), endDate: fmt(today) };
  }

  // "tomorrow"
  if (/\btomorrow\b/.test(t)) {
    const d = addDays(today, 1);
    return { startDate: fmt(d), endDate: fmt(d) };
  }

  // "yesterday"
  if (/\byesterday\b/.test(t)) {
    const d = addDays(today, -1);
    return { startDate: fmt(d), endDate: fmt(d) };
  }

  // Day of week
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < dayNames.length; i++) {
    const re = new RegExp(`\\b${dayNames[i]}\\b`);
    if (re.test(t)) {
      const currentDow = today.getDay();
      let diff = (i - currentDow + 7) % 7;
      if (diff === 0) {
        if (/next/.test(t)) diff = 7;
      }
      if (/last/.test(t)) {
        diff = diff > 0 ? diff - 7 : -7;
      }
      const d = addDays(today, diff);
      return { startDate: fmt(d), endDate: fmt(d) };
    }
  }

  // Default: today + next 6 days
  return { startDate: fmt(today), endDate: fmt(addDays(today, 6)) };
}


/**
 * Fetch schedule data from Sling API for a date range.
 * Returns formatted text context for Claude.
 */
async function fetchScheduleContext(startDate, endDate) {
  const schedules = [];
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  const current = new Date(start);

  while (current <= end) {
    const dateStr = current.toLocaleDateString('en-CA');
    try {
      const res = await fetch(`${SLING_API_BASE}/schedule/${dateStr}`);
      if (res.ok) {
        const data = await res.json();
        if (data.shifts && data.shifts.length > 0) {
          schedules.push({ date: dateStr, shifts: data.shifts });
        }
      }
    } catch (e) {
      console.error(`Error fetching schedule for ${dateStr}:`, e.message);
    }
    current.setDate(current.getDate() + 1);
  }

  if (schedules.length === 0) {
    return 'No schedule data found for the requested dates.';
  }

  let context = '';
  for (const { date, shifts } of schedules) {
    const d = new Date(date + 'T12:00:00');
    const dayLabel = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
      timeZone: 'America/Los_Angeles'
    });
    const totalHours = shifts.reduce((sum, s) => sum + (s.duration || 0), 0);
    context += `\n${dayLabel} (${date}) — ${shifts.length} shifts, ${totalHours.toFixed(1)}h total:\n`;

    const clement = shifts.filter(s => (s.location || '').includes('Clement'));
    const ninth = shifts.filter(s => (s.location || '').includes('9th'));
    const other = shifts.filter(s => !(s.location || '').includes('Clement') && !(s.location || '').includes('9th'));

    if (clement.length > 0) {
      context += '  Clement St:\n';
      for (const s of clement.sort((a, b) => a.start.localeCompare(b.start))) {
        const st = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        const et = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        context += `    - ${s.employee} | ${s.position || 'TBD'} | ${st}-${et} | ${(s.duration || 0).toFixed(1)}h\n`;
      }
    }
    if (ninth.length > 0) {
      context += '  9th St:\n';
      for (const s of ninth.sort((a, b) => a.start.localeCompare(b.start))) {
        const st = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        const et = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        context += `    - ${s.employee} | ${s.position || 'TBD'} | ${st}-${et} | ${(s.duration || 0).toFixed(1)}h\n`;
      }
    }
    if (other.length > 0) {
      for (const s of other.sort((a, b) => a.start.localeCompare(b.start))) {
        const st = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        const et = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        context += `    - ${s.employee} | ${s.position || 'TBD'} | ${st}-${et} | ${(s.duration || 0).toFixed(1)}h\n`;
      }
    }
  }

  return context;
}


/**
 * Send user message + schedule context to Claude API.
 * Returns the response text, or null on failure.
 */
async function askClaude(userMessage, scheduleContext) {
  if (!ANTHROPIC_API_KEY) {
    console.error('No ANTHROPIC_API_KEY set');
    return null;
  }

  const now = new Date();
  const pst = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const todayStr = pst.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
  const timeStr = pst.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles'
  });

  const systemPrompt = `You are the Pixlcat SF scheduling assistant in Slack. You answer questions about employee schedules at Pixlcat Coffee's San Francisco locations (Clement St and 9th St).

Current date/time: ${todayStr}, ${timeStr} PT (Pacific Time)

SCHEDULE DATA:
${scheduleContext}

RULES:
- Respond in Slack mrkdwn format (use *bold*, _italic_, bullet points with •)
- Be concise and direct — this is Slack, not an essay
- If asked about a specific person, pull their info from the data
- If asked "who's working" without a date, default to tomorrow
- Distinguish between Clement St and 9th St locations when both have shifts
- If someone asks about hours, calculate from the shift data
- If asked about coverage gaps or staffing, analyze the data
- If the schedule data doesn't cover the dates asked about, say so
- Never make up shifts or employees that aren't in the data
- Use casual, friendly tone — you're a team tool
- If the question has nothing to do with scheduling, politely say you only handle schedule questions
- For time references, always use Pacific Time`;

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
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      console.error(`Claude API error: ${res.status} - ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    return data.content[0].text;
  } catch (e) {
    console.error('Claude API request error:', e.message);
    return null;
  }
}


/**
 * Main handler: process a Slack message using Claude NLP.
 * Returns the response text, or null if Claude is unavailable (caller should fallback).
 */
async function handleWithClaude(messageText) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const { startDate, endDate } = determineDateRange(messageText);
    console.log(`Claude NLP: "${messageText}" -> ${startDate} to ${endDate}`);

    const scheduleContext = await fetchScheduleContext(startDate, endDate);
    const response = await askClaude(messageText, scheduleContext);
    return response;
  } catch (e) {
    console.error('Claude NLP error:', e.message);
    return null;
  }
}

module.exports = { handleWithClaude, determineDateRange, fetchScheduleContext, askClaude };
