/**
 * Simple JSON file-based data store.
 * Each business has its own JSON file: data/business_{id}.json
 * Appointments are stored inside each business file.
 *
 * For production scale: swap readBusiness/writeBusiness to use
 * Firestore (you already use Firebase) — the function signatures
 * are the same, only the implementation changes.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const INDEX_FILE = path.join(DATA_DIR, 'index.json');

function readIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { businesses: [] };
  return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
}

function writeIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function readBusiness(id) {
  const file = path.join(DATA_DIR, `business_${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeBusiness(business) {
  const file = path.join(DATA_DIR, `business_${business.id}.json`);
  fs.writeFileSync(file, JSON.stringify(business, null, 2));
}

// ── Business CRUD ──────────────────────────────────────────────────────────

function getAllBusinesses() {
  const index = readIndex();
  return index.businesses.map((id) => readBusiness(id)).filter(Boolean);
}

function getBusinessById(id) {
  return readBusiness(id);
}

function getBusinessByVapiNumber(vapiPhoneNumberId) {
  const all = getAllBusinesses();
  return all.find((b) => b.vapiPhoneNumberId === vapiPhoneNumberId) || null;
}

function createBusiness(data) {
  const id = uuidv4().slice(0, 8);
  const business = {
    id,
    createdAt: new Date().toISOString(),
    trialStartedAt: new Date().toISOString(),
    subscriptionStatus: 'trial', // trial | active | expired
    ...data,
    appointments: [],
  };
  writeBusiness(business);
  const index = readIndex();
  index.businesses.push(id);
  writeIndex(index);
  return business;
}

function updateBusiness(id, updates) {
  const business = readBusiness(id);
  if (!business) throw new Error(`Business ${id} not found`);
  const updated = { ...business, ...updates };
  writeBusiness(updated);
  return updated;
}

function deleteBusiness(id) {
  const file = path.join(DATA_DIR, `business_${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const index = readIndex();
  index.businesses = index.businesses.filter((bid) => bid !== id);
  writeIndex(index);
}

// ── Appointment CRUD ───────────────────────────────────────────────────────

function addAppointment(businessId, appt) {
  const business = readBusiness(businessId);
  if (!business) throw new Error(`Business ${businessId} not found`);
  const appointment = {
    id: uuidv4().slice(0, 8),
    createdAt: new Date().toISOString(),
    reminderSent: false,
    status: 'confirmed', // confirmed | cancelled | completed
    ...appt,
  };
  business.appointments = business.appointments || [];
  business.appointments.push(appointment);
  writeBusiness(business);
  return appointment;
}

function updateAppointment(businessId, appointmentId, updates) {
  const business = readBusiness(businessId);
  if (!business) throw new Error(`Business ${businessId} not found`);
  const idx = business.appointments.findIndex((a) => a.id === appointmentId);
  if (idx === -1) throw new Error(`Appointment ${appointmentId} not found`);
  business.appointments[idx] = { ...business.appointments[idx], ...updates };
  writeBusiness(business);
  return business.appointments[idx];
}

function getAppointments(businessId, { status, date } = {}) {
  const business = readBusiness(businessId);
  if (!business) return [];
  let appts = business.appointments || [];
  if (status) appts = appts.filter((a) => a.status === status);
  if (date) appts = appts.filter((a) => a.startTime && a.startTime.startsWith(date));
  return appts.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

// Return all confirmed appointments across ALL businesses that need reminders
function getUpcomingAppointmentsForReminder() {
  const all = getAllBusinesses();
  const results = [];
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  for (const business of all) {
    for (const appt of (business.appointments || [])) {
      if (
        appt.status === 'confirmed' &&
        !appt.reminderSent &&
        appt.customerPhone &&
        appt.startTime
      ) {
        const start = new Date(appt.startTime);
        if (start > now && start <= in24h) {
          results.push({ business, appt });
        }
      }
    }
  }
  return results;
}

module.exports = {
  getAllBusinesses,
  getBusinessById,
  getBusinessByVapiNumber,
  createBusiness,
  updateBusiness,
  deleteBusiness,
  addAppointment,
  updateAppointment,
  getAppointments,
  getUpcomingAppointmentsForReminder,
};
