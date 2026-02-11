# Pixlcat Sling API

Express server wrapping the Sling scheduling API for Pixlcat Coffee operations. Deployed on Render, used by Claude and Slack for schedule management.

## Setup

1. Deploy to Render (Web Service, Node)
2. Set `SLING_TOKEN` env var (get from `/auth/login` endpoint or Sling web app)
3. Base URL: `https://sling-api-xxxx.onrender.com`

## Getting Your Token

```bash
curl -X POST https://your-render-url.onrender.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "your-sling-email", "password": "your-password"}'
```

The token from the response goes into the `SLING_TOKEN` env var on Render.

## Endpoints

### Read
- `GET /users` — All employees
- `GET /positions` — All positions (barista, etc.)
- `GET /locations` — All locations
- `GET /groups` — Employee groups
- `GET /shifts/today` — Today's schedule
- `GET /shifts/week` — This week's schedule
- `GET /schedule/:date` — Specific day (accepts "tuesday", "tomorrow", "2025-02-15")
- `GET /whos-working` — Who's working right now
- `GET /whos-working/:date` — Who's working on a given day
- `GET /timeoff` — Time-off requests
- `GET /calendar/summaries?start=ISO&end=ISO` — Hours/cost summaries

### Write
- `POST /shifts/create` — Create a shift
- `POST /shifts/swap` — Swap employees on a shift
- `POST /shifts/assign` — Assign employee to date/position
- `PUT /shifts/:id` — Direct shift update
- `POST /shifts/publish` — Publish schedule
- `POST /shifts/unpublish` — Unpublish shifts

### Natural Language
- `POST /command` — Parse natural language scheduling commands

## Example Commands

```bash
# Who's working tomorrow?
curl https://your-url.onrender.com/schedule/tomorrow

# Swap Jesus with Jessica on Tuesday
curl -X POST https://your-url.onrender.com/shifts/swap \
  -H "Content-Type: application/json" \
  -d '{"currentEmployee": "Jesus", "newEmployee": "Jessica", "date": "tuesday"}'

# Schedule Clayton for barista on Tuesday
curl -X POST https://your-url.onrender.com/shifts/assign \
  -H "Content-Type: application/json" \
  -d '{"employee": "Clayton", "position": "barista", "date": "tuesday", "startTime": "07:00", "endTime": "14:00"}'
```
