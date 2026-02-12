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
// START
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pixlcat Sling API running on port ${PORT}`);
  console.log(`Token configured: ${SLING_TOKEN ? 'Yes' : 'No — set SLING_TOKEN env var'}`);
});
