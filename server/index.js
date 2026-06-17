require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { DateTime } = require('luxon');

const db = require('./db');
const { buildSystemPrompt } = require('./prompt');
const { getAvailableSlots, createCalendarEvent, deleteCalendarEvent } = require('./calendar');
const { sendSmsReminder } = require('./sms');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// ── Simple auth middleware for admin API ───────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ═══════════════════════════════════════════════════════════════════════════
//  VAPI WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /webhook/vapi
 * Vapi sends all events here: assistant-request, tool-calls, end-of-call.
 * Set this URL in:
 *   - Vapi dashboard → Phone Numbers → your number → Server URL
 *   - Vapi dashboard → Account → Settings → Server URL (as fallback)
 */
app.post('/webhook/vapi', async (req, res) => {
  const msg = req.body?.message || req.body;
  const type = msg?.type;

  try {
    if (type === 'assistant-request') {
      return handleAssistantRequest(req, res, msg);
    }
    if (type === 'tool-calls') {
      return handleToolCalls(req, res, msg);
    }
    if (type === 'end-of-call-report') {
      console.log(`[Vapi] Call ended: ${msg?.call?.id}, cost: $${msg?.cost || 0}`);
      return res.json({ received: true });
    }
    // Unknown event — acknowledge so Vapi doesn't retry
    return res.json({ received: true });
  } catch (err) {
    console.error('[Vapi webhook error]', err);
    return res.status(200).json({ error: 'Internal error' });
  }
});

function handleAssistantRequest(req, res, msg) {
  // Vapi sends the phone number ID of the called number
  const phoneNumberId =
    msg?.phoneNumber?.id ||
    msg?.call?.phoneNumberId ||
    msg?.phoneNumberId;

  const business = db.getBusinessByVapiNumber(phoneNumberId);

  if (!business) {
    console.warn(`[Vapi] No business for phoneNumberId: ${phoneNumberId}`);
    // Return a generic fallback assistant so the call isn't silent
    return res.json({
      assistant: {
        name: 'AI Receptionist',
        firstMessage: 'Hello! This business is not yet configured. Please check back later.',
        model: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'system', content: 'You are a receptionist. The business is not configured. Politely ask the caller to try again later.' }],
        },
        voice: { provider: '11labs', voiceId: 'sarah' },
      },
    });
  }

  const toolUrl = `${PUBLIC_BASE_URL}/webhook/vapi/tools?bid=${business.id}`;

  return res.json({
    assistant: {
      name: `${business.name} Receptionist`,
      firstMessage: `Thank you for calling ${business.name}. This is ${business.agentName || 'your AI receptionist'}. How can I help you today?`,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: buildSystemPrompt(business) }],
        tools: buildTools(toolUrl),
      },
      voice: {
        provider: '11labs',
        voiceId: business.voiceId || 'sarah',
      },
    },
  });
}

async function handleToolCalls(req, res, msg) {
  const businessId = req.query.bid;
  const business = db.getBusinessById(businessId);
  const toolCalls = msg?.toolCallList || [];
  const results = [];

  for (const call of toolCalls) {
    let result;
    try {
      const args = typeof call.function?.arguments === 'string'
        ? JSON.parse(call.function.arguments)
        : call.function?.arguments || {};

      if (!business) {
        result = 'Business not found. Tell the caller a staff member will follow up.';
      } else {
        result = await dispatchTool(business, call.function?.name, args);
      }
    } catch (err) {
      console.error('[Tool call error]', call.function?.name, err.message);
      result = 'Something went wrong. Please tell the caller to try again or call back.';
    }
    results.push({ toolCallId: call.id, result });
  }

  return res.json({ results });
}

// Separate endpoint for tool calls (query param routing)
app.post('/webhook/vapi/tools', async (req, res) => {
  return handleToolCalls(req, res, req.body?.message || req.body);
});

async function dispatchTool(business, toolName, args) {
  if (toolName === 'check_availability') {
    return toolCheckAvailability(business, args);
  }
  if (toolName === 'book_appointment') {
    return toolBookAppointment(business, args);
  }
  if (toolName === 'cancel_appointment') {
    return toolCancelAppointment(business, args);
  }
  return `Unknown tool: ${toolName}`;
}

async function toolCheckAvailability(business, args) {
  const slots = await getAvailableSlots(business, args.date);
  if (slots.length === 0) {
    return `No slots available on ${args.date}. Suggest checking the next business day.`;
  }
  const readable = slots.slice(0, 4).map((iso) =>
    DateTime.fromISO(iso, { zone: business.timezone }).toFormat('h:mm a')
  ).join(', ');
  const isoList = slots.slice(0, 4).join(' | ');
  return `Available times on ${args.date}: ${readable}. ISO values for booking: ${isoList}`;
}

async function toolBookAppointment(business, args) {
  // Create calendar event
  const event = await createCalendarEvent(business, {
    summary: `${args.service} – ${args.customerName}`,
    description: `Booked by AI. Customer: ${args.customerName}, Phone: ${args.customerPhone}`,
    startISO: args.startTime,
  });

  // Save to DB
  const appt = db.addAppointment(business.id, {
    customerName: args.customerName,
    customerPhone: args.customerPhone,
    service: args.service,
    startTime: args.startTime,
    calendarEventId: event.id,
    notes: args.notes || '',
  });

  const readableTime = DateTime.fromISO(args.startTime, { zone: business.timezone })
    .toLocaleString(DateTime.DATETIME_MED);

  return `Appointment confirmed! ${args.customerName} is booked for ${args.service} on ${readableTime}. Appointment ID: ${appt.id}`;
}

