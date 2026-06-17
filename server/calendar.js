const { google } = require('googleapis');
const { DateTime } = require('luxon');

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Returns available ISO start times for a given business + date.
 * Slots are generated from openHours, then any existing calendar
 * events are subtracted using the Calendar freebusy API.
 */
async function getAvailableSlots(business, dateStr) {
  const { calendarId, timezone, openHours, appointmentDurationMinutes } = business;

  if (!calendarId || calendarId.startsWith('REPLACE')) {
    // No calendar configured — return mock slots so the AI can still demo
    return generateMockSlots(business, dateStr);
  }

  const dayStart = DateTime.fromISO(`${dateStr}T${openHours.start}`, { zone: timezone });
  const dayEnd = DateTime.fromISO(`${dateStr}T${openHours.end}`, { zone: timezone });

  if (!dayStart.isValid) throw new Error(`Invalid date: ${dateStr}`);

  // Convert Luxon weekday (1=Mon..7=Sun) to JS weekday (0=Sun..6=Sat)
  const jsWeekday = dayStart.weekday % 7;
  if (!(openHours.daysOpen || [0,1,2,3,4,5,6]).includes(jsWeekday)) {
    return [];
  }

  const calendar = getCalendarClient();
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: dayStart.toUTC().toISO(),
      timeMax: dayEnd.toUTC().toISO(),
      timeZone: timezone,
      items: [{ id: calendarId }],
    },
  });

  const busy = fb.data.calendars?.[calendarId]?.busy || [];
  const now = DateTime.now();
  const slots = [];
  let cursor = dayStart;

  while (cursor.plus({ minutes: appointmentDurationMinutes }) <= dayEnd) {
    const slotEnd = cursor.plus({ minutes: appointmentDurationMinutes });
    const overlaps = busy.some((b) => {
      const bs = DateTime.fromISO(b.start);
      const be = DateTime.fromISO(b.end);
      return cursor < be && slotEnd > bs;
    });
    if (!overlaps && cursor > now) slots.push(cursor.toISO());
    cursor = slotEnd;
  }

  return slots;
}

function generateMockSlots(business, dateStr) {
  const { timezone, openHours, appointmentDurationMinutes } = business;
  const dayStart = DateTime.fromISO(`${dateStr}T${openHours.start}`, { zone: timezone });
  const dayEnd = DateTime.fromISO(`${dateStr}T${openHours.end}`, { zone: timezone });
  const now = DateTime.now();
  const slots = [];
  let cursor = dayStart;
  while (cursor.plus({ minutes: appointmentDurationMinutes }) <= dayEnd) {
    if (cursor > now) slots.push(cursor.toISO());
    cursor = cursor.plus({ minutes: appointmentDurationMinutes });
  }
  // Simulate 2 random slots taken
  return slots.filter((_, i) => i % 3 !== 1).slice(0, 6);
}

async function createCalendarEvent(business, { summary, description, startISO }) {
  const { calendarId, timezone, appointmentDurationMinutes } = business;

  if (!calendarId || calendarId.startsWith('REPLACE')) {
    // No real calendar — return a fake event so the AI can confirm the booking
    const start = DateTime.fromISO(startISO, { zone: timezone });
    return {
      id: 'mock_' + Date.now(),
      start: { dateTime: start.toISO() },
      end: { dateTime: start.plus({ minutes: appointmentDurationMinutes }).toISO() },
      summary,
    };
  }

  const calendar = getCalendarClient();
  const start = DateTime.fromISO(startISO, { zone: timezone });
  const end = start.plus({ minutes: appointmentDurationMinutes });

  const event = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISO(), timeZone: timezone },
      end: { dateTime: end.toISO(), timeZone: timezone },
    },
  });

  return event.data;
}

async function deleteCalendarEvent(business, calendarEventId) {
  if (!calendarEventId || calendarEventId.startsWith('mock_')) return;
  const { calendarId } = business;
  if (!calendarId || calendarId.startsWith('REPLACE')) return;
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId, eventId: calendarEventId }).catch(() => {});
}

module.exports = { getAvailableSlots, createCalendarEvent, deleteCalendarEvent };
