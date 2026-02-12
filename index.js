const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const SLING_BASE = 'https://api.getsling.com';
const SLING_TOKEN = process.env.SLING_TOKEN;

// ============================================================
// HELPERS
// ============================================================

async function slingGet(path, token) {
  const authToken = token || SLING_TOKEN;
  if (!authToken) throw new Error('No Sling auth token configured');
  const res = await fetch(`${SLING_BASE}${path}`, {
    headers: { 'Authorization': authToken, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sling API ${res.status}: ${text}`);
  }
  return res.json();
}

async function slingPost(path, body, token) {
  const authToken = token || SLING_TOKEN;
  if (!authToken) throw new Error('No Sling auth token configured');
  const res = await fetch(`${SLING_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sling API ${res.status}: ${text}`);
  }
  return res.json();
}

async function slingPut(path, body, token) {
  const authToken = token || SLING_TOKEN;
  if (!authToken) throw new Error('No Sling auth token configured');
  const res = await fetch(`${SLING_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Authorization': authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sling API ${res.status}: ${text}`);
  }
  return res.json();
}

// Helper: find user by name (case-insensitive partial match)
function findUserByName(users, name) {
  const lower = name.toLowerCase().trim();
  return users.find(u => {
    const fullName = `${u.name || ''} ${u.lname || ''}`.toLowerCase();
    const firstName = (u.name || '').toLowerCase();
    const lastName = (u.lname || '').toLowerCase();
    return firstName === lower || lastName === lower || fullName.includes(lower);
  });
}

// Helper: find position by name
function findPositionByName(positions, name) {
  const lower = name.toLowerCase().trim();
  return positions.find(p => (p.name || '').toLowerCase().includes(lower));
}

// Helper: get org ID and admin user ID from session (cached)
let _cachedSession = null;
async function getSessionInfo() {
  if (_cachedSession) return _cachedSession;
  const session = await slingGet('/account/session');
  if (session && session.org && session.org.id) {
    _cachedSession = {
      orgId: session.org.id,
      userId: session.user.id,
      memberGroupId: session.org.memberGroupId
    };
    return _cachedSession;
  }
  throw new Error('Could not determine session info');
}
async function getOrgId() {
  const s = await getSessionInfo();
  return s.orgId;
}

// Helper: get org-wide calendar events for a date range
// Returns shifts enriched with user/position/location names
async function getOrgCalendar(dateStart, dateEnd) {
  const { orgId, userId } = await getSessionInfo();
  const dates = `${dateStart}/${dateEnd}`;
  const [calData, users, positions, locations] = await Promise.all([
    slingGet(`/${orgId}/calendar/${userId}?dates=${encodeURIComponent(dates)}`),
    slingGet('/users'),
    slingGet('/groups').then(g => g.filter(x => x.type === 'position')),
    slingGet('/groups').then(g => g.filter(x => x.type === 'location'))
  ]);

  // Build lookup maps
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u; });
  const posMap = {};
  positions.forEach(p => { posMap[p.id] = p; });
  const locMap = {};
  locations.forEach(l => { locMap[l.id] = l; });

  // Enrich shifts
  const shifts = (Array.isArray(calData) ? calData : [])
    .filter(s => s.type === 'shift')
    .map(s => {
      const user = s.user ? userMap[s.user.id] : null;
      const pos = s.position ? posMap[s.position.id] : null;
      const loc = s.location ? locMap[s.location.id] : null;
      return {
        id: s.id,
        employee: user ? `${user.name || ''} ${user.lname || ''}`.trim() : 'Unassigned',
        employeeId: s.user ? s.user.id : null,
        position: pos ? pos.name : null,
        location: loc ? loc.name : null,
        start: s.dtstart,
        end: s.dtend,
        status: s.status,
        published: s.status === 'published'
      };
    });

  return { shifts, userMap, posMap, locMap };
}

// Helper: parse a date string to ISO range for a given day
function getDayRange(dateStr) {
  // Accept: "tuesday", "2025-02-11", "tomorrow", "today", etc.
  const now = new Date();
  let target;

  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIdx = days.indexOf(dateStr.toLowerCase());

  if (dateStr.toLowerCase() === 'today') {
    target = now;
  } else if (dateStr.toLowerCase() === 'tomorrow') {
    target = new Date(now);
    target.setDate(target.getDate() + 1);
  } else if (dayIdx !== -1) {
    target = new Date(now);
    const currentDay = target.getDay();
    let diff = dayIdx - currentDay;
    if (diff <= 0) diff += 7; // next occurrence
    target.setDate(target.getDate() + diff);
  } else {
    target = new Date(dateStr);
  }

  const start = new Date(target);
  start.setHours(0, 0, 0, 0);
  const end = new Date(target);
  end.setHours(23, 59, 59, 999);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    dateFormatted: start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
  };
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
  res.json({
    service: 'Pixlcat Sling API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      // READ
      'GET /users': 'List all employees',
      'GET /positions': 'List all positions',
      'GET /locations': 'List all locations',
      'GET /groups': 'List all groups',
      'GET /shifts': 'Get shifts for a date range (?start=ISO&end=ISO)',
      'GET /shifts/today': 'Get today\'s shifts',
      'GET /shifts/week': 'Get this week\'s shifts',
      'GET /schedule/:date': 'Get schedule for a specific day (YYYY-MM-DD or day name)',
      'GET /whos-working': 'Who\'s working right now',
      'GET /whos-working/:date': 'Who\'s working on a given day',
      'GET /timeoff': 'Get pending/approved time-off requests',
      'GET /calendar/summaries': 'Get hours/cost summaries',
      // WRITE
      'POST /shifts/create': 'Create a new shift',
      'POST /shifts/swap': 'Swap one employee for another on a shift',
      'POST /shifts/assign': 'Assign employee to a shift by name + date',
      'PUT /shifts/:id': 'Update a shift directly',
      'POST /shifts/publish': 'Publish shifts for a date range',
      'POST /shifts/unpublish': 'Unpublish shifts',
      // NATURAL LANGUAGE
      'POST /command': 'Natural language command processor'
    }
  });
});

