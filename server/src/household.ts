import { z } from 'zod';
import { prisma } from './db.js';

/**
 * The family, for finding times: who's in it (and how calendar titles name
 * them), the kids' school hours, travel time and usual appointment hours.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, 'Times look like 07:20');

export const householdBody = z
  .object({
    people: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().trim().min(1, 'Every person needs a name').max(60),
          aliases: z.array(z.string().trim().min(1).max(60)).max(10),
          adult: z.boolean(),
        }),
      )
      .max(20),
    schoolStart: hhmm.nullable(),
    schoolEnd: hhmm.nullable(),
    travelMinutes: z.number().int().min(0).max(240),
    hoursStart: hhmm,
    hoursEnd: hhmm,
  })
  .refine((h) => h.hoursStart < h.hoursEnd, 'Appointment hours must end after they start')
  .refine((h) => !h.schoolStart === !h.schoolEnd && (!h.schoolStart || h.schoolStart < h.schoolEnd!), 'School hours must end after they start');

export async function getHousehold() {
  const [settings, people] = await Promise.all([
    prisma.household.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} }),
    prisma.householdPerson.findMany({ orderBy: { position: 'asc' } }),
  ]);
  // The weather location has its own setting (see weather.ts).
  const { id: _id, updatedAt: _u, weatherPlace: _p, weatherLat: _la, weatherLon: _lo, ...rest } = settings;
  return { ...rest, people: people.map(({ id, name, aliases, adult }) => ({ id, name, aliases, adult })) };
}

export type Household = Awaited<ReturnType<typeof getHousehold>>;

/** Replaces the people list (keeping ids of those still there) and the settings. */
export async function saveHousehold(input: z.infer<typeof householdBody>) {
  const { people, ...settings } = input;
  const keep = people.flatMap((p) => (p.id ? [p.id] : []));
  const describe = (list: { name: string; aliases: string[]; adult: boolean }[]) =>
    JSON.stringify(list.map(({ name, aliases, adult }) => [name, [...aliases].sort(), adult]));
  const peopleChanged = describe((await getHousehold()).people) !== describe(people);
  await prisma.$transaction([
    prisma.householdPerson.deleteMany({ where: { id: { notIn: keep } } }),
    ...people.map((p, position) =>
      p.id
        ? prisma.householdPerson.update({ where: { id: p.id }, data: { name: p.name, aliases: p.aliases, adult: p.adult, position } })
        : prisma.householdPerson.create({ data: { name: p.name, aliases: p.aliases, adult: p.adult, position } }),
    ),
    prisma.household.upsert({ where: { id: 'default' }, create: { id: 'default', ...settings }, update: settings }),
    // Who's who changed, so titles the AI read may now mean someone else: read them afresh.
    ...(peopleChanged ? [prisma.eventTag.deleteMany({ where: { byHand: false } })] : []),
  ]);
  return getHousehold();
}
