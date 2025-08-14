import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import fetch from "node-fetch";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
dayjs.extend(utc); dayjs.extend(tz);

const app = express();
app.use(bodyParser.json());

const {
  GOOGLE_SA_EMAIL,
  GOOGLE_SA_KEY,
  JESSE_CALENDAR_ID,          // e.g., jesse@refreshpaintingrva.com
  TZ = "America/New_York",
  GHL_API_KEY,
  GHL_LOCATION_ID,
  JESSE_SMS,                  // optional: your cell to notify on escalate
  VAPI_SECRET_TOKEN           // must match the X-Api-Key you set in Vapi tools
} = process.env;

// Simple auth
app.use((req, res, next) => {
  const key = req.header("X-Api-Key");
  if (!VAPI_SECRET_TOKEN || key !== VAPI_SECRET_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Google Calendar client (Service Account)
function calendarClient() {
  const jwt = new google.auth.JWT(
    GOOGLE_SA_EMAIL,
    null,
    (GOOGLE_SA_KEY || "").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar"]
  );
  return google.calendar({ version: "v3", auth: jwt });
}

// SMS via GHL
async function sendGhlSms(to, message) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return;
  await fetch("https://services.leadconnectorhq.com/conversations/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
      "Location-Id": GHL_LOCATION_ID
    },
    body: JSON.stringify({ to, type: "SMS", message })
  });
}

const SLOT_STARTS = ["17:30", "18:00", "18:30", "19:00"]; // 30-min each
async function findNextSlot(cal) {
  const maxDays = 21; // search 3 weeks
  for (let d = 0; d < maxDays; d++) {
    const day = dayjs().tz(TZ).add(d, "day");
    if (![1,2,3,4].includes(day.day())) continue; // Mon–Thu
    for (const hm of SLOT_STARTS) {
      const start = dayjs.tz(`${day.format("YYYY-MM-DD")} ${hm}`, TZ);
      const end = start.add(30, "minute");
      const bufStart = start.subtract(15, "minute").toISOString();
      const bufEnd   = end.add(15, "minute").toISOString();
      const fb = await cal.freebusy.query({
        requestBody: { timeMin: bufStart, timeMax: bufEnd, items: [{ id: JESSE_CALENDAR_ID }] }
      });
      const busy = fb.data.calendars[JESSE_CALENDAR_ID]?.busy || [];
      if (busy.length === 0) return { startISO: start.toISOString(), endISO: end.toISOString() };
    }
  }
  return null;
}

app.post("/vapi-tool", async (req, res) => {
  const { tool, arguments: args } = req.body || {};
  const cal = calendarClient();
  try {
    if (tool === "checkServiceArea") {
      const needsManual = !/^232|^231/.test(args.zip || "");
      return res.json({ in_area_guess: !needsManual, needs_manual_verification: needsManual });
    }
    if (tool === "bookVirtualEstimate") {
      const slot = await findNextSlot(cal);
      if (!slot) return res.json({ error: "No availability in next 3 weeks" });
      const summary = `Virtual Estimate - ${args.caller_name} (${args.job_type})`;
      const description = [
        `Phone: ${args.caller_phone}`,
        `Email: ${args.caller_email || ""}`,
        `Address: ${args.address_line1}, ${args.city}, ${args.state} ${args.zip}`,
        `Rooms/Areas: ${args.rooms_or_areas || ""}`,
        `Issues: ${args.issues || ""}`,
        `Notes: ${args.notes || ""}`
      ].join("\n");
      const event = await cal.events.insert({
        calendarId: JESSE_CALENDAR_ID,
        requestBody: {
          summary,
          description,
          start: { dateTime: slot.startISO, timeZone: TZ },
          end:   { dateTime: slot.endISO,   timeZone: TZ },
          conferenceData: { createRequest: { requestId: `rp-${Date.now()}` } }
        },
        conferenceDataVersion: 1
      });
      return res.json({
        ok: true,
        start: slot.startISO,
        end: slot.endISO,
        event_id: event.data.id,
        meet_link: event.data.hangoutLink || ""
      });
    }
    if (tool === "sendPhotoLink") {
      const link = args.form_url;
      await sendGhlSms(
        args.to_number,
        `Here’s the photo upload link for your virtual estimate: ${link}\nWe’ll text confirmations & reminders. Reply STOP to opt-out.`
      );
      return res.json({ ok: true });
    }
    if (tool === "escalateCall") {
      if (JESSE_SMS) {
        await sendGhlSms(
          JESSE_SMS,
          `Callback request: ${args.caller_name} ${args.caller_phone}\nWhen: ${args.callback_window}\nReason: ${args.reason || "n/a"}`
        );
      }
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "Unknown tool" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/", (_, res) => res.send("Refresh Painting glue server OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
