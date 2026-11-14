# Request: SMS appointment reminders

From the practice managers.

Patients miss fewer appointments when they get a text message. Today the reminder pass sends an email only.

1. The reminder pass also sends an SMS reminder, 24 hours before the appointment, to every patient with a valid mobile number. A patient with no mobile number, or with a number that is not a valid mobile number, gets the email only. Never send an SMS to an invalid number: the gateway charges for every attempt.
2. Each appointment gets at most one reminder pass, as today, so the patient never gets a second email or SMS for the same appointment.
3. The appointment time in both the email and the SMS is the clinic's local time. Today the email shows UTC, and patients at the clinics outside the UTC zone come at the wrong hour.

The text of the SMS: `Reminder: your appointment at <clinic name> is on <date and time>. Reply C to cancel.` Handling the C reply is a separate request.
