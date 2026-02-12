‘use strict’;

/**

- Pixlcat Sling API v2.0.0
- Copy-paste into: index.js
- 
- Required env:
- - SLING_TOKEN
- - API_KEY
- - SLACK_SIGNING_SECRET (for /slack/events verification)
- - SLACK_BOT_TOKEN (optional if using bot token)
- - SLACK_WEBHOOK_URL (optional if using webhook)
- - ALLOWED_ORIGINS (optional, comma-separated)
- - PORT (optional)
- - CRON_SECRET (optional)
    */

require(‘dotenv’).config();

const express = require(‘express’);
const crypto = require(‘crypto’);
const cors = require(‘cors’);

// Node 18+ has global fetch. For older Node, install node-fetch and uncomment:
// const fetch = global.fetch || require(‘node-fetch’);
if (typeof fetch === ‘undefined’) {
// eslint-disable-next-line global-require
global.fetch = require(‘node-fetch’); // requires: npm i node-fetch@2
}

const PORT = process.env.PORT || 3000;
const SLING_BASE = ‘https://api.getsling.com’;
const SLING_TOKEN = process.env.SLING_TOKEN;
const API_KEY = process.env.API_KEY;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || ‘’)
.split(’,’)
.map((s) => s.trim())
.filter(Boolean);

const app = express();