// ============================================================
// READ ENDPOINTS
// ============================================================

// GET /users — List all employees
app.get('/users', async (req, res) => {
  try {
    const data = await slingGet('/users');
    const users = data.map(u => ({
      id: u.id,
      firstName: u.name,
      lastName: u.lname,
      fullName: `${u.name || ''} ${u.lname || ''}`.trim(),
      email: u.email,
      phone: u.phone,
      avatar: u.avatar,
      type: u.type, // admin, manager, employee
      active: u.active,
      timezone: u.timezone,
      hourlyWage: u.hourlyWage
    }));
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /positions — List all positions (barista, etc.)
app.get('/positions', async (req, res) => {
  try {
    const data = await slingGet('/positions');
    res.json({ count: data.length, positions: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /locations — List all locations
app.get('/locations', async (req, res) => {
  try {
    const data = await slingGet('/locations');
    res.json({ count: data.length, locations: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /groups — List all employee groups
app.get('/groups', async (req, res) => {
  try {
    const data = await slingGet('/groups');
    res.json({ count: data.length, groups: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /shifts — Get shifts for date range
// Query params: start (ISO), end (ISO), user_id (optional)
app.get('/shifts', async (req, res) => {
  try {
    const { start, end, user_id } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query params required (ISO dates)' });
    }
    const dates = `${start}/${end}`;
    let path = `/calendar/${user_id || ''}/shifts?dates=${encodeURIComponent(dates)}`;
    if (!user_id) {
      const { orgId, userId: adminId } = await getSessionInfo();
      path = `/${orgId}/calendar/${adminId}?dates=${encodeURIComponent(dates)}`;
    }
    const data = await slingGet(path);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /shifts/today — Today's schedule
app.get('/shifts/today', async (req, res) => {
  try {
    const { start, end, dateFormatted } = getDayRange('today');
    const { shifts } = await getOrgCalendar(start, end);
    res.json({ date: dateFormatted, count: shifts.length, shifts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /shifts/week — This week's schedule
app.get('/shifts/week', async (req, res) => {
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    const { shifts } = await getOrgCalendar(startOfWeek.toISOString(), endOfWeek.toISOString());
    
    // Add day name
    const enriched = shifts.map(s => ({
      ...s,
      day: new Date(s.start).toLocaleDateString('en-US', { weekday: 'long' })
    }));

    const byDay = {};
    enriched.forEach(s => {
      if (!byDay[s.day]) byDay[s.day] = [];
      byDay[s.day].push(s);
    });

    res.json({
      weekOf: startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      totalShifts: enriched.length,
      byDay,
      allShifts: enriched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /schedule/:date — Get schedule for a specific day
app.get('/schedule/:date', async (req, res) => {
  try {
    const { start, end, dateFormatted } = getDayRange(req.params.date);
    const { shifts } = await getOrgCalendar(start, end);
    res.json({ date: dateFormatted, count: shifts.length, shifts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /whos-working — Who's working right now
app.get('/whos-working', async (req, res) => {
  try {
    const data = await slingGet('/calendar/working');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /whos-working/:date — Who's working on a given day
app.get('/whos-working/:date', async (req, res) => {
  try {
    const { start, end, dateFormatted } = getDayRange(req.params.date);
    const { shifts } = await getOrgCalendar(start, end);
    const working = shifts.filter(s => s.employeeId).map(s => ({
      employee: s.employee,
      position: s.position,
      start: s.start,
      end: s.end
    }));
    res.json({ date: dateFormatted, working });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /timeoff — Get time-off requests
app.get('/timeoff', async (req, res) => {
  try {
    const data = await slingGet('/leave/requests');
    res.json(data);
  } catch (err) {
    // Try alternative endpoint
    try {
      const data = await slingGet('/leave');
      res.json(data);
    } catch (err2) {
      res.status(500).json({ error: err2.message });
    }
  }
});

// GET /calendar/summaries — Hours and cost summaries
app.get('/calendar/summaries', async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query params required' });
    }
    const dates = `${start}/${end}`;
    const data = await slingGet(`/calendar/summaries?dates=${encodeURIComponent(dates)}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WRITE ENDPOINTS
// ============================================================

// POST /shifts/create — Create a new shift
// Body: { employee (name), position (name), date (string), startTime (HH:MM), endTime (HH:MM), publish (bool) }
app.post('/shifts/create', async (req, res) => {
  try {
    const { employee, position, location, date, startTime, endTime, publish } = req.body;

    // Look up user
    const users = await slingGet('/users');
    let userId = null;
    if (employee) {
      const user = findUserByName(users, employee);
      if (!user) return res.status(404).json({ error: `Employee "${employee}" not found`, availableUsers: users.map(u => `${u.name} ${u.lname}`.trim()) });
      userId = user.id;
    }

    // Look up position
    let positionId = null;
    if (position) {
      const positions = await slingGet('/positions');
      const pos = findPositionByName(positions, position);
      if (!pos) return res.status(404).json({ error: `Position "${position}" not found`, availablePositions: positions.map(p => p.name) });
      positionId = pos.id;
    }

    // Look up location
    let locationId = null;
    if (location) {
      const locations = await slingGet('/locations');
      const loc = locations.find(l => (l.name || '').toLowerCase().includes(location.toLowerCase()));
      if (loc) locationId = loc.id;
    }

    // Build date/time
    const { start: dayStart } = getDayRange(date);
    const dayDate = new Date(dayStart);
    const [sh, sm] = (startTime || '07:00').split(':').map(Number);
    const [eh, em] = (endTime || '15:00').split(':').map(Number);

    const dtstart = new Date(dayDate);
    dtstart.setHours(sh, sm, 0, 0);
    const dtend = new Date(dayDate);
    dtend.setHours(eh, em, 0, 0);

    const shiftBody = {
      dtstart: dtstart.toISOString(),
      dtend: dtend.toISOString(),
      type: 'shift'
    };

    if (userId) shiftBody.user = { id: userId };
    if (positionId) shiftBody.position = { id: positionId };
    if (locationId) shiftBody.location = { id: locationId };
    if (publish) shiftBody.status = 'published';

    const result = await slingPost(`/shifts?publish=${publish ? 'true' : 'false'}`, [shiftBody]);

    res.json({
      success: true,
      message: `Shift created for ${employee || 'unassigned'} on ${date} (${startTime || '07:00'}-${endTime || '15:00'})`,
      shift: result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /shifts/swap — Swap one employee for another on an existing shift
// Body: { currentEmployee, newEmployee, date, shiftId (optional — if known) }
app.post('/shifts/swap', async (req, res) => {
  try {
    const { currentEmployee, newEmployee, date, shiftId } = req.body;

    // Get users
    const users = await slingGet('/users');
    const currentUser = findUserByName(users, currentEmployee);
    const newUser = findUserByName(users, newEmployee);

    if (!currentUser) return res.status(404).json({ error: `Current employee "${currentEmployee}" not found` });
    if (!newUser) return res.status(404).json({ error: `New employee "${newEmployee}" not found` });

    let targetShiftId = shiftId;

    // If no shiftId, find the shift by date + current employee
    if (!targetShiftId && date) {
      const { start, end } = getDayRange(date);
      const dates = `${start}/${end}`;

      const orgId = await getOrgId();

      const { shifts: allShifts } = await getOrgCalendar(start, end);
      const shifts = allShifts.filter(s => s.employeeId === currentUser.id);

      if (shifts.length === 0) {
        return res.status(404).json({
          error: `No shift found for ${currentEmployee} on ${date}`,
          hint: 'Check the date or employee name'
        });
      }
      if (shifts.length > 1) {
        return res.json({
          error: `Multiple shifts found for ${currentEmployee} on ${date}. Please specify shiftId.`,
          shifts: shifts.map(s => ({
            id: s.id,
            start: s.dtstart,
            end: s.dtend,
            position: s.position ? s.position.name : null
          }))
        });
      }
      targetShiftId = shifts[0].id;
    }

    if (!targetShiftId) {
      return res.status(400).json({ error: 'Need either shiftId or date to find the shift' });
    }

    // Update the shift with new employee
    const updateBody = {
      user: { id: newUser.id }
    };

    const result = await slingPut(`/shifts/${targetShiftId}`, updateBody);

    res.json({
      success: true,
      message: `Swapped ${currentEmployee} → ${newEmployee}`,
      shiftId: targetShiftId,
      result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /shifts/assign — Assign employee to a specific date/position
// Body: { employee, position (optional), date, startTime, endTime }
app.post('/shifts/assign', async (req, res) => {
  try {
    const { employee, position, date, startTime, endTime, publish } = req.body;

    // First check if there's an unassigned shift on that date for that position
    const users = await slingGet('/users');
    const user = findUserByName(users, employee);
    if (!user) return res.status(404).json({ error: `Employee "${employee}" not found` });

    const orgId = await getOrgId();

    const { start, end, dateFormatted } = getDayRange(date);
    const dates = `${start}/${end}`;
    const { shifts: allShifts } = await getOrgCalendar(start, end);

    // Look for unassigned shifts matching position
    const unassigned = allShifts.filter(s => !s.employeeId);

    let positionMatch = null;
    if (position) {
      const positions = await slingGet('/positions');
      positionMatch = findPositionByName(positions, position);
    }

    const matchingUnassigned = unassigned.filter(s => {
      if (!positionMatch) return true;
      return s.position && s.position.id === positionMatch.id;
    });

    if (matchingUnassigned.length > 0) {
      // Assign to existing unassigned shift
      const shift = matchingUnassigned[0];
      const result = await slingPut(`/shifts/${shift.id}`, { user: { id: user.id } });
      return res.json({
        success: true,
        message: `Assigned ${employee} to existing ${position || ''} shift on ${dateFormatted}`,
        shiftId: shift.id,
        result
      });
    }

    // No unassigned shift found, create a new one
    const { start: dayStart } = getDayRange(date);
    const dayDate = new Date(dayStart);
    const [sh, sm] = (startTime || '07:00').split(':').map(Number);
    const [eh, em] = (endTime || '15:00').split(':').map(Number);

    const dtstart = new Date(dayDate);
    dtstart.setHours(sh, sm, 0, 0);
    const dtend = new Date(dayDate);
    dtend.setHours(eh, em, 0, 0);

    const shiftBody = {
      dtstart: dtstart.toISOString(),
      dtend: dtend.toISOString(),
      type: 'shift',
      user: { id: user.id }
    };
    if (positionMatch) shiftBody.position = { id: positionMatch.id };

    const result = await slingPost(`/shifts?publish=${publish ? 'true' : 'false'}`, [shiftBody]);
    res.json({
      success: true,
      message: `Created and assigned new shift for ${employee} on ${dateFormatted} (${startTime || '07:00'}-${endTime || '15:00'})`,
      result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /shifts/:id — Update a shift directly
app.put('/shifts/:id', async (req, res) => {
  try {
    const result = await slingPut(`/shifts/${req.params.id}`, req.body);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /shifts/publish — Publish shifts for a date range
app.post('/shifts/publish', async (req, res) => {
  try {
    const { start, end } = req.body;
    if (!start || !end) return res.status(400).json({ error: 'start and end required' });
    const dates = `${start}/${end}`;
    const result = await slingPost(`/shifts/publish?dates=${encodeURIComponent(dates)}`, {});
    res.json({ success: true, message: `Published shifts from ${start} to ${end}`, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /shifts/unpublish — Unpublish shifts
app.post('/shifts/unpublish', async (req, res) => {
  try {
    const { shiftIds } = req.body;
    const result = await slingPost('/shifts/unpublish', shiftIds || []);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// NATURAL LANGUAGE COMMAND PROCESSOR
// ============================================================

app.post('/command', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'command field required' });

    const lower = command.toLowerCase();

    // Pattern: "who's working today/tomorrow/tuesday"
    const whosWorkingMatch = lower.match(/who(?:'s| is) working (\w+)/);
    if (whosWorkingMatch) {
      const date = whosWorkingMatch[1];
      const { start, end, dateFormatted } = getDayRange(date);
      const dates = `${start}/${end}`;
      const users = await slingGet('/users');
      const orgId = await getOrgId();
      const { shifts: allShifts } = await getOrgCalendar(start, end);
      const working = allShifts
        .filter(s => s.employeeId)
        .map(s => `${s.employee}` + (s.position ? ` (${s.position})` : '') + ` ${new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}-${new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
      return res.json({ date: dateFormatted, working });
    }

    // Pattern: "swap X with Y on DATE" or "replace X with Y on DATE"
    const swapMatch = lower.match(/(?:swap|replace|switch)\s+(\w+)\s+(?:with|for|→|->)\s+(\w+)\s+(?:on\s+)?(\w+)/);
    if (swapMatch) {
      const [, currentEmp, newEmp, date] = swapMatch;
      // Forward to swap endpoint
      const swapRes = await fetch(`http://localhost:${PORT}/shifts/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentEmployee: currentEmp, newEmployee: newEmp, date })
      });
      return res.json(await swapRes.json());
    }

    // Pattern: "schedule/assign X for POSITION on DATE"
    const assignMatch = lower.match(/(?:schedule|assign|add|put)\s+(\w+)\s+(?:for|as|to)\s+(\w+)\s+(?:on\s+)?(\w+)/);
    if (assignMatch) {
      const [, emp, position, date] = assignMatch;
      const assignRes = await fetch(`http://localhost:${PORT}/shifts/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee: emp, position, date })
      });
      return res.json(await assignRes.json());
    }

    return res.json({
      error: 'Could not parse command',
      hint: 'Try: "who\'s working today", "swap Jesus with Jessica on Tuesday", "schedule Clayton for barista on Tuesday"',
      rawCommand: command
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AUTH ENDPOINT — Get token from email/password
// ============================================================

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const loginRes = await fetch(`${SLING_BASE}/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!loginRes.ok) {
      const text = await loginRes.text();
      return res.status(loginRes.status).json({ error: `Login failed: ${text}` });
    }

    // Token is in the response headers
    const token = loginRes.headers.get('authorization');
    const body = await loginRes.json();

    res.json({
      success: true,
      token,
      user: body,
      note: 'Set this token as SLING_TOKEN environment variable on Render'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SLACK INTEGRATION
// ============================================================

const SLACK_CHANNEL = 'C0AELGYN2LC'; // #sling-scheduling-san-francisco
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// Simple daily scheduler — checks every minute, fires once at target hour
let _lastPostedDate = null;
function startDailyScheduler() {
  if (!SLACK_BOT_TOKEN && !process.env.SLACK_WEBHOOK_URL) {
    console.log('No Slack credentials set, daily scheduler disabled');
    return;
  }
  const POST_HOUR = 17; // 5pm Pacific
  
  setInterval(async () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const today = now.toDateString();
    
    if (now.getHours() === POST_HOUR && _lastPostedDate !== today) {
      _lastPostedDate = today;
      console.log('Daily scheduler: posting tomorrow\'s schedule...');
      try {
        const { start, end, dateFormatted } = getDayRange('tomorrow');
        const { shifts } = await getOrgCalendar(start, end);
        const message = formatScheduleForSlack(dateFormatted, shifts);
        const result = await postToSlack(message);
        console.log('Daily scheduler: posted successfully', result?.ok);
      } catch (err) {
        console.error('Daily scheduler error:', err.message);
      }
    }
  }, 60 * 1000); // Check every minute
  
  console.log(`Daily scheduler: will post tomorrow's schedule at ${POST_HOUR}:00 PT`);
}

async function postToSlack(text, blocks) {
  // Support both webhook URL and bot token
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const botToken = SLACK_BOT_TOKEN;
  
  if (webhookUrl) {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return { ok: res.ok, status: res.status };
  }
  
  if (botToken) {
    const body = { channel: SLACK_CHANNEL, text };
    if (blocks) body.blocks = blocks;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return res.json();
  }
  
  console.log('No Slack credentials configured, skipping post');
  return null;
}

// Format a schedule into a Slack message
function formatScheduleForSlack(dateStr, shifts) {
  const clementShifts = shifts.filter(s => (s.location || '').includes('Clement'));
  const ninthShifts = shifts.filter(s => (s.location || '').includes('9th'));
  
  let text = `📋 *Schedule for ${dateStr}*\n\n`;
  
  if (clementShifts.length > 0) {
    text += `*Clement Pixlcat* (${clementShifts.length} shifts)\n`;
    // Sort by start time
    clementShifts.sort((a, b) => a.start.localeCompare(b.start));
    for (const s of clementShifts) {
      const startTime = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      const endTime = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      text += `  • ${s.employee} — ${s.position || 'TBD'} (${startTime} - ${endTime})\n`;
    }
  }
  
  if (ninthShifts.length > 0) {
    text += `\n*9th St Pixlcat* (${ninthShifts.length} shifts)\n`;
    ninthShifts.sort((a, b) => a.start.localeCompare(b.start));
    for (const s of ninthShifts) {
      const startTime = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      const endTime = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
      text += `  • ${s.employee} — ${s.position || 'TBD'} (${startTime} - ${endTime})\n`;
    }
  }
  
  if (shifts.length === 0) {
    text += '_No shifts scheduled._\n';
  }
  
  return text;
}

// GET /slack/daily — Post today's schedule to Slack
app.get('/slack/daily', async (req, res) => {
  try {
    const { start, end, dateFormatted } = getDayRange('today');
    const { shifts } = await getOrgCalendar(start, end);
    const message = formatScheduleForSlack(dateFormatted, shifts);
    const result = await postToSlack(message);
    res.json({ success: true, message: 'Posted daily schedule to Slack', slackResult: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /slack/tomorrow — Post tomorrow's schedule to Slack
app.get('/slack/tomorrow', async (req, res) => {
  try {
    const { start, end, dateFormatted } = getDayRange('tomorrow');
    const { shifts } = await getOrgCalendar(start, end);
    const message = formatScheduleForSlack(dateFormatted, shifts);
    const result = await postToSlack(message);
    res.json({ success: true, message: 'Posted tomorrow\'s schedule to Slack', slackResult: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /cron/daily — External cron hits this at 5pm PT to post tomorrow's schedule
// Secured with a simple secret token
app.get('/cron/daily', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.query.key !== cronSecret) {
    return res.status(403).json({ error: 'Invalid cron key' });
  }
  try {
    const { start, end, dateFormatted } = getDayRange('tomorrow');
    const { shifts } = await getOrgCalendar(start, end);
    const message = formatScheduleForSlack(dateFormatted, shifts);
    const result = await postToSlack(message);
    console.log(`Cron: posted tomorrow's schedule (${dateFormatted}, ${shifts.length} shifts)`);
    res.json({ success: true, date: dateFormatted, shiftsPosted: shifts.length });
  } catch (err) {
    console.error('Cron error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /slack/week — Post week schedule to Slack
app.get('/slack/week', async (req, res) => {
  try {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    
    const { shifts } = await getOrgCalendar(startOfWeek.toISOString(), endOfWeek.toISOString());
    
    // Group by day
    const byDay = {};
    shifts.forEach(s => {
      const day = new Date(s.start).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(s);
    });
    
    let text = `📅 *Week Schedule (${startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})*\n\n`;
    
    for (const [day, dayShifts] of Object.entries(byDay)) {
      const clementOnly = dayShifts.filter(s => (s.location || '').includes('Clement'));
      text += `*${day}* (${clementOnly.length} Clement shifts)\n`;
      clementOnly.sort((a, b) => a.start.localeCompare(b.start));
      for (const s of clementOnly) {
        const startTime = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        const endTime = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        text += `  ${s.employee} — ${s.position || 'TBD'} (${startTime}-${endTime})\n`;
      }
      text += '\n';
    }
    
    const result = await postToSlack(text);
    res.json({ success: true, message: 'Posted week schedule to Slack', slackResult: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SLACK EVENTS API — Interactive bot
// ============================================================

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID; // Set after install, or auto-detect

// Reply to a message in the same channel (threaded)
async function replyInSlack(channel, threadTs, text) {
  if (!SLACK_BOT_TOKEN) return null;
  const body = { channel, text, thread_ts: threadTs };
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// Parse a natural language schedule question
function parseScheduleQuestion(text) {
  const lower = text.toLowerCase().replace(/<[^>]+>/g, '').trim(); // Strip Slack mentions
  
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  // "who's working [day]?" or "who works [day]?"
  const whosWorkingMatch = lower.match(/who(?:'s|s|\sis)\s+(?:working|on|scheduled)?\s*(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this weekend|next week)?/i);
  
  // "schedule for [day]" or "[day] schedule"
  const scheduleMatch = lower.match(/schedule\s+(?:for\s+)?(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|weekend)/i)
    || lower.match(/(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|weekend)(?:'s)?\s+schedule/i);
  
  // "what's [day] look like?"
  const whatsMatch = lower.match(/what(?:'s|s|\sdoes)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this weekend)\s+look/i);
  
  // "week" or "this week" or "weekly schedule"
  const weekMatch = lower.match(/(?:this\s+)?week(?:ly)?\s*(?:schedule)?|full\s+(?:week|schedule)/i);
  
  // "weekend" 
  const weekendMatch = lower.match(/(?:this\s+)?weekend/i);
  
  // Extract the day
  let targetDay = null;
  const match = whosWorkingMatch || scheduleMatch || whatsMatch;
  if (match) {
    targetDay = (match[1] || 'today').toLowerCase().trim();
  }
  
  if (weekMatch && !targetDay) return { type: 'week' };
  if (weekendMatch && !targetDay) return { type: 'weekend' };
  if (targetDay === 'this week' || targetDay === 'next week') return { type: 'week' };
  if (targetDay === 'this weekend' || targetDay === 'weekend') return { type: 'weekend' };
  if (targetDay) return { type: 'day', day: targetDay };
  
  // Fallback — check if any day name is in the text
  for (const d of days) {
    if (lower.includes(d)) return { type: 'day', day: d };
  }
  if (lower.includes('today')) return { type: 'day', day: 'today' };
  if (lower.includes('tomorrow')) return { type: 'day', day: 'tomorrow' };
  
  return null;
}

// Handle a parsed schedule question and return response text
async function handleScheduleQuestion(parsed) {
  if (parsed.type === 'week') {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    
    const { shifts } = await getOrgCalendar(startOfWeek.toISOString(), endOfWeek.toISOString());
    const byDay = {};
    shifts.forEach(s => {
      const day = new Date(s.start).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' });
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(s);
    });
    
    let text = `📅 *This Week's Schedule*\n\n`;
    const dayOrder = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const day of dayOrder) {
      if (!byDay[day]) continue;
      const clement = byDay[day].filter(s => (s.location || '').includes('Clement'));
      if (clement.length === 0) continue;
      text += `*${day}*\n`;
      clement.sort((a, b) => a.start.localeCompare(b.start));
      for (const s of clement) {
        const st = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        const et = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        text += `  • ${s.employee} — ${s.position || 'TBD'} (${st}-${et})\n`;
      }
      text += '\n';
    }
    return text;
  }
  
  if (parsed.type === 'weekend') {
    // Get Saturday and Sunday
    const now = new Date();
    const dayOfWeek = now.getDay();
    const satOffset = 6 - dayOfWeek;
    const sat = new Date(now);
    sat.setDate(now.getDate() + satOffset);
    sat.setHours(0, 0, 0, 0);
    const sunEnd = new Date(sat);
    sunEnd.setDate(sat.getDate() + 1);
    sunEnd.setHours(23, 59, 59, 999);
    
    const { shifts } = await getOrgCalendar(sat.toISOString(), sunEnd.toISOString());
    
    let text = `🗓️ *Weekend Schedule*\n\n`;
    for (const dayLabel of ['Saturday', 'Sunday']) {
      const dayShifts = shifts.filter(s => {
        const d = new Date(s.start).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Los_Angeles' });
        return d === dayLabel && (s.location || '').includes('Clement');
      });
      if (dayShifts.length === 0) continue;
      text += `*${dayLabel}*\n`;
      dayShifts.sort((a, b) => a.start.localeCompare(b.start));
      for (const s of dayShifts) {
        const st = new Date(s.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        const et = new Date(s.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
        text += `  • ${s.employee} — ${s.position || 'TBD'} (${st}-${et})\n`;
      }
      text += '\n';
    }
    return text;
  }
  
  // Single day
  const { start, end, dateFormatted } = getDayRange(parsed.day);
  const { shifts } = await getOrgCalendar(start, end);
  return formatScheduleForSlack(dateFormatted, shifts);
}

// POST /slack/events — Slack Events API endpoint
app.post('/slack/events', async (req, res) => {
  const body = req.body;
  
  // URL verification challenge (Slack sends this when you first configure events)
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }
  
  // Acknowledge immediately (Slack requires response within 3 seconds)
  res.status(200).json({ ok: true });
  
  // Process the event asynchronously
  try {
    const event = body.event;
    if (!event) return;
    
    // Only respond to messages (not bot messages, not edits)
    if (event.type !== 'message') return;
    if (event.subtype) return; // Ignore edits, joins, bot messages, etc.
    if (event.bot_id) return; // Ignore bot messages
    
    // Only respond in our scheduling channel (or DMs with the bot)
    const isSchedulingChannel = event.channel === SLACK_CHANNEL;
    const isDM = event.channel_type === 'im';
    if (!isSchedulingChannel && !isDM) return;
    
    const text = event.text || '';
    const parsed = parseScheduleQuestion(text);
    
    if (!parsed) {
      // If in DM, give a helpful hint. In channel, stay quiet for non-schedule messages.
      if (isDM) {
        await replyInSlack(event.channel, event.ts, 
          `Hey! Ask me about the schedule. Try:\n• "Who's working today?"\n• "Saturday schedule"\n• "This week"\n• "Weekend"`
        );
      }
      return;
    }
    
    const response = await handleScheduleQuestion(parsed);
    await replyInSlack(event.channel, event.ts, response);
    
  } catch (err) {
    console.error('Slack event handler error:', err.message);
  }
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pixlcat Sling API running on port ${PORT}`);
  console.log(`Token configured: ${SLING_TOKEN ? 'Yes' : 'No — set SLING_TOKEN env var'}`);
  console.log(`Slack configured: ${SLACK_BOT_TOKEN ? 'Yes' : 'No — set SLACK_BOT_TOKEN env var'}`);
  startDailyScheduler();
});
