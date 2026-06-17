const { DateTime } = require('luxon');

let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid.startsWith('AC')) {
    // Not configured — log instead of crash
    return null;
  }
  twilioClient = require('twilio')(sid, token);
  return twilioClient;
}

async function sendSmsReminder(business, appt) {
  const client = getTwilioClient();
  const from = process.env.TWILIO_SMS_FROM;

  const time = DateTime.fromISO(appt.startTime, { zone: business.timezone }).toLocaleString(
    DateTime.DATETIME_MED
  );

  const message =
    `Hi ${appt.customerName}, this is a reminder from ${business.name}. ` +
    `Your ${appt.service} appointment is confirmed for ${time}. ` +
    `To cancel, please call us. Thank you!`;

  if (!client || !from || !appt.customerPhone) {
    console.log(`[SMS MOCK] To: ${appt.customerPhone}\n${message}`);
    return { mock: true };
  }

  const result = await client.messages.create({
    from,
    to: appt.customerPhone,
    body: message,
  });

  console.log(`[SMS] Sent reminder to ${appt.customerPhone}, SID: ${result.sid}`);
  return result;
}

module.exports = { sendSmsReminder };