async function toolCancelAppointment(business, args) {
  const allAppts = db.getAppointments(business.id, { status: 'confirmed' });
  const appt = allAppts.find(
    (a) =>
      a.customerPhone === args.customerPhone ||
      a.customerName?.toLowerCase() === args.customerName?.toLowerCase()
  );

  if (!appt) {
    return `No confirmed appointment found for ${args.customerName || args.customerPhone}. Ask the caller to double-check their details.`;
  }

  db.updateAppointment(business.id, appt.id, { status: 'cancelled' });
  await deleteCalendarEvent(business, appt.calendarEventId);

  const time = DateTime.fromISO(appt.startTime, { zone: business.timezone })
    .toLocaleString(DateTime.DATETIME_MED);

  return `Appointment for ${appt.customerName} on ${time} has been cancelled.`;
}

function buildTools(toolUrl) {
  return [
    {
      type: 'function',
      function: {
        name: 'check_availability',
        description: 'Check available appointment time slots for a given date.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          },
          required: ['date'],
        },
      },
      server: { url: toolUrl },
    },
    {
      type: 'function',
      function: {
        name: 'book_appointment',
        description: 'Book an appointment for the caller.',
        parameters: {
          type: 'object',
          properties: {
            customerName: { type: 'string', description: 'Full name of the caller' },
            customerPhone: { type: 'string', description: 'Phone number of the caller' },
            service: { type: 'string', description: 'Service being booked' },
            startTime: { type: 'string', description: 'ISO 8601 start time chosen by caller' },
            notes: { type: 'string', description: 'Any additional notes' },
          },
          required: ['customerName', 'customerPhone', 'service', 'startTime'],
        },
      },
      server: { url: toolUrl },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_appointment',
        description: 'Cancel an existing appointment for the caller.',
        parameters: {
          type: 'object',
          properties: {
            customerName: { type: 'string', description: 'Full name of the caller' },
            customerPhone: { type: 'string', description: 'Phone number of the caller' },
          },
          required: ['customerPhone'],
        },
      },
      server: { url: toolUrl },
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
//  ADMIN API
// ═══════════════════════════════════════════════════════════════════════════

// Auth check
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ error: 'Wrong password' });
});

// Businesses
app.get('/api/businesses', requireAuth, (req, res) => {
  res.json(db.getAllBusinesses().map(sanitizeBusiness));
});

app.post('/api/businesses', requireAuth, (req, res) => {
  const b = db.createBusiness(req.body);
  res.json(sanitizeBusiness(b));
});

app.get('/api/businesses/:id', requireAuth, (req, res) => {
  const b = db.getBusinessById(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  res.json(sanitizeBusiness(b));
});

app.put('/api/businesses/:id', requireAuth, (req, res) => {
  try {
    const b = db.updateBusiness(req.params.id, req.body);
    res.json(sanitizeBusiness(b));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.delete('/api/businesses/:id', requireAuth, (req, res) => {
  db.deleteBusiness(req.params.id);
  res.json({ ok: true });
});

// Appointments
app.get('/api/businesses/:id/appointments', requireAuth, (req, res) => {
  const appts = db.getAppointments(req.params.id, {
    status: req.query.status,
    date: req.query.date,
  });
  res.json(appts);
});

app.patch('/api/businesses/:id/appointments/:apptId', requireAuth, async (req, res) => {
  try {
    const b = db.getBusinessById(req.params.id);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    if (req.body.status === 'cancelled') {
      const appts = db.getAppointments(req.params.id);
      const appt = appts.find((a) => a.id === req.params.apptId);
      if (appt?.calendarEventId) await deleteCalendarEvent(b, appt.calendarEventId);
    }
    const appt = db.updateAppointment(req.params.id, req.params.apptId, req.body);
    res.json(appt);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Subscription status (for 15-day trial gating)
app.get('/api/businesses/:id/subscription', requireAuth, (req, res) => {
  const b = db.getBusinessById(req.params.id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  const trialStart = new Date(b.trialStartedAt);
  const now = new Date();
  const daysUsed = Math.floor((now - trialStart) / (1000 * 60 * 60 * 24));
  const trialDaysLeft = Math.max(0, 15 - daysUsed);
  res.json({
    status: b.subscriptionStatus,
    trialDaysLeft,
    trialExpired: daysUsed >= 15 && b.subscriptionStatus === 'trial',
    plan: b.subscriptionStatus === 'active' ? '$199/month' : null,
  });
});

// Webhook URL helper (so dashboard can display what to paste into Vapi)
app.get('/api/webhook-url', requireAuth, (req, res) => {
  res.json({ url: `${PUBLIC_BASE_URL}/webhook/vapi` });
});

function sanitizeBusiness(b) {
  const { appointments, ...rest } = b;
  return { ...rest, appointmentCount: (appointments || []).length };
}

// ═══════════════════════════════════════════════════════════════════════════
//  SMS REMINDER CRON (runs every hour)
// ═══════════════════════════════════════════════════════════════════════════

cron.schedule('0 * * * *', async () => {
  console.log('[Cron] Checking for appointment reminders...');
  const pending = db.getUpcomingAppointmentsForReminder();
  for (const { business, appt } of pending) {
    try {
      await sendSmsReminder(business, appt);
      db.updateAppointment(business.id, appt.id, { reminderSent: true });
    } catch (err) {
      console.error(`[Cron] Failed to send reminder for appt ${appt.id}:`, err.message);
    }
  }
  if (pending.length) console.log(`[Cron] Sent ${pending.length} reminders`);
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n✅ AI Receptionist backend running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Vapi webhook URL: ${PUBLIC_BASE_URL}/webhook/vapi\n`);
});
