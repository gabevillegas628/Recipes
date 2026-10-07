# Backlog

Ideas that are agreed in principle but not built yet, with what's still to decide.
Newest thinking first within each section.

## Reminders and tasks

- **Projects, not just tasks.** Some deadline tasks are really several steps:
  "hire a contractor for a renovation starting March 15" means getting quotes,
  comparing, then signing. Today it gets one reminder at the right time to start.
  Later: follow-up milestones, like "decide by mid-January", booked back from the
  same deadline.
- **A home for "someday" items.** Reminders with no date ("fix the fence gate")
  have nowhere visible. Hidden means never done; always on Today means ignored.
  UX to think through; one idea is one or two rotating items on Today.
- **"Mark done" link in the calendar event.** Google's API can't tell us an alert
  was dismissed, so a link in the reminder's event description that ticks it off
  in Mise would save opening the app.
- **Find a time from a task.** "Call the dentist to schedule a cleaning" could
  offer Find a time for the appointment it leads to.
- **Per-person reminder calendars.** Reminders all go to one reminders calendar
  (Gabe's). If Danielle starts adding her own, each person needs theirs.

## Today page

Planned in phases; each ships on its own and later ones build on earlier ones.

1. **Day cards.** Today and each upcoming day as a card, like the Notes groups;
   today's a little more prominent. Missed stays above. Styling only.
2. **Whose event is it.** `/api/today` adds owners to each event from the same
   `EventTag`s Find a time uses (`tagTitles`; Claude only reads new titles) and
   whether Google marks it "free". "Me" is the user via `personFor`. Yours and
   whole-family events look normal; other people's are muted with a name tag.
   Tapping a calendar event lets you fix whose it is (saved by hand, as on Find a time).
3. **Free time.** New household setting "My day" (default 7am–9pm, separate from
   appointment hours). Busy = your events, whole-family, unsure, and your
   reminders with an end time; "free" events don't count. Gaps of 30+ minutes show
   between events ("Free · 1:30–3:00"), tap to open Add at that time. Today only,
   from now on. Put the busy/free logic in one shared function for phase 4.
4. **Clashes.**
   - *Warn on save:* a reminder overlapping your busy time gets "Overlaps Dentist
     2–3" with Save anyway / Move to the nearest free slot. A plain reminder (no
     end) inside an event counts as a clash.
   - *Sort out my day:* overlaps get a ⚠ on Today and a button opens a list with a
     lock per item: appointments and calendar events locked, your reminders not
     (only Mise reminders can move; an appointment moves by phone call). Each
     unlocked item, in order, goes to the nearest free slot of the same length that
     day (reuse `findTimes` for one person, no travel), else suggest tomorrow or
     leave it flagged. Shows before → after, applied only on Apply; Google
     follows through the existing sync.

## Calendar

- **Mise appointments vs. Google Calendar.** Today already shows the whole family
  calendar, and sync is one-way, so an event changed in Google leaves Mise's copy
  out of date. To decide: how often events get edited in Google; what Mise keeps
  that Google can't (photos, longer notes, who it's for); and whether to pick up
  changes from Google (middle ground) or drop Mise's copies altogether.

## Notes

- **More than one photo per note.** `Note.image` becomes `images String[]` (as
  `aliases` and `people` already are), with a migration copying existing photos
  over. Capture already accepts up to 4 photos but only keeps the first; it would
  keep them all. The rest: update/delete clean up removed files, the form gets a
  row of thumbnails with remove buttons, the note page shows them all, the list
  thumbnail gets a "+2" badge, and MCP's `hasPhoto` becomes a count. About half a
  day. A separate table is only worth it for captions or per-photo details.

## App

- **Backups.** There are none yet.
- **Share photos from the share sheet.** iOS needs a Shortcut that uploads the image.