app.use(
cors({
origin(origin, cb) {
// allow server-to-server, curl, etc.
if (!origin) return cb(null, true);

```
  // If you want to allow all origins when ALLOWED_ORIGINS is empty, change this.
  if (ALLOWED_ORIGINS.length === 0) return cb(new Error('CORS blocked'), false);

  return cb(null, ALLOWED_ORIGINS.includes(origin));
},
methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
allowedHeaders: [
  'Content-Type',
  'Authorization',
  'X-API-KEY',
  'X-Slack-Signature',
  'X-Slack-Request-Timestamp',
],
```

})
);

// Slack signature verification needs raw body
app.use(
express.json({
verify: (req, res, buf) => {
req.rawBody = buf;
},
})
);

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function requireApiKey(req, res, next) {
if (!API_KEY) return res.status(500).json({ error: ‘API_KEY not configured’ });

const provided =
req.headers[‘x-api-key’] || (req.headers.authorization || ‘’).replace(/^Bearer\s+/i, ‘’);

if (provided !== API_KEY) return res.status(401).json({ error: ‘Unauthorized’ });
next();
}

// Centralized: protect all write, cron, slack-post, and command endpoints
app.use(
[
‘/shifts/create’,
‘/shifts/swap’,
‘/shifts/assign’,
‘/shifts/publish’,
‘/shifts/unpublish’,
‘/cron’,
‘/slack/daily’,
‘/slack/tomorrow’,
‘/slack/week’,
‘/command’,
‘/schedule/validate’,
],
requireApiKey
);

function verifySlackSignature(req) {
if (!SLACK_SIGNING_SECRET) return false;

const timestamp = req.headers[‘x-slack-request-timestamp’];
const sig = req.headers[‘x-slack-signature’];
if (!timestamp || !sig) return false;

const ts = parseInt(timestamp, 10);
if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

const base = ‘v0:’ + timestamp + ‘:’ + (req.rawBody ? req.rawBody.toString(‘utf8’) : ‘’);
const hmac = crypto.createHmac(‘sha256’, SLACK_SIGNING_SECRET).update(base).digest(‘hex’);
const expected = ‘v0=’ + hmac;

try {
return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
} catch {
return false;
}
}

// ============================================================
// SCHEDULING ENGINE CONSTANTS (v2.0)
// ============================================================

const LOCATIONS = {
CLEMENT: 16124319,
NINTH: 16128300,
};

const LOCATION_NAMES = {
[LOCATIONS.CLEMENT]: ‘Clement Pixlcat’,
[LOCATIONS.NINTH]: ‘9th st Pixlcat’,
};

const EMPLOYEE_IDS = {
JESUS: 16159503,
JESSICA: 22563123,
CLAYTON: 22635995,
BRIANNA: 21868029,
HAYDEN: 19838518,
SAIGE: 16764426,
EMILY: 24605713,
OTILIA: 24950241,
MAYA_M: 24950518,
MAYA_L: 13125426,
SARA: 24949126,
ANYA: 16422126,
JAMES: 19506789,
DAVID: 12302285,
JEFFREY: 19763164,
};

const EMPLOYEE_NAMES = {
[EMPLOYEE_IDS.JESUS]: ‘Jesus’,
[EMPLOYEE_IDS.JESSICA]: ‘Jessica’,
[EMPLOYEE_IDS.CLAYTON]: ‘Clayton’,
[EMPLOYEE_IDS.BRIANNA]: ‘Brianna’,
[EMPLOYEE_IDS.HAYDEN]: ‘Hayden’,
[EMPLOYEE_IDS.SAIGE]: ‘Saige’,
[EMPLOYEE_IDS.EMILY]: ‘Emily’,
[EMPLOYEE_IDS.OTILIA]: ‘Otilia’,
[EMPLOYEE_IDS.MAYA_M]: ‘Maya M’,
[EMPLOYEE_IDS.MAYA_L]: ‘Maya L’,
[EMPLOYEE_IDS.SARA]: ‘Sara’,
[EMPLOYEE_IDS.ANYA]: ‘Anya’,
[EMPLOYEE_IDS.JAMES]: ‘James’,
[EMPLOYEE_IDS.DAVID]: ‘David’,
[EMPLOYEE_IDS.JEFFREY]: ‘Jeffrey’,
};

const CROSS_LOCATION_POOL = [
EMPLOYEE_IDS.SARA,
EMPLOYEE_IDS.BRIANNA,
EMPLOYEE_IDS.JAMES,
EMPLOYEE_IDS.EMILY,
EMPLOYEE_IDS.CLAYTON,
EMPLOYEE_IDS.DAVID,
];

const MAX_WEEKLY_HOURS = 40;
const MAX_CONSECUTIVE_DAYS = 7;
const WARN_CONSECUTIVE_DAYS = 6;

const COVERAGE_MINS = {
CLEMENT_WEEKDAY: 2,
CLEMENT_WEEKEND: 2,
NINTH_WEEKDAY: 1,
NINTH_WEEKEND: 2,
};

// ============================================================
// HELPERS
// ============================================================

async function slingGet(path, token) {
const authToken = token || SLING_TOKEN;
if (!authToken) throw new Error(‘No Sling auth token configured’);

const res = await fetch(`${SLING_BASE}${path}`, {
headers: { Authorization: authToken, ‘Content-Type’: ‘application/json’ },
});

if (!res.ok) {
const text = await res.text();
throw new Error(`Sling API ${res.status}: ${text}`);
}

return res.json();
}

async function slingPost(path, body, token) {
const authToken = token || SLING_TOKEN;
if (!authToken) throw new Error(‘No Sling auth token configured’);

const res = await fetch(`${SLING_BASE}${path}`, {
method: ‘POST’,
headers: { Authorization: authToken, ‘Content-Type’: ‘application/json’ },
body: JSON.stringify(body),
});

if (!res.ok) {
const text = await res.text();
throw new Error(`Sling API ${res.status}: ${text}`);
}

return res.json();
}

async function slingPut(path, body, token) {
const authToken = token || SLING_TOKEN;
if (!authToken) throw new Error(‘No Sling auth token configured’);

const res = await fetch(`${SLING_BASE}${path}`, {
method: ‘PUT’,
headers: { Authorization: authToken, ‘Content-Type’: ‘application/json’ },
body: JSON.stringify(body),
});

if (!res.ok) {
const text = await res.text();
throw new Error(`Sling API ${res.status}: ${text}`);
}

return res.json();
}

async function slingDelete(path, token) {
const authToken = token || SLING_TOKEN;
if (!authToken) throw new Error(‘No Sling auth token configured’);

const res = await fetch(`${SLING_BASE}${path}`, {
method: ‘DELETE’,
headers: { Authorization: authToken, ‘Content-Type’: ‘application/json’ },
});

if (!res.ok) {
const text = await res.text();
throw new Error(`Sling API ${res.status}: ${text}`);
}

const text = await res.text();
return text ? JSON.parse(text) : { success: true };
}

function findUserByName(users, name) {
const lower = name.toLowerCase().trim();
return users.find((u) => {
const fullName = `${u.name || ''} ${u.lname || ''}`.toLowerCase();
const firstName = (u.name || ‘’).toLowerCase();
const lastName = (u.lname || ‘’).toLowerCase();
return firstName === lower || lastName === lower || fullName.includes(lower);
});
}

function findPositionByName(positions, name) {
const lower = name.toLowerCase().trim();
return positions.find((p) => (p.name || ‘’).toLowerCase().includes(lower));
}

function resolveEmployeeId(nameOrId) {
if (typeof nameOrId === ‘number’) return nameOrId;
if (typeof nameOrId === ‘string’ && !isNaN(nameOrId)) return parseInt(nameOrId, 10);

const lower = String(nameOrId || ‘’).toLowerCase().trim();
const match = Object.entries(EMPLOYEE_NAMES).find(([, nm]) => nm.toLowerCase() === lower);
return match ? parseInt(match[0], 10) : null;
}

let _cachedSession = null;
async function getSessionInfo() {
if (_cachedSession) return _cachedSession;

const session = await slingGet(’/account/session’);
if (session && session.org && session.org.id) {
_cachedSession = {
orgId: session.org.id,
userId: session.user.id,
memberGroupId: session.org.memberGroupId,
};
return _cachedSession;
}

throw new Error(‘Could not determine session info’);
}

async function getOrgId() {
const s = await getSessionInfo();
return s.orgId;
}

async function getOrgCalendar(dateStart, dateEnd) {
const { orgId, userId } = await getSessionInfo();
const dates = `${dateStart}/${dateEnd}`;

const [calData, users, positions, locations] = await Promise.all([
slingGet(`/${orgId}/calendar/${userId}?dates=${encodeURIComponent(dates)}`),
slingGet(’/users’),
slingGet(’/groups’).then((g) => g.filter((x) => x.type === ‘position’)),
slingGet(’/groups’).then((g) => g.filter((x) => x.type === ‘location’)),
]);

const userMap = {};
users.forEach((u) => {
userMap[u.id] = u;
});
const posMap = {};
positions.forEach((p) => {
posMap[p.id] = p;
});
const locMap = {};
locations.forEach((l) => {
locMap[l.id] = l;
});

const shifts = (Array.isArray(calData) ? calData : [])
.filter((s) => s.type === ‘shift’)
.map((s) => {
const user = s.user ? userMap[s.user.id] : null;
const pos = s.position ? posMap[s.position.id] : null;
const loc = s.location ? locMap[s.location.id] : null;
return {
id: s.id,
employee: user ? `${user.name || ''} ${user.lname || ''}`.trim() : ‘Unassigned’,
employeeId: s.user ? s.user.id : null,
position: pos ? pos.name : null,
positionId: s.position ? s.position.id : null,
location: loc ? loc.name : null,
locationId: s.location ? s.location.id : null,
start: s.dtstart,
end: s.dtend,
duration: (new Date(s.dtend) - new Date(s.dtstart)) / (1000 * 60 * 60),
status: s.status,
published: s.status === ‘published’,
breakDuration: s.breakDuration || 0,
};
});

const leaves = (Array.isArray(calData) ? calData : [])
.filter((s) => s.type === ‘leave’)
.map((s) => {
const user = s.user ? userMap[s.user.id] : null;
return {
id: s.id,
employee: user ? `${user.name || ''} ${user.lname || ''}`.trim() : ‘Unknown’,
employeeId: s.user ? s.user.id : null,
start: s.dtstart,
end: s.dtend,
fullDay: s.fullDay,
note: s.summary || ‘’,
approved: s.approved ? true : false,
};
});

const availability = (Array.isArray(calData) ? calData : [])
.filter((s) => s.type === ‘availability’)
.map((s) => {
const user = s.user ? userMap[s.user.id] : null;
return {
id: s.id,
employee: user ? `${user.name || ''} ${user.lname || ''}`.trim() : ‘Unknown’,
employeeId: s.user ? s.user.id : null,
start: s.dtstart,
end: s.dtend,
fullDay: s.fullDay,
};
});

return { shifts, leaves, availability, userMap, posMap, locMap };
}

const TZ = ‘America/Los_Angeles’;

function getNowPT() {
return new Date(new Date().toLocaleString(‘en-US’, { timeZone: TZ }));
}

function getDayRange(dateStr) {
const nowPT = getNowPT();
let target = new Date(nowPT);

const lower = String(dateStr || ‘’).toLowerCase().trim();
const days = [‘sunday’, ‘monday’, ‘tuesday’, ‘wednesday’, ‘thursday’, ‘friday’, ‘saturday’];
const dayIdx = days.indexOf(lower);

if (lower === ‘today’) {
target = new Date(nowPT);
} else if (lower === ‘tomorrow’) {
target = new Date(nowPT);
target.setDate(target.getDate() + 1);
} else if (lower === ‘yesterday’) {
target = new Date(nowPT);
target.setDate(target.getDate() - 1);
} else if (dayIdx !== -1) {
target = new Date(nowPT);
const diff = dayIdx - target.getDay();
target.setDate(target.getDate() + (diff <= 0 ? diff + 7 : diff));
} else {
target = new Date(dateStr);
}

const y = target.getFullYear();
const m = String(target.getMonth() + 1).padStart(2, ‘0’);
const d = String(target.getDate()).padStart(2, ‘0’);

// Build start/end in PT then convert to UTC ISO strings
const startLocal = new Date(`${y}-${m}-${d}T00:00:00`);
const endLocal = new Date(`${y}-${m}-${d}T23:59:59.999`);
const ptOffsetMs =
startLocal.getTime() -
new Date(startLocal.toLocaleString(‘en-US’, { timeZone: TZ })).getTime();
const startUTC = new Date(startLocal.getTime() + ptOffsetMs);
const endUTC = new Date(endLocal.getTime() + ptOffsetMs);

const dayOfWeek = target.getDay();
return {
start: startUTC.toISOString(),
end: endUTC.toISOString(),
dateFormatted: target.toLocaleDateString(‘en-US’, {
weekday: ‘long’,
month: ‘short’,
day: ‘numeric’,
year: ‘numeric’,
timeZone: TZ,
}),
isoDate: `${y}-${m}-${d}`,
dayOfWeek,
isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
};
}

function toISODatePT(d) {
const dt = d instanceof Date ? d : new Date(d);
return dt.toLocaleDateString(‘en-CA’, { timeZone: TZ });
}

function formatTimePT(d) {
return new Date(d).toLocaleTimeString(‘en-US’, {
hour: ‘numeric’,
minute: ‘2-digit’,
timeZone: TZ,
});
}

function getWeekRange(dateStr) {
const center = dateStr ? new Date(getDayRange(dateStr).start) : getNowPT();
const day = center.getDay();
const monday = new Date(center);
monday.setDate(center.getDate() - (day === 0 ? 6 : day - 1));
monday.setHours(0, 0, 0, 0);

const sunday = new Date(monday);
sunday.setDate(monday.getDate() + 6);
sunday.setHours(23, 59, 59, 999);

return { start: monday.toISOString(), end: sunday.toISOString() };
}

function getWeekKey(date) {
const d = new Date(new Date(date).toLocaleString(‘en-US’, { timeZone: TZ }));
d.setDate(d.getDate() - d.getDay());
return toISODatePT(d);
}

// ============================================================
// HEALTH CHECK / ROOT
// ============================================================

app.get(’/’, (req, res) => {
res.json({
service: ‘Pixlcat Sling API’,
version: ‘2.1.0’,
status: ‘running’,
endpoints: {
‘GET /users’: ‘List all employees’,
‘GET /positions’: ‘List all positions’,
‘GET /locations’: ‘List all locations’,
‘GET /groups’: ‘List all groups’,
‘GET /shifts’: ‘Get shifts (?start=ISO&end=ISO)’,
‘GET /shifts/today’: ‘Today shifts’,
‘GET /shifts/week’: ‘This week shifts’,
‘GET /schedule/:date’: ‘Schedule for a day’,
‘GET /whos-working’: ‘Who is working now’,
‘GET /whos-working/:date’: ‘Who is working on date’,
‘GET /unavailable/:date’: ‘Who is unavailable’,
‘GET /timeoff’: ‘Time-off requests’,
‘GET /calendar/summaries’: ‘Hours/cost summaries’,
‘GET /coverage/:day/:employee’: ‘Find coverage candidates’,
‘POST /shifts/create’: ‘Create shift’,
‘POST /shifts/swap’: ‘Swap employee on shift’,
‘POST /shifts/assign’: ‘Assign employee to shift’,
‘PUT /shifts/:id’: ‘Update shift’,
‘DELETE /shifts/:id’: ‘Delete shift’,
‘POST /shifts/publish’: ‘Publish shifts’,
‘POST /shifts/unpublish’: ‘Unpublish shifts’,
‘GET /conflicts’: ‘Schedule vs availability conflicts (?days=7)’,
‘GET /weekly-hours/:userId’: ‘Cross-location weekly hours (?week=DATE)’,
‘GET /availability/:date’: ‘All employee availability for date’,
‘POST /schedule/validate’: ‘Validate assignment against rules’,
‘GET /schedule/coverage/:date’: ‘Floor headcount by hour’,
‘GET /schedule/consecutive/:userId’: ‘Consecutive day streak (?date=DATE)’,
‘POST /cron/check-conflicts’: ‘Run conflict check + Slack alert’,
‘GET /slack/daily’: ‘Post today schedule to Slack’,
‘GET /slack/tomorrow’: ‘Post tomorrow schedule to Slack’,
‘GET /slack/week’: ‘Post week schedule to Slack’,
‘GET /cron/daily’: ‘External cron endpoint’,
‘POST /slack/events’: ‘Slack Events API handler’,
‘POST /command’: ‘Natural language processor (API key required)’,
},
});
});

// ============================================================
// READ ENDPOINTS
// ============================================================

app.get(’/users’, async (req, res) => {
try {
const data = await slingGet(’/users’);
const users = data.map((u) => ({
id: u.id,
firstName: u.name,
lastName: u.lname,
fullName: `${u.name || ''} ${u.lname || ''}`.trim(),
email: u.email,
phone: u.phone,
avatar: u.avatar,
type: u.type,
active: u.active,
timezone: u.timezone,
hourlyWage: u.hourlyWage,
}));
res.json({ count: users.length, users });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/positions’, async (req, res) => {
try {
const data = await slingGet(’/positions’);
res.json({ count: data.length, positions: data });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/locations’, async (req, res) => {
try {
const data = await slingGet(’/locations’);
res.json({ count: data.length, locations: data });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/groups’, async (req, res) => {
try {
const data = await slingGet(’/groups’);
res.json({ count: data.length, groups: data });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/shifts’, async (req, res) => {
try {
const { start, end, user_id } = req.query;
if (!start || !end)
return res.status(400).json({ error: ‘start and end query params required (ISO dates)’ });

```
const dates = `${start}/${end}`;
let path;

if (user_id) {
  path = `/calendar/${user_id}/shifts?dates=${encodeURIComponent(dates)}`;
} else {
  const { orgId, userId: adminId } = await getSessionInfo();
  path = `/${orgId}/calendar/${adminId}?dates=${encodeURIComponent(dates)}`;
}

const data = await slingGet(path);
res.json(data);
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/shifts/today’, async (req, res) => {
try {
const { start, end, dateFormatted } = getDayRange(‘today’);
const { shifts } = await getOrgCalendar(start, end);
res.json({ date: dateFormatted, count: shifts.length, shifts });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/shifts/week’, async (req, res) => {
try {
const now = new Date();
const startOfWeek = new Date(now);
startOfWeek.setDate(now.getDate() - now.getDay());
startOfWeek.setHours(0, 0, 0, 0);

```
const endOfWeek = new Date(startOfWeek);
endOfWeek.setDate(startOfWeek.getDate() + 6);
endOfWeek.setHours(23, 59, 59, 999);

const { shifts } = await getOrgCalendar(startOfWeek.toISOString(), endOfWeek.toISOString());
const enriched = shifts.map((s) => ({
  ...s,
  day: new Date(s.start).toLocaleDateString('en-US', { weekday: 'long' }),
}));

const byDay = {};
enriched.forEach((s) => {
  if (!byDay[s.day]) byDay[s.day] = [];
  byDay[s.day].push(s);
});

res.json({
  weekOf: startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  totalShifts: enriched.length,
  byDay,
  allShifts: enriched,
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/schedule/:date’, async (req, res) => {
try {
const { start, end, dateFormatted } = getDayRange(req.params.date);
const { shifts } = await getOrgCalendar(start, end);
res.json({ date: dateFormatted, count: shifts.length, shifts });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/whos-working’, async (req, res) => {
try {
const data = await slingGet(’/calendar/working’);
res.json(data);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/whos-working/:date’, async (req, res) => {
try {
const { start, end, dateFormatted } = getDayRange(req.params.date);
const { shifts } = await getOrgCalendar(start, end);

```
const working = shifts
  .filter((s) => s.employeeId)
  .map((s) => ({
    employee: s.employee,
    position: s.position,
    location: s.location,
    start: s.start,
    end: s.end,
  }));

res.json({ date: dateFormatted, working });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/unavailable/:date’, async (req, res) => {
try {
const { start, end, dateFormatted } = getDayRange(req.params.date);
const { leaves, availability } = await getOrgCalendar(start, end);

```
const onLeave = leaves.map((l) => ({
  employee: l.employee,
  employeeId: l.employeeId,
  type: 'leave',
  fullDay: l.fullDay,
  start: l.start,
  end: l.end,
  note: l.note,
}));

const limited = availability
  .filter((a) => !a.fullDay)
  .map((a) => ({
    employee: a.employee,
    employeeId: a.employeeId,
    type: 'limited',
    availableFrom: a.start,
    availableTo: a.end,
  }));

res.json({ date: dateFormatted, onLeave, limitedAvailability: limited });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/timeoff’, async (req, res) => {
try {
const data = await slingGet(’/leave/requests’);
res.json(data);
} catch (err) {
try {
const data = await slingGet(’/leave’);
res.json(data);
} catch (err2) {
res.status(500).json({ error: err2.message });
}
}
});

app.get(’/calendar/summaries’, async (req, res) => {
try {
const { start, end } = req.query;
if (!start || !end) return res.status(400).json({ error: ‘start and end query params required’ });

```
const data = await slingGet(`/calendar/summaries?dates=${encodeURIComponent(`${start}/${end}`)}`);
res.json(data);
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ============================================================
// COVERAGE FINDER
// ============================================================

const STORE_HOURS = {
0: { open: 7, close: 17, shiftEarliest: 6.5, shiftLatest: 18, label: ‘Sunday’ },
1: { open: 7, close: 16, shiftEarliest: 6.5, shiftLatest: 17, label: ‘Monday’ },
2: { open: 7, close: 16, shiftEarliest: 6.5, shiftLatest: 17, label: ‘Tuesday’ },
3: { open: 7, close: 16, shiftEarliest: 6.5, shiftLatest: 17, label: ‘Wednesday’ },
4: { open: 7, close: 16, shiftEarliest: 6.5, shiftLatest: 17, label: ‘Thursday’ },
5: { open: 7, close: 16, shiftEarliest: 6.5, shiftLatest: 17, label: ‘Friday’ },
6: { open: 7, close: 17, shiftEarliest: 6.5, shiftLatest: 18, label: ‘Saturday’ },
};

async function getShiftTemplates() {
const now = new Date();
const fourWeeksAgo = new Date(now);
fourWeeksAgo.setDate(now.getDate() - 28);
fourWeeksAgo.setHours(0, 0, 0, 0);

const { shifts } = await getOrgCalendar(fourWeeksAgo.toISOString(), now.toISOString());
const clementShifts = shifts.filter((s) => (s.location || ‘’).includes(‘Clement’));

const slotCounts = {};
clementShifts.forEach((s) => {
const st = new Date(s.start);
const et = new Date(s.end);
const dayType = st.getDay() === 0 || st.getDay() === 6 ? ‘weekend’ : ‘weekday’;
const startTime = `${st.getHours()}:${String(st.getMinutes()).padStart(2, '0')}`;
const endTime = `${et.getHours()}:${String(et.getMinutes()).padStart(2, '0')}`;
const key = `${s.position || 'Unknown'}|${startTime}|${endTime}|${dayType}`;
if (!slotCounts[key]) {
slotCounts[key] = {
position: s.position || ‘Unknown’,
startTime,
endTime,
hours: (et - st) / (1000 * 60 * 60),
dayType,
count: 0,
};
}
slotCounts[key].count++;
});

return Object.values(slotCounts)
.filter((t) => t.count >= 3)
.sort((a, b) => b.count - a.count);
}

function matchesTemplate(shiftToCover, templates) {
const st = new Date(shiftToCover.start);
const et = new Date(shiftToCover.end);
const dayType = st.getDay() === 0 || st.getDay() === 6 ? ‘weekend’ : ‘weekday’;
const startTime = `${st.getHours()}:${String(st.getMinutes()).padStart(2, '0')}`;
const endTime = `${et.getHours()}:${String(et.getMinutes()).padStart(2, '0')}`;

const exact = templates.find(
(t) =>
t.position === shiftToCover.position &&
t.startTime === startTime &&
t.endTime === endTime &&
t.dayType === dayType
);
if (exact) return { match: ‘exact’, template: exact };

const posMatch = templates.find((t) => t.position === shiftToCover.position && t.dayType === dayType);
if (posMatch) return { match: ‘position’, template: posMatch };

const timeMatch = templates.find((t) => t.startTime === startTime && t.endTime === endTime && t.dayType === dayType);
if (timeMatch) return { match: ‘time’, template: timeMatch };

return { match: ‘none’, template: null };
}

async function getHistoricalAvgHours() {
const now = new Date();
const fourWeeksAgo = new Date(now);
fourWeeksAgo.setDate(now.getDate() - 28);
fourWeeksAgo.setHours(0, 0, 0, 0);

const { shifts } = await getOrgCalendar(fourWeeksAgo.toISOString(), now.toISOString());
const clementShifts = shifts.filter((s) => (s.location || ‘’).includes(‘Clement’));

const byEmployee = {};
clementShifts.forEach((s) => {
if (!s.employeeId) return;
if (!byEmployee[s.employeeId]) byEmployee[s.employeeId] = {};
const wk = getWeekKey(new Date(s.start));
if (!byEmployee[s.employeeId][wk]) byEmployee[s.employeeId][wk] = 0;
byEmployee[s.employeeId][wk] += (new Date(s.end) - new Date(s.start)) / (1000 * 60 * 60);
});

const avgHours = {};
for (const [empId, weeks] of Object.entries(byEmployee)) {
const hrs = Object.values(weeks);
avgHours[empId] = {
avg: hrs.reduce((a, b) => a + b, 0) / hrs.length,
min: Math.min(…hrs),
max: Math.max(…hrs),
weeks: hrs.length,
};
}

return avgHours;
}

async function getDaySalesContext(targetDate) {
try {
const dayOfWeek = targetDate.getDay();
const toastRes = await fetch(‘https://toast-api-1.onrender.com/api/sales/summary’);
if (toastRes.ok) {
const salesData = await toastRes.json();
return {
dayName: STORE_HOURS[dayOfWeek].label,
isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
isPeak: dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6,
storeHours: STORE_HOURS[dayOfWeek],
salesData,
};
}
} catch (e) {
// fallback below
}

const dayOfWeek = targetDate.getDay();
const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
return {
dayName: STORE_HOURS[dayOfWeek].label,
isWeekend,
isPeak: isWeekend || dayOfWeek === 5,
storeHours: STORE_HOURS[dayOfWeek],
avgRevenue: isWeekend ? 3610 : 1807,
avgTickets: isWeekend ? 292 : 169,
};
}

async function findCoverage(targetDay, targetEmployeeName) {
const { start, end, dateFormatted } = getDayRange(targetDay);

const targetDate = new Date(start);
const weekStart = new Date(targetDate);
weekStart.setDate(targetDate.getDate() - targetDate.getDay());
weekStart.setHours(0, 0, 0, 0);

const weekEnd = new Date(weekStart);
weekEnd.setDate(weekStart.getDate() + 6);
weekEnd.setHours(23, 59, 59, 999);

const streakStart = new Date(targetDate);
streakStart.setDate(targetDate.getDate() - 6);
streakStart.setHours(0, 0, 0, 0);

const streakEnd = new Date(targetDate);
streakEnd.setDate(targetDate.getDate() + 6);
streakEnd.setHours(23, 59, 59, 999);

const [weekData, streakData, allUsers, historicalAvg, salesContext, shiftTemplates] =
await Promise.all([
getOrgCalendar(weekStart.toISOString(), weekEnd.toISOString()),
getOrgCalendar(streakStart.toISOString(), streakEnd.toISOString()),
slingGet(’/users’),
getHistoricalAvgHours(),
getDaySalesContext(targetDate),
getShiftTemplates(),
]);

const { shifts: weekShifts, leaves: weekLeaves, availability: weekAvail } = weekData;
const { shifts: streakShifts } = streakData;

const shiftDateStr = targetDate.toDateString();

const targetShifts = weekShifts.filter((s) => {
const isTargetDate = new Date(s.start).toDateString() === shiftDateStr;
if (!targetEmployeeName) return isTargetDate;
return isTargetDate && s.employee.toLowerCase().includes(targetEmployeeName.toLowerCase());
});

if (targetShifts.length === 0)
return { error: `No shift found for ${targetEmployeeName || 'anyone'} on ${dateFormatted}` };

const shiftToCover = targetShifts[0];
const shiftHours = (new Date(shiftToCover.end) - new Date(shiftToCover.start)) / (1000 * 60 * 60);

const clementEmployeeIds = new Set();
weekShifts
.filter((s) => (s.location || ‘’).includes(‘Clement’))
.forEach((s) => {
if (s.employeeId) clementEmployeeIds.add(s.employeeId);
});
streakShifts
.filter((s) => (s.location || ‘’).includes(‘Clement’))
.forEach((s) => {
if (s.employeeId) clementEmployeeIds.add(s.employeeId);
});
weekAvail.forEach((a) => {
if (a.employeeId) clementEmployeeIds.add(a.employeeId);
});

const candidates = [];

for (const empId of clementEmployeeIds) {
if (empId === shiftToCover.employeeId) continue;

```
const user = allUsers.find((u) => u.id === empId);
if (!user) continue;

const empName = `${user.name || ''} ${user.lname || ''}`.trim();
const reasons = [];
const warnings = [];
const notes = [];

// Already working?
const alreadyWorking = weekShifts.filter(
  (s) => s.employeeId === empId && new Date(s.start).toDateString() === shiftDateStr
);
if (alreadyWorking.length > 0) {
  const existing = alreadyWorking[0];
  const st = formatTimePT(existing.start);
  const et = formatTimePT(existing.end);
  if (new Date(existing.start) < new Date(shiftToCover.end) && new Date(existing.end) > new Date(shiftToCover.start)) {
    reasons.push(`Already working ${st}-${et} (overlaps)`);
  } else {
    warnings.push(`Already has a shift ${st}-${et} (no overlap -- double possible)`);
  }
}

// On leave?
const onLeave = weekLeaves.some(
  (l) => l.employeeId === empId && new Date(l.start) <= targetDate && new Date(l.end) >= targetDate
);
if (onLeave) {
  const leave = weekLeaves.find(
    (l) => l.employeeId === empId && new Date(l.start) <= targetDate && new Date(l.end) >= targetDate
  );
  reasons.push(`On leave${leave && leave.note ? ` -- ${leave.note}` : ''}`);
}

// Availability?
const dayAvail = weekAvail.filter(
  (a) => a.employeeId === empId && new Date(a.start).toDateString() === shiftDateStr
);
if (dayAvail.length > 0) {
  const hasFullDay = dayAvail.some((a) => a.fullDay);
  if (!hasFullDay) {
    const fits = dayAvail.some(
      (a) => new Date(shiftToCover.start) >= new Date(a.start) && new Date(shiftToCover.end) <= new Date(a.end)
    );
    if (!fits) {
      const windows = dayAvail.map((a) => `${formatTimePT(a.start)}-${formatTimePT(a.end)}`).join(', ');
      reasons.push(`Only available ${windows} (shift doesn't fit)`);
    } else {
      notes.push('Available window covers this shift');
    }
  }
} else {
  if (weekAvail.some((a) => a.employeeId === empId)) {
    reasons.push(`No availability set for ${STORE_HOURS[targetDate.getDay()].label}`);
  }
}

// 40hr cap?
let weeklyHours = 0;
weekShifts
  .filter((s) => s.employeeId === empId)
  .forEach((s) => {
    weeklyHours += (new Date(s.end) - new Date(s.start)) / (1000 * 60 * 60);
  });
const projectedHours = weeklyHours + shiftHours;
if (projectedHours > 40) reasons.push(`Would hit ${projectedHours.toFixed(1)}hrs (40hr max)`);

// Consecutive?
const streakDatesWorked = new Set(
  streakShifts
    .filter((s) => s.employeeId === empId)
    .map((s) => new Date(s.start).toDateString())
);
streakDatesWorked.add(shiftDateStr);

let maxConsecutive = 0;
let current = 0;
for (let d = new Date(streakStart); d <= streakEnd; d.setDate(d.getDate() + 1)) {
  if (streakDatesWorked.has(d.toDateString())) {
    current++;
    maxConsecutive = Math.max(maxConsecutive, current);
  } else {
    current = 0;
  }
}

if (maxConsecutive >= MAX_CONSECUTIVE_DAYS) reasons.push(`Would be ${maxConsecutive} consecutive days (${MAX_CONSECUTIVE_DAYS} max)`);
else if (maxConsecutive >= WARN_CONSECUTIVE_DAYS) warnings.push(`This would be their ${maxConsecutive}th consecutive day`);

const shiftsThisWeek = weekShifts.filter((s) => s.employeeId === empId).length;
if (shiftsThisWeek + 1 === 6) warnings.push('This would be their 6th shift this week');
else if (shiftsThisWeek + 1 > 6) warnings.push(`Would be shift #${shiftsThisWeek + 1} this week`);

const hist = historicalAvg[empId];
if (hist) {
  if (projectedHours - hist.avg > 8) warnings.push(`${(projectedHours - hist.avg).toFixed(1)}hrs above usual ${hist.avg.toFixed(1)}hrs/week`);
  notes.push(`Usually ${hist.avg.toFixed(1)}hrs/wk (${hist.min.toFixed(0)}-${hist.max.toFixed(0)} range)`);
}

notes.push(`${weeklyHours.toFixed(1)}hrs this week -> ${projectedHours.toFixed(1)}hrs if covering`);

candidates.push({
  employee: empName,
  employeeId: empId,
  available: reasons.length === 0,
  reasons,
  warnings,
  notes,
  weeklyHours,
  projectedHours,
  historicalAvg: hist ? hist.avg : null,
});
```

}

candidates.sort((a, b) => {
if (a.available && !b.available) return -1;
if (!a.available && b.available) return 1;
if (a.available && b.available) return a.projectedHours - b.projectedHours;
return 0;
});

const templateMatch = matchesTemplate(shiftToCover, shiftTemplates);

return {
date: dateFormatted,
dayContext: {
dayName: salesContext.dayName,
isPeak: salesContext.isPeak,
storeHours: `${salesContext.storeHours.open}AM-${ salesContext.storeHours.close > 12 ? salesContext.storeHours.close - 12 + 'PM' : salesContext.storeHours.close + 'AM' }`,
shiftWindow: `${ salesContext.storeHours.shiftEarliest % 1 === 0.5 ? Math.floor(salesContext.storeHours.shiftEarliest) + ':30AM' : salesContext.storeHours.shiftEarliest + 'AM' }-${ salesContext.storeHours.shiftLatest > 12 ? salesContext.storeHours.shiftLatest - 12 + 'PM' : salesContext.storeHours.shiftLatest + 'AM' }`,
avgRevenue: salesContext.avgRevenue,
avgTickets: salesContext.avgTickets,
},
shiftToCover: {
employee: shiftToCover.employee,
position: shiftToCover.position,
location: shiftToCover.location,
start: shiftToCover.start,
end: shiftToCover.end,
hours: shiftHours,
},
templateMatch:
templateMatch.match !== ‘none’
? {
matchType: templateMatch.match,
position: templateMatch.template.position,
slot: `${templateMatch.template.startTime}-${templateMatch.template.endTime}`,
frequency: `${templateMatch.template.count}x in last 4 weeks`,
dayType: templateMatch.template.dayType,
}
: null,
candidates,
};
}

app.get(’/coverage/:day/:employee’, async (req, res) => {
try {
const result = await findCoverage(req.params.day, req.params.employee);
res.json(result);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ============================================================
// WRITE ENDPOINTS
// ============================================================

app.post(’/shifts/create’, async (req, res) => {
try {
const { employee, position, location, date, startTime, endTime, publish } = req.body;

```
const users = await slingGet('/users');
let userId = null;
if (employee) {
  const user = findUserByName(users, employee);
  if (!user)
    return res.status(404).json({
      error: `Employee "${employee}" not found`,
      availableUsers: users.map((u) => `${u.name} ${u.lname}`.trim()),
    });
  userId = user.id;
}

let positionId = null;
if (position) {
  const positions = await slingGet('/positions');
  const pos = findPositionByName(positions, position);
  if (!pos) return res.status(404).json({ error: `Position "${position}" not found` });
  positionId = pos.id;
}

let locationId = null;
if (location) {
  const locations = await slingGet('/locations');
  const loc = locations.find((l) => (l.name || '').toLowerCase().includes(location.toLowerCase()));
  if (loc) locationId = loc.id;
}

const { start: dayStart } = getDayRange(date);
const dayDate = new Date(dayStart);
const [sh, sm] = (startTime || '07:00').split(':').map(Number);
const [eh, em] = (endTime || '15:00').split(':').map(Number);

const dtstart = new Date(dayDate);
dtstart.setHours(sh, sm, 0, 0);
const dtend = new Date(dayDate);
dtend.setHours(eh, em, 0, 0);

const shiftBody = { dtstart: dtstart.toISOString(), dtend: dtend.toISOString(), type: 'shift' };
if (userId) shiftBody.user = { id: userId };
if (positionId) shiftBody.position = { id: positionId };
if (locationId) shiftBody.location = { id: locationId };
if (publish) shiftBody.status = 'published';

const result = await slingPost(`/shifts?publish=${publish ? 'true' : 'false'}`, [shiftBody]);

res.json({
  success: true,
  message: `Shift created for ${employee || 'unassigned'} on ${date} (${startTime || '07:00'}-${endTime || '15:00'})`,
  shift: result,
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/shifts/swap’, async (req, res) => {
try {
const { currentEmployee, newEmployee, date, shiftId } = req.body;

```
const users = await slingGet('/users');
const currentUser = findUserByName(users, currentEmployee);
const newUser = findUserByName(users, newEmployee);

if (!currentUser) return res.status(404).json({ error: `Current employee "${currentEmployee}" not found` });
if (!newUser) return res.status(404).json({ error: `New employee "${newEmployee}" not found` });

let targetShiftId = shiftId;

if (!targetShiftId && date) {
  const { start, end } = getDayRange(date);
  const { shifts: allShifts } = await getOrgCalendar(start, end);

  const shifts = allShifts.filter((s) => s.employeeId === currentUser.id);
  if (shifts.length === 0) return res.status(404).json({ error: `No shift found for ${currentEmployee} on ${date}` });

  if (shifts.length > 1)
    return res.json({
      error: `Multiple shifts found for ${currentEmployee} on ${date}. Specify shiftId.`,
      shifts: shifts.map((s) => ({ id: s.id, start: s.start, end: s.end, position: s.position })),
    });

  targetShiftId = shifts[0].id;
}

if (!targetShiftId) return res.status(400).json({ error: 'Need either shiftId or date' });

const result = await slingPut(`/shifts/${targetShiftId}`, { user: { id: newUser.id } });
res.json({ success: true, message: `Swapped ${currentEmployee} -> ${newEmployee}`, shiftId: targetShiftId, result });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/shifts/assign’, async (req, res) => {
try {
const { employee, position, date, startTime, endTime, publish } = req.body;

```
const users = await slingGet('/users');
const user = findUserByName(users, employee);
if (!user) return res.status(404).json({ error: `Employee "${employee}" not found` });

const { start, end, dateFormatted } = getDayRange(date);
const { shifts: allShifts } = await getOrgCalendar(start, end);

const unassigned = allShifts.filter((s) => !s.employeeId);

let positionMatch = null;
if (position) {
  const positions = await slingGet('/positions');
  positionMatch = findPositionByName(positions, position);
}

const matchingUnassigned = unassigned.filter((s) => {
  if (!positionMatch) return true;
  return s.positionId === positionMatch.id;
});

if (matchingUnassigned.length > 0) {
  const shift = matchingUnassigned[0];
  const result = await slingPut(`/shifts/${shift.id}`, { user: { id: user.id } });
  return res.json({
    success: true,
    message: `Assigned ${employee} to existing shift on ${dateFormatted}`,
    shiftId: shift.id,
    result,
  });
}

// No unassigned shift found -> create one
const { start: dayStart } = getDayRange(date);
const dayDate = new Date(dayStart);

const [sh, sm] = (startTime || '07:00').split(':').map(Number);
const [eh, em] = (endTime || '15:00').split(':').map(Number);

const dtstart = new Date(dayDate);
dtstart.setHours(sh, sm, 0, 0);

const dtend = new Date(dayDate);
dtend.setHours(eh, em, 0, 0);

const shiftBody = { dtstart: dtstart.toISOString(), dtend: dtend.toISOString(), type: 'shift', user: { id: user.id } };
if (positionMatch) shiftBody.position = { id: positionMatch.id };

const result = await slingPost(`/shifts?publish=${publish ? 'true' : 'false'}`, [shiftBody]);

res.json({
  success: true,
  message: `Created shift for ${employee} on ${dateFormatted} (${startTime || '07:00'}-${endTime || '15:00'})`,
  result,
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.put(’/shifts/:id’, requireApiKey, async (req, res) => {
try {
const result = await slingPut(`/shifts/${req.params.id}`, req.body);
res.json({ success: true, result });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.delete(’/shifts/:id’, requireApiKey, async (req, res) => {
try {
const result = await slingDelete(`/shifts/${req.params.id}`);
res.json({ success: true, message: `Shift ${req.params.id} deleted`, result });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/shifts/publish’, async (req, res) => {
try {
const { start, end } = req.body;
if (!start || !end) return res.status(400).json({ error: ‘start and end required’ });

```
const result = await slingPost(`/shifts/publish?dates=${encodeURIComponent(`${start}/${end}`)}`, {});
res.json({ success: true, message: `Published shifts ${start} to ${end}`, result });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/shifts/unpublish’, async (req, res) => {
try {
const { shiftIds } = req.body;
const result = await slingPost(’/shifts/unpublish’, shiftIds || []);
res.json({ success: true, result });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ============================================================
// SCHEDULING ENGINE v2.0 – NEW ENDPOINTS
// ============================================================

// GET /availability/:date
app.get(’/availability/:date’, async (req, res) => {
try {
const { start, end, dateFormatted, isoDate, isWeekend } = getDayRange(req.params.date);
const { shifts, leaves, availability } = await getOrgCalendar(start, end);

```
const employees = Object.entries(EMPLOYEE_NAMES).map(([idStr, name]) => {
  const uid = parseInt(idStr, 10);

  const hasLeave = leaves.find((l) => l.employeeId === uid);
  if (hasLeave) return { userId: uid, name, status: 'ON_LEAVE', windows: [], note: hasLeave.note || '' };

  const empAvails = availability.filter((a) => a.employeeId === uid);
  if (empAvails.length > 0) {
    if (empAvails.some((a) => a.fullDay))
      return { userId: uid, name, status: 'AVAILABLE_FULL_DAY', windows: [{ start: '00:00', end: '23:59' }] };

    return {
      userId: uid,
      name,
      status: 'AVAILABLE_PARTIAL',
      windows: empAvails.map((a) => ({ start: formatTimePT(a.start), end: formatTimePT(a.end) })),
    };
  }

  return { userId: uid, name, status: 'NO_AVAILABILITY_SUBMITTED', windows: [] };
});

const scheduled = shifts
  .filter((s) => s.employeeId)
  .map((s) => ({
    userId: s.employeeId,
    name: s.employee,
    position: s.position,
    location: s.location,
    start: formatTimePT(s.start),
    end: formatTimePT(s.end),
  }));

res.json({ date: dateFormatted, isoDate, isWeekend, employees: employees.sort((a, b) => a.name.localeCompare(b.name)), scheduled });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// GET /conflicts
app.get(’/conflicts’, async (req, res) => {
try {
const days = parseInt(req.query.days, 10) || 7;

```
const now = new Date();
const endDate = new Date(now);
endDate.setDate(now.getDate() + days);
endDate.setHours(23, 59, 59, 999);

const { shifts, leaves, availability } = await getOrgCalendar(now.toISOString(), endDate.toISOString());

const conflicts = [];

const leaveByUserDate = {};
leaves.forEach((l) => {
  const s = new Date(l.start);
  const e = new Date(l.end);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    leaveByUserDate[`${l.employeeId}-${d.toDateString()}`] = l;
  }
});

const availByUserDate = {};
availability.forEach((a) => {
  const key = `${a.employeeId}-${new Date(a.start).toDateString()}`;
  if (!availByUserDate[key]) availByUserDate[key] = [];
  availByUserDate[key].push(a);
});

const assignedShifts = shifts.filter((s) => s.employeeId);

assignedShifts.forEach((shift) => {
  const uid = shift.employeeId;
  const shiftDateStr = new Date(shift.start).toDateString();
  const shiftDate = toISODatePT(new Date(shift.start));
  const empName = shift.employee;

  if (leaveByUserDate[`${uid}-${shiftDateStr}`]) {
    conflicts.push({
      type: 'LEAVE_CONFLICT',
      severity: 'RED',
      employee: empName,
      employeeId: uid,
      date: shiftDate,
      message: `${empName} scheduled on ${shiftDate} but has approved leave.`,
    });
  }

  const avails = availByUserDate[`${uid}-${shiftDateStr}`];
  if (avails && avails.length > 0 && !avails.some((a) => a.fullDay)) {
    const fits = avails.some((a) => new Date(shift.start) >= new Date(a.start) && new Date(shift.end) <= new Date(a.end));
    if (!fits) {
      const windows = avails.map((a) => `${formatTimePT(a.start)}-${formatTimePT(a.end)}`);
      conflicts.push({
        type: 'AVAILABILITY_CONFLICT',
        severity: 'RED',
        employee: empName,
        employeeId: uid,
        date: shiftDate,
        message: `${empName} scheduled outside availability on ${shiftDate}. Windows: ${windows.join(', ')}`,
      });
    }
  }

  if (CROSS_LOCATION_POOL.includes(uid)) {
    const sameDay = assignedShifts.filter(
      (s) =>
        s.employeeId === uid &&
        new Date(s.start).toDateString() === shiftDateStr &&
        s.locationId !== shift.locationId &&
        s.locationId &&
        shift.locationId
    );

    if (sameDay.length > 0 && shift.locationId === LOCATIONS.CLEMENT) {
      conflicts.push({
        type: 'CROSS_LOCATION_CONFLICT',
        severity: 'RED',
        employee: empName,
        employeeId: uid,
        date: shiftDate,
        message: `${empName} scheduled at BOTH locations on ${shiftDate}.`,
      });
    }
  }
});

const seen = new Set();
const unique = conflicts.filter((c) => {
  const key = `${c.type}-${c.employeeId}-${c.date}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

res.json({
  period: `${toISODatePT(now)} to ${toISODatePT(endDate)}`,
  days,
  conflictCount: unique.length,
  conflicts: unique.sort((a, b) => a.date.localeCompare(b.date)),
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// GET /weekly-hours/:userId
app.get(’/weekly-hours/:userId’, async (req, res) => {
try {
const userId = parseInt(req.params.userId, 10);
const empName = EMPLOYEE_NAMES[userId] || `ID:${userId}`;

```
const { start, end } = getWeekRange(req.query.week || 'today');
const { shifts } = await getOrgCalendar(start, end);
const empShifts = shifts.filter((s) => s.employeeId === userId);

let totalHours = 0;
let clementHours = 0;
let ninthHours = 0;

const dailyBreakdown = {};
empShifts.forEach((s) => {
  const hours = s.duration || (new Date(s.end) - new Date(s.start)) / 3600000;
  const dateKey = toISODatePT(new Date(s.start));

  totalHours += hours;

  if (s.locationId === LOCATIONS.CLEMENT || (s.location || '').includes('Clement')) clementHours += hours;
  else if (s.locationId === LOCATIONS.NINTH || (s.location || '').includes('9th')) ninthHours += hours;

  if (!dailyBreakdown[dateKey]) dailyBreakdown[dateKey] = { shifts: [], totalHours: 0 };

  dailyBreakdown[dateKey].shifts.push({
    start: s.start,
    end: s.end,
    hours: Math.round(hours * 100) / 100,
    position: s.position,
    location: s.location,
  });

  dailyBreakdown[dateKey].totalHours += hours;
});

Object.values(dailyBreakdown).forEach((d) => {
  d.totalHours = Math.round(d.totalHours * 100) / 100;
});

res.json({
  employee: empName,
  employeeId: userId,
  weekOf: start.slice(0, 10),
  totalHours: Math.round(totalHours * 100) / 100,
  clementHours: Math.round(clementHours * 100) / 100,
  ninthStHours: Math.round(ninthHours * 100) / 100,
  maxWeeklyHours: MAX_WEEKLY_HOURS,
  remainingBeforeOT: Math.round(Math.max(0, MAX_WEEKLY_HOURS - totalHours) * 100) / 100,
  wouldExceedCap: totalHours > MAX_WEEKLY_HOURS,
  shiftCount: empShifts.length,
  dailyBreakdown,
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// GET /schedule/coverage/:date
app.get(’/schedule/coverage/:date’, async (req, res) => {
try {
const { start, end, dateFormatted, isWeekend } = getDayRange(req.params.date);
const { shifts } = await getOrgCalendar(start, end);

```
const hours = [];
for (let h = 6; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    const timeDate = new Date(start);
    timeDate.setHours(h, m, 0, 0);

    const clementOnFloor = shifts.filter(
      (s) => (s.location || '').includes('Clement') && new Date(s.start) <= timeDate && new Date(s.end) > timeDate
    );
    const ninthOnFloor = shifts.filter(
      (s) => (s.location || '').includes('9th') && new Date(s.start) <= timeDate && new Date(s.end) > timeDate
    );

    if (clementOnFloor.length > 0 || ninthOnFloor.length > 0) {
      hours.push({
        time: timeStr,
        clement: {
          count: clementOnFloor.length,
          employees: clementOnFloor.map((s) => ({ name: s.employee, position: s.position })),
        },
        ninthSt: {
          count: ninthOnFloor.length,
          employees: ninthOnFloor.map((s) => ({ name: s.employee, position: s.position })),
        },
      });
    }
  }
}

const clementMin = COVERAGE_MINS[isWeekend ? 'CLEMENT_WEEKEND' : 'CLEMENT_WEEKDAY'];
const ninthMin = COVERAGE_MINS[isWeekend ? 'NINTH_WEEKEND' : 'NINTH_WEEKDAY'];

const warnings = hours
  .filter((h) => (h.clement.count > 0 && h.clement.count < clementMin) || (h.ninthSt.count > 0 && h.ninthSt.count < ninthMin))
  .map((h) => ({
    time: h.time,
    issue:
      h.clement.count > 0 && h.clement.count < clementMin
        ? `Clement: ${h.clement.count} staff (min: ${clementMin})`
        : `9th St: ${h.ninthSt.count} staff (min: ${ninthMin})`,
  }));

const cc = hours.filter((h) => h.clement.count > 0).map((h) => h.clement.count);
const nc = hours.filter((h) => h.ninthSt.count > 0).map((h) => h.ninthSt.count);

res.json({
  date: dateFormatted,
  isWeekend,
  coverage: hours,
  warnings,
  summary: {
    clementPeak: cc.length ? Math.max(...cc) : 0,
    clementMin: cc.length ? Math.min(...cc) : 0,
    ninthStPeak: nc.length ? Math.max(...nc) : 0,
    warningCount: warnings.length,
  },
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// GET /schedule/consecutive/:userId
app.get(’/schedule/consecutive/:userId’, async (req, res) => {
try {
const userId = parseInt(req.params.userId, 10);
const empName = EMPLOYEE_NAMES[userId] || `ID:${userId}`;

```
const centerDate = req.query.date ? new Date(getDayRange(req.query.date).start) : new Date();

const rangeStart = new Date(centerDate);
rangeStart.setDate(centerDate.getDate() - 10);
rangeStart.setHours(0, 0, 0, 0);

const rangeEnd = new Date(centerDate);
rangeEnd.setDate(centerDate.getDate() + 10);
rangeEnd.setHours(23, 59, 59, 999);

const { shifts } = await getOrgCalendar(rangeStart.toISOString(), rangeEnd.toISOString());
const empShifts = shifts.filter((s) => s.employeeId === userId);

const workDates = new Set(empShifts.map((s) => new Date(s.start).toDateString()));

const allDates = [];
for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) allDates.push(new Date(d));

let centerStreak = [];
let activeStreak = [];
let longestStreak = [];

for (const date of allDates) {
  if (workDates.has(date.toDateString())) {
    activeStreak.push(toISODatePT(date));
  } else {
    if (activeStreak.length > longestStreak.length) longestStreak = [...activeStreak];
    if (activeStreak.some((d) => d === toISODatePT(centerDate))) centerStreak = [...activeStreak];
    activeStreak = [];
  }
}

if (activeStreak.length > longestStreak.length) longestStreak = [...activeStreak];
if (activeStreak.some((d) => d === toISODatePT(centerDate))) centerStreak = [...activeStreak];

res.json({
  employee: empName,
  employeeId: userId,
  centerDate: toISODatePT(centerDate),
  currentStreak: centerStreak.length,
  currentStreakDates: centerStreak,
  longestStreak: longestStreak.length,
  longestStreakDates: longestStreak,
  violations: {
    hardBlock: centerStreak.length >= MAX_CONSECUTIVE_DAYS,
    needsApproval: centerStreak.length >= WARN_CONSECUTIVE_DAYS && centerStreak.length < MAX_CONSECUTIVE_DAYS,
  },
  workDatesInRange: [...workDates].map((d) => toISODatePT(new Date(d))).sort(),
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// POST /schedule/validate
app.post(’/schedule/validate’, async (req, res) => {
try {
const { employeeId, employee, date, startTime, endTime, location } = req.body;

```
const userId = employeeId ? parseInt(employeeId, 10) : resolveEmployeeId(employee);
if (!userId) return res.status(400).json({ error: `Employee not found: ${employee || employeeId}` });
if (!date) return res.status(400).json({ error: 'date required' });

const empName = EMPLOYEE_NAMES[userId] || `ID:${userId}`;
const { start, end, isoDate } = getDayRange(date);

const violations = [];
const warnings = [];

let targetLocId = LOCATIONS.CLEMENT;
if (location) {
  if (typeof location === 'string' && location.toLowerCase().includes('9th')) targetLocId = LOCATIONS.NINTH;
  else if (typeof location === 'number') targetLocId = location;
}

// GATE 1: Availability + Leave
const { shifts: dayShifts, leaves: dayLeaves, availability: dayAvails } = await getOrgCalendar(start, end);

const hasLeave = dayLeaves.find((l) => l.employeeId === userId);
if (hasLeave) violations.push({ rule: 'LEAVE-001', severity: 'RED', message: `${empName} has approved leave on ${isoDate}.` });

const empAvails = dayAvails.filter((a) => a.employeeId === userId);
if (empAvails.length > 0 && startTime && endTime) {
  if (!empAvails.some((a) => a.fullDay)) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const shiftStartMin = sh * 60 + (sm || 0);
    const shiftEndMin = eh * 60 + (em || 0);

    const fitsAny = empAvails.some((a) => {
      const aS = new Date(a.start);
      const aE = new Date(a.end);
      return (
        shiftStartMin >= aS.getHours() * 60 + aS.getMinutes() &&
        shiftEndMin <= aE.getHours() * 60 + aE.getMinutes()
      );
    });

    if (!fitsAny) {
      const windows = empAvails.map((a) => `${formatTimePT(a.start)}-${formatTimePT(a.end)}`);
      violations.push({
        rule: 'AVAIL-001',
        severity: 'RED',
        message: `${empName} not available for ${startTime}-${endTime} on ${isoDate}. Windows: ${windows.join(', ')}`,
      });
    }
  }
} else if (empAvails.length === 0 && !hasLeave) {
  warnings.push({ rule: 'AVAIL-FALLBACK', severity: 'YELLOW', message: `${empName} has not submitted availability for ${isoDate}.` });
}

// GATE 2: Cross-location
if (CROSS_LOCATION_POOL.includes(userId)) {
  const otherLocId = targetLocId === LOCATIONS.CLEMENT ? LOCATIONS.NINTH : LOCATIONS.CLEMENT;

  const otherLocShift = dayShifts.find(
    (s) =>
      s.employeeId === userId &&
      (s.locationId === otherLocId ||
        (otherLocId === LOCATIONS.NINTH && (s.location || '').includes('9th')) ||
        (otherLocId === LOCATIONS.CLEMENT && (s.location || '').includes('Clement')))
  );

  if (otherLocShift) violations.push({ rule: 'XLOC-001', severity: 'RED', message: `${empName} already scheduled at ${LOCATION_NAMES[otherLocId]} on ${isoDate}.` });
}

// GATE 3: Weekly hours
const { start: weekStart, end: weekEnd } = getWeekRange(isoDate);
const { shifts: weekShifts } = await getOrgCalendar(weekStart, weekEnd);

const weeklyHours = weekShifts
  .filter((s) => s.employeeId === userId)
  .reduce((sum, s) => sum + (s.duration || (new Date(s.end) - new Date(s.start)) / 3600000), 0);

let proposedHours = 0;
if (startTime && endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  proposedHours = (eh * 60 + (em || 0) - (sh * 60 + (sm || 0))) / 60;
}

const projectedHours = weeklyHours + proposedHours;
if (projectedHours > MAX_WEEKLY_HOURS) {
  violations.push({
    rule: 'HOURS-001',
    severity: 'ORANGE',
    message: `${empName} would have ${projectedHours.toFixed(1)}hrs this week (max: ${MAX_WEEKLY_HOURS}).`,
    currentHours: Math.round(weeklyHours * 100) / 100,
    projectedHours: Math.round(projectedHours * 100) / 100,
  });
}

// GATE 4: Consecutive days
const streakStart = new Date(start);
streakStart.setDate(streakStart.getDate() - 8);
const streakEnd = new Date(start);
streakEnd.setDate(streakEnd.getDate() + 8);

const { shifts: streakShifts } = await getOrgCalendar(streakStart.toISOString(), streakEnd.toISOString());

const workDates = new Set(streakShifts.filter((s) => s.employeeId === userId).map((s) => new Date(s.start).toDateString()));
workDates.add(new Date(start).toDateString());

let streak = 1;
let checkDate = new Date(start);
while (true) {
  checkDate.setDate(checkDate.getDate() - 1);
  if (workDates.has(checkDate.toDateString())) streak++;
  else break;
}

checkDate = new Date(start);
while (true) {
  checkDate.setDate(checkDate.getDate() + 1);
  if (workDates.has(checkDate.toDateString())) streak++;
  else break;
}

if (streak >= MAX_CONSECUTIVE_DAYS) violations.push({ rule: 'CONSEC-001', severity: 'RED', message: `${empName} would work ${streak} consecutive days. HARD BLOCK.`, consecutiveDays: streak });
else if (streak >= WARN_CONSECUTIVE_DAYS) violations.push({ rule: 'CONSEC-002', severity: 'ORANGE', message: `${empName} would work ${streak} consecutive days. Requires approval.`, consecutiveDays: streak });

const redV = violations.filter((v) => v.severity === 'RED');
const orangeV = violations.filter((v) => v.severity === 'ORANGE');

let status;
if (redV.length > 0) status = 'BLOCKED';
else if (orangeV.length > 0) status = 'NEEDS_APPROVAL';
else if (warnings.length > 0) status = 'UNCONFIRMED';
else status = 'APPROVED';

res.json({
  status,
  employee: empName,
  employeeId: userId,
  date: isoDate,
  proposedShift: startTime && endTime ? `${startTime}-${endTime}` : 'unspecified',
  location: LOCATION_NAMES[targetLocId] || 'Unknown',
  violations,
  warnings,
  weeklyHours: Math.round(weeklyHours * 100) / 100,
  projectedHours: Math.round(projectedHours * 100) / 100,
  consecutiveDays: streak,
  summary:
    status === 'BLOCKED'
      ? `BLOCKED: ${redV.map((v) => v.rule).join(', ')}`
      : status === 'NEEDS_APPROVAL'
      ? `HOLD: ${orangeV.map((v) => v.rule).join(', ')}`
      : status === 'UNCONFIRMED'
      ? `Availability unconfirmed for ${empName} on ${isoDate}`
      : `${empName} passes all checks for ${isoDate}`,
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// POST /cron/check-conflicts
app.post(’/cron/check-conflicts’, async (req, res) => {
try {
const confRes = await fetch(`http://127.0.0.1:${PORT}/conflicts?days=7`);
const conflicts = await confRes.json();

```
if (conflicts.conflictCount === 0) return res.json({ message: 'No conflicts found', alerted: false });

const { text, blocks } = formatConflictBlocks(conflicts.conflicts, conflicts.period);
const slackResult = await postToSlack(text, blocks);
res.json({ message: `Alerted ${conflicts.conflictCount} conflicts`, alerted: !!slackResult, conflicts: conflicts.conflicts });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ============================================================
// NATURAL LANGUAGE COMMAND PROCESSOR
// ============================================================

app.post(’/command’, async (req, res) => {
try {
const { command } = req.body;
if (!command) return res.status(400).json({ error: ‘command field required’ });

```
const lower = command.toLowerCase();

const whosWorkingMatch = lower.match(/who(?:'s| is) working (\w+)/);
if (whosWorkingMatch) {
  const date = whosWorkingMatch[1];
  const { start, end, dateFormatted } = getDayRange(date);

  const { shifts: allShifts } = await getOrgCalendar(start, end);
  const working = allShifts
    .filter((s) => s.employeeId)
    .map((s) => `${s.employee}${s.position ? ` (${s.position})` : ''} ${formatTimePT(s.start)}-${formatTimePT(s.end)}`);

  return res.json({ date: dateFormatted, working });
}

const valMatch = lower.match(/validate\s+(\w+)\s+(?:for|on)\s+(.+)/);
if (valMatch) {
  const [, emp, date] = valMatch;
  const valRes = await fetch(`http://127.0.0.1:${PORT}/schedule/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ employee: emp, date: date.trim() }),
  });
  return res.json(await valRes.json());
}

const hoursMatch = lower.match(/hours\s+(?:for\s+)?(\w+)/);
if (hoursMatch) {
  const uid = resolveEmployeeId(hoursMatch[1]);
  if (uid) {
    const hoursRes = await fetch(`http://127.0.0.1:${PORT}/weekly-hours/${uid}`);
    return res.json(await hoursRes.json());
  }
}

if (lower.includes('conflict')) {
  const confRes = await fetch(`http://127.0.0.1:${PORT}/conflicts`);
  return res.json(await confRes.json());
}

const covMatch = lower.match(/coverage\s+(?:for\s+)?(\w+)/);
if (covMatch) {
  const covRes = await fetch(`http://127.0.0.1:${PORT}/schedule/coverage/${covMatch[1]}`);
  return res.json(await covRes.json());
}

const swapMatch = lower.match(/(?:swap|replace|switch)\s+(\w+)\s+(?:with|for|->)\s+(\w+)\s+(?:on\s+)?(\w+)/);
if (swapMatch) {
  const [, currentEmp, newEmp, date] = swapMatch;
  const swapRes = await fetch(`http://127.0.0.1:${PORT}/shifts/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ currentEmployee: currentEmp, newEmployee: newEmp, date }),
  });
  return res.json(await swapRes.json());
}

const assignMatch = lower.match(/(?:schedule|assign|add|put)\s+(\w+)\s+(?:for|as|to)\s+(\w+)\s+(?:on\s+)?(\w+)/);
if (assignMatch) {
  const [, emp, position, date] = assignMatch;
  const assignRes = await fetch(`http://127.0.0.1:${PORT}/shifts/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ employee: emp, position, date }),
  });
  return res.json(await assignRes.json());
}

const consecMatch = lower.match(/(?:consecutive|streak)\s+(?:for\s+)?(\w+)/);
if (consecMatch) {
  const uid = resolveEmployeeId(consecMatch[1]);
  if (uid) {
    const consecRes = await fetch(`http://127.0.0.1:${PORT}/schedule/consecutive/${uid}`);
    return res.json(await consecRes.json());
  }
}

return res.json({
  error: 'Could not parse command',
  hint: `Try: "who's working today", "validate Sara for Monday", "hours for Jessica", "conflicts", "coverage tomorrow", "consecutive Sara"`,
  rawCommand: command,
});
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ============================================================
// SLACK INTEGRATION
// ============================================================

const SLACK_CHANNEL = ‘C0AELGYN2LC’;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

let _lastPostedDate = null;

// ─── BLOCK KIT HELPERS ──────────────────────────────────────

function fmtTimePT(isoStr) {
return new Date(isoStr).toLocaleTimeString(‘en-US’, {
hour: ‘numeric’, minute: ‘2-digit’, timeZone: ‘America/Los_Angeles’,
});
}

function fmtDatePT(isoStr, opts = {}) {
return new Date(isoStr).toLocaleDateString(‘en-US’, {
timeZone: ‘America/Los_Angeles’, weekday: ‘long’, month: ‘short’, day: ‘numeric’, …opts,
});
}

function nowPT() {
return new Date().toLocaleString(‘en-US’, {
timeZone: ‘America/Los_Angeles’, hour: ‘numeric’, minute: ‘2-digit’, hour12: true,
});
}

// ─── 1. DAILY SCHEDULE BLOCKS ───────────────────────────────

function formatScheduleBlocks(dateStr, shifts) {
const clementShifts = shifts.filter((s) => (s.location || ‘’).includes(‘Clement’));
const ninthShifts = shifts.filter((s) => (s.location || ‘’).includes(‘9th’));
const totalShifts = clementShifts.length + ninthShifts.length;

const fallback = `📋 Schedule for ${dateStr} — ${totalShifts} shifts`;

const blocks = [
{ type: ‘header’, text: { type: ‘plain_text’, text: `📋 Schedule for ${dateStr}`, emoji: true } },
];

// Clement location
if (clementShifts.length > 0) {
blocks.push({ type: ‘divider’ });
blocks.push({
type: ‘section’,
text: { type: ‘mrkdwn’, text: `*☕ Clement Pixlcat* — ${clementShifts.length} shift${clementShifts.length !== 1 ? 's' : ''}` },
});

```
clementShifts.sort((a, b) => a.start.localeCompare(b.start));
const fields = [];
for (const s of clementShifts) {
  fields.push(
    { type: 'mrkdwn', text: `*${s.employee}*\n${s.position || 'TBD'}` },
    { type: 'mrkdwn', text: `${fmtTimePT(s.start)} – ${fmtTimePT(s.end)}` }
  );
}
// Slack limits 10 fields per section block
for (let i = 0; i < fields.length; i += 10) {
  blocks.push({ type: 'section', fields: fields.slice(i, i + 10) });
}
```

}

// 9th St location
if (ninthShifts.length > 0) {
blocks.push({ type: ‘divider’ });
blocks.push({
type: ‘section’,
text: { type: ‘mrkdwn’, text: `*🏠 9th St Pixlcat* — ${ninthShifts.length} shift${ninthShifts.length !== 1 ? 's' : ''}` },
});

```
ninthShifts.sort((a, b) => a.start.localeCompare(b.start));
const fields = [];
for (const s of ninthShifts) {
  fields.push(
    { type: 'mrkdwn', text: `*${s.employee}*\n${s.position || 'TBD'}` },
    { type: 'mrkdwn', text: `${fmtTimePT(s.start)} – ${fmtTimePT(s.end)}` }
  );
}
for (let i = 0; i < fields.length; i += 10) {
  blocks.push({ type: 'section', fields: fields.slice(i, i + 10) });
}
```

}

if (totalShifts === 0) {
blocks.push({ type: ‘section’, text: { type: ‘mrkdwn’, text: ‘*No shifts scheduled.*’ } });
}

blocks.push({ type: ‘divider’ });
blocks.push({
type: ‘context’,
elements: [{ type: ‘mrkdwn’, text: `${totalShifts} total shifts · Posted ${nowPT()}` }],
});

return { text: fallback, blocks };
}

// ─── 2. WEEK SCHEDULE BLOCKS ────────────────────────────────

function formatWeekBlocks(weekLabel, daySchedules) {
const totalShifts = daySchedules.reduce((sum, d) => sum + d.shifts.length, 0);
const fallback = `📅 ${weekLabel} — ${totalShifts} shifts across ${daySchedules.length} days`;

const blocks = [
{ type: ‘header’, text: { type: ‘plain_text’, text: `📅 ${weekLabel}`, emoji: true } },
{ type: ‘section’, text: { type: ‘mrkdwn’, text: `*${totalShifts} shifts* across ${daySchedules.length} days` } },
];

for (const day of daySchedules) {
const { dateFormatted, shifts, isWeekend } = day;
const clementShifts = shifts.filter((s) => (s.location || ‘’).includes(‘Clement’));
const ninthShifts = shifts.filter((s) => (s.location || ‘’).includes(‘9th’));
const dayIcon = isWeekend ? ‘🔥’ : ‘📌’;

```
blocks.push({ type: 'divider' });
blocks.push({
  type: 'section',
  text: { type: 'mrkdwn', text: `${dayIcon} *${dateFormatted}* — ${shifts.length} shift${shifts.length !== 1 ? 's' : ''}` },
});

if (clementShifts.length > 0) {
  clementShifts.sort((a, b) => a.start.localeCompare(b.start));
  const lines = clementShifts.map((s) => `${s.employee} _(${s.position || 'TBD'})_ · ${fmtTimePT(s.start)}–${fmtTimePT(s.end)}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*☕ Clement*\n${lines.join('\n')}` } });
}

if (ninthShifts.length > 0) {
  ninthShifts.sort((a, b) => a.start.localeCompare(b.start));
  const lines = ninthShifts.map((s) => `${s.employee} _(${s.position || 'TBD'})_ · ${fmtTimePT(s.start)}–${fmtTimePT(s.end)}`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🏠 9th St*\n${lines.join('\n')}` } });
}

if (shifts.length === 0) {
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_No shifts scheduled_' }] });
}
```

}

blocks.push({ type: ‘divider’ });
blocks.push({ type: ‘context’, elements: [{ type: ‘mrkdwn’, text: `Posted ${nowPT()}` }] });

return { text: fallback, blocks };
}

// ─── 3. CONFLICT BLOCKS ─────────────────────────────────────

function formatConflictBlocks(conflicts, period) {
if (!conflicts || conflicts.length === 0) {
return {
text: ‘✅ No scheduling conflicts found.’,
blocks: [{ type: ‘section’, text: { type: ‘mrkdwn’, text: ‘✅ *No scheduling conflicts found.*’ } }],
};
}

const fallback = `⚠️ ${conflicts.length} scheduling conflict${conflicts.length !== 1 ? 's' : ''} found`;

const blocks = [
{ type: ‘header’, text: { type: ‘plain_text’, text: `⚠️ ${conflicts.length} Scheduling Conflict${conflicts.length !== 1 ? 's' : ''}`, emoji: true } },
];

if (period) {
blocks.push({ type: ‘section’, text: { type: ‘mrkdwn’, text: `*Period:* ${period}` } });
}

// Group by date if available
const byDate = {};
for (const c of conflicts) {
const dateKey = c.date || ‘General’;
if (!byDate[dateKey]) byDate[dateKey] = [];
byDate[dateKey].push(c);
}

for (const [date, items] of Object.entries(byDate)) {
blocks.push({ type: ‘divider’ });
if (date !== ‘General’) {
blocks.push({ type: ‘section’, text: { type: ‘mrkdwn’, text: `*${date}*` } });
}

```
for (const c of items) {
  const icon = c.type === 'LEAVE_CONFLICT' || c.type === 'leave_conflict' ? '🛑'
    : c.type === 'AVAILABILITY_CONFLICT' || c.type === 'availability_conflict' ? '⚠️'
    : c.type === 'CROSS_LOCATION' || c.type === 'cross_location' ? '🔄'
    : c.type === 'OVERTIME_RISK' || c.type === 'overtime_risk' ? '⏰'
    : c.type === 'CONSECUTIVE_DAYS' || c.type === 'consecutive_days' ? '📆'
    : '❓';

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `${icon} *${c.type}* — ${c.message}` },
  });
}
```

}

blocks.push({ type: ‘divider’ });
blocks.push({
type: ‘context’,
elements: [{ type: ‘mrkdwn’, text: `Checked ${nowPT()} · Fix conflicts before shifts begin` }],
});

return { text: fallback, blocks };
}

// ─── 4. HOURS BLOCKS ────────────────────────────────────────

function formatHoursBlocks(data) {
const name = data.employee || data.name || ‘Employee’;
const total = (data.totalHours || 0).toFixed(1);
const remaining = data.remainingBeforeOT != null ? parseFloat(data.remainingBeforeOT).toFixed(1) : (40 - parseFloat(total)).toFixed(1);
const clement = (data.clementHours || 0).toFixed(1);
const ninth = (data.ninthStHours || data.ninthHours || 0).toFixed(1);

const fallback = `⏱️ ${name}: ${total}h this week (${remaining}h remaining)`;

const blocks = [
{ type: ‘header’, text: { type: ‘plain_text’, text: `⏱️ Hours: ${name}`, emoji: true } },
{
type: ‘section’,
fields: [
{ type: ‘mrkdwn’, text: `*Total Hours*\n${total}h` },
{ type: ‘mrkdwn’, text: `*Remaining*\n${remaining}h` },
{ type: ‘mrkdwn’, text: `*☕ Clement*\n${clement}h` },
{ type: ‘mrkdwn’, text: `*🏠 9th St*\n${ninth}h` },
],
},
];

// Overtime warning
if (parseFloat(total) > 35) {
blocks.push({
type: ‘context’,
elements: [{ type: ‘mrkdwn’, text: `⚠️ *Approaching 40h limit* — ${remaining}h remaining before overtime` }],
});
}

blocks.push({ type: ‘divider’ });
blocks.push({ type: ‘context’, elements: [{ type: ‘mrkdwn’, text: `Updated ${nowPT()}` }] });

return { text: fallback, blocks };
}

// ─── 5. WHO’S WORKING BLOCKS ────────────────────────────────

function formatWhosWorkingBlocks(dateFormatted, shifts) {
const clementShifts = shifts.filter((s) => (s.location || ‘’).includes(‘Clement’));
const ninthShifts = shifts.filter((s) => (s.location || ‘’).includes(‘9th’));
const working = shifts.filter((s) => s.employeeId);

const fallback = `Working ${dateFormatted}: ${working.length} employees`;

const blocks = [
{ type: ‘header’, text: { type: ‘plain_text’, text: `👥 Working ${dateFormatted}`, emoji: true } },
];

if (clementShifts.length > 0) {
blocks.push({ type: ‘divider’ });
const lines = clementShifts
.sort((a, b) => a.start.localeCompare(b.start))
.map((s) => `• *${s.employee}* — ${s.position || 'TBD'} (${fmtTimePT(s.start)}–${fmtTimePT(s.end)})`);
blocks.push({ type: ‘section’, text: { type: ‘mrkdwn’, text: `*☕ Clement*\n${lines.join('\n')}` } });
}

if (ninthShifts.length > 0) {
blocks.push({ type: ‘divider’ });
const lines = ninthShifts
.sort((a, b) => a.start.localeCompare(b.start))
.map((s) => `• *${s.employee}* — ${s.position || 'TBD'} (${fmtTimePT(s.start)}–${fmtTimePT(s.end)})`);
blocks.push({ type: ‘section’, text: { type: ‘mrkdwn’, text: `*🏠 9th St*\n${lines.join('\n')}` } });
}

if (working.length === 0) {
blocks.push({ type: ‘section’, text: { type: ‘mrkdwn’, text: ‘*No one scheduled.*’ } });
}

blocks.push({ type: ‘divider’ });
blocks.push({ type: ‘context’, elements: [{ type: ‘mrkdwn’, text: `${working.length} employees · ${nowPT()}` }] });

return { text: fallback, blocks };
}

// ─── BACKWARD COMPAT ────────────────────────────────────────

function formatScheduleForSlack(dateStr, shifts) {
const { text } = formatScheduleBlocks(dateStr, shifts);
return text;
}

// ─── postToSlack ────────────────────────────────────────────

async function postToSlack(text, blocks) {
const webhookUrl = process.env.SLACK_WEBHOOK_URL;
const botToken = SLACK_BOT_TOKEN;

if (webhookUrl) {
const body = { text };
// Webhooks support blocks too
if (blocks) body.blocks = blocks;
const res = await fetch(webhookUrl, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/json’ },
body: JSON.stringify(body),
});
return { ok: res.ok, status: res.status };
}

if (botToken) {
const body = { channel: SLACK_CHANNEL, text };
if (blocks) body.blocks = blocks;
const res = await fetch(‘https://slack.com/api/chat.postMessage’, {
method: ‘POST’,
headers: { Authorization: `Bearer ${botToken}`, ‘Content-Type’: ‘application/json’ },
body: JSON.stringify(body),
});
return res.json();
}

console.log(‘No Slack credentials configured, skipping post’);
return null;
}

// ─── replyInSlack (threaded, with blocks) ───────────────────

async function replyInSlack(channel, threadTs, text, blocks) {
// If bot token available, use chat.postMessage (supports blocks, channel posting)
if (SLACK_BOT_TOKEN) {
const body = { channel, text };
if (blocks) body.blocks = blocks;
// Post to channel (not threaded) to match v2.0 behavior
// To thread replies instead, add: body.thread_ts = threadTs;
try {
const res = await fetch(‘https://slack.com/api/chat.postMessage’, {
method: ‘POST’,
headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, ‘Content-Type’: ‘application/json’ },
body: JSON.stringify(body),
});
const result = await res.json();
if (!result.ok) console.error(‘replyInSlack error:’, result.error);
return result;
} catch (err) {
console.error(‘replyInSlack fetch error:’, err.message);
return null;
}
}

// Fallback: use postToSlack (works with webhook or bot token)
console.log(‘replyInSlack: no SLACK_BOT_TOKEN, falling back to postToSlack’);
return postToSlack(text, blocks);
}

// ─── DAILY SCHEDULER ────────────────────────────────────────

function startDailyScheduler() {
if (!SLACK_BOT_TOKEN && !process.env.SLACK_WEBHOOK_URL) {
console.log(‘No Slack credentials set, daily scheduler disabled’);
return;
}

const POST_HOUR = 17;

setInterval(async () => {
const now = new Date(new Date().toLocaleString(‘en-US’, { timeZone: ‘America/Los_Angeles’ }));
const today = now.toDateString();

```
if (now.getHours() === POST_HOUR && _lastPostedDate !== today) {
  _lastPostedDate = today;
  console.log("Daily scheduler: posting tomorrow's schedule...");

  try {
    const { start, end, dateFormatted } = getDayRange('tomorrow');
    const { shifts } = await getOrgCalendar(start, end);

    const { text, blocks } = formatScheduleBlocks(dateFormatted, shifts);
    const result = await postToSlack(text, blocks);
    console.log('Daily scheduler: posted successfully', result?.ok);

    try {
      await fetch(`http://127.0.0.1:${PORT}/cron/check-conflicts`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      console.log('Daily scheduler: conflict check complete');
    } catch (e) {
      console.error('Conflict check error:', e.message);
    }
  } catch (err) {
    console.error('Daily scheduler error:', err.message);
  }
}
```

}, 60 * 1000);

console.log(`Daily scheduler: will post tomorrow's schedule at ${POST_HOUR}:00 PT`);
}

// ─── SLACK ROUTES ───────────────────────────────────────────

app.get(’/slack/daily’, async (req, res) => {
try {
const { start, end, dateFormatted } = getDayRange(‘today’);
const { shifts } = await getOrgCalendar(start, end);
const { text, blocks } = formatScheduleBlocks(dateFormatted, shifts);
const result = await postToSlack(text, blocks);
res.json({ success: true, message: ‘Posted daily schedule to Slack’, slackResult: result });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/slack/tomorrow’, async (req, res) => {
try {
const { start, end, dateFormatted } = getDayRange(‘tomorrow’);
const { shifts } = await getOrgCalendar(start, end);
const { text, blocks } = formatScheduleBlocks(dateFormatted, shifts);
const result = await postToSlack(text, blocks);
res.json({ success: true, message: ‘Posted tomorrow schedule to Slack’, slackResult: result });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/cron/daily’, async (req, res) => {
const cronSecret = process.env.CRON_SECRET;
if (cronSecret && req.query.key !== cronSecret) return res.status(403).json({ error: ‘Invalid cron key’ });

try {
const { start, end, dateFormatted } = getDayRange(‘tomorrow’);
const { shifts } = await getOrgCalendar(start, end);

```
const { text, blocks } = formatScheduleBlocks(dateFormatted, shifts);
await postToSlack(text, blocks);

try {
  await fetch(`http://127.0.0.1:${PORT}/cron/check-conflicts`, { method: 'POST', headers: { 'x-api-key': API_KEY } });
} catch (e) {
  console.error('Conflict check in cron/daily:', e.message);
}

console.log(`Cron: posted tomorrow's schedule (${dateFormatted}, ${shifts.length} shifts)`);
res.json({ success: true, date: dateFormatted, shiftsPosted: shifts.length });
```

} catch (err) {
console.error(‘Cron error:’, err.message);
res.status(500).json({ error: err.message });
}
});

app.get(’/slack/week’, async (req, res) => {
try {
const now = new Date();
const startOfWeek = new Date(now);
startOfWeek.setDate(now.getDate() - now.getDay());
startOfWeek.setHours(0, 0, 0, 0);

```
const endOfWeek = new Date(startOfWeek);
endOfWeek.setDate(startOfWeek.getDate() + 6);
endOfWeek.setHours(23, 59, 59, 999);

const { shifts } = await getOrgCalendar(startOfWeek.toISOString(), endOfWeek.toISOString());

// Build day schedules for Block Kit
const dayMap = {};
for (let i = 0; i < 7; i++) {
  const d = new Date(startOfWeek);
  d.setDate(startOfWeek.getDate() + i);
  const key = d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  dayMap[key] = {
    dateFormatted: d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' }),
    shifts: [],
    isWeekend: [0, 6].includes(d.getDay()),
  };
}

for (const s of shifts) {
  const key = new Date(s.start).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  if (dayMap[key]) dayMap[key].shifts.push(s);
}

const daySchedules = Object.values(dayMap);
const weekLabel = `Week of ${daySchedules[0].dateFormatted} – ${daySchedules[6].dateFormatted}`;
const { text, blocks } = formatWeekBlocks(weekLabel, daySchedules);
const result = await postToSlack(text, blocks);

res.json({ success: true, message: 'Posted week schedule to Slack', slackResult: result });
```

} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ============================================================
// SLACK EVENTS API — Interactive bot (Block Kit responses)
// ============================================================

app.post(’/slack/events’, async (req, res) => {
// Verify Slack signature on ALL requests (including url_verification)
if (!verifySlackSignature(req)) return res.status(401).send(‘invalid signature’);

if (req.body.type === ‘url_verification’) return res.json({ challenge: req.body.challenge });

res.status(200).send(‘ok’);

const event = req.body.event;
if (!event || event.type !== ‘message’ || event.bot_id || event.subtype) return;
if (event.channel !== SLACK_CHANNEL) return;

const text = (event.text || ‘’).toLowerCase().trim();
const channel = event.channel;
const threadTs = event.ts;

try {
// Schedule today
if (text.includes(‘schedule today’) || text === ‘today’) {
const { start, end, dateFormatted } = getDayRange(‘today’);
const { shifts } = await getOrgCalendar(start, end);
const { text: fallback, blocks } = formatScheduleBlocks(dateFormatted, shifts);
await replyInSlack(channel, threadTs, fallback, blocks);

```
// Schedule tomorrow
} else if (text.includes('schedule tomorrow') || text === 'tomorrow') {
  const { start, end, dateFormatted } = getDayRange('tomorrow');
  const { shifts } = await getOrgCalendar(start, end);
  const { text: fallback, blocks } = formatScheduleBlocks(dateFormatted, shifts);
  await replyInSlack(channel, threadTs, fallback, blocks);

// Who's working
} else if (text.match(/who(?:'s| is) working/)) {
  const dateMatch = text.match(/working\s+(\w+)/);
  const date = dateMatch ? dateMatch[1] : 'today';
  const { start, end, dateFormatted } = getDayRange(date);
  const { shifts } = await getOrgCalendar(start, end);
  const working = shifts.filter((s) => s.employeeId);
  const { text: fallback, blocks } = formatWhosWorkingBlocks(dateFormatted, working);
  await replyInSlack(channel, threadTs, fallback, blocks);

// Conflicts
} else if (text.includes('conflict')) {
  const confRes = await fetch(`http://127.0.0.1:${PORT}/conflicts?days=7`);
  const conflicts = await confRes.json();

  if (conflicts.conflictCount === 0) {
    await replyInSlack(channel, threadTs, '✅ No schedule conflicts found for the next 7 days.');
  } else {
    const { text: fallback, blocks } = formatConflictBlocks(conflicts.conflicts, conflicts.period);
    await replyInSlack(channel, threadTs, fallback, blocks);
  }

// Hours for employee
} else if (text.match(/hours\s+(?:for\s+)?(\w+)/)) {
  const match = text.match(/hours\s+(?:for\s+)?(\w+)/);
  const uid = resolveEmployeeId(match[1]);
  if (uid) {
    const hoursRes = await fetch(`http://127.0.0.1:${PORT}/weekly-hours/${uid}`);
    const data = await hoursRes.json();
    const { text: fallback, blocks } = formatHoursBlocks(data);
    await replyInSlack(channel, threadTs, fallback, blocks);
  }
}
```

} catch (err) {
console.error(‘Slack event handler error:’, err.message);
}
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(’/health’, (req, res) => {
res.json({ status: ‘ok’, version: ‘2.1.0’, timestamp: new Date().toISOString() });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
console.log(`Pixlcat Sling API v2.1.0 running on port ${PORT}`);
startDailyScheduler();
});