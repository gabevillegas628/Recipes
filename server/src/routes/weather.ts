import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { findPlaces, getWeather, getWeatherPlace, setWeatherPlace, WeatherError } from '../weather.js';

/** Today's weather, and Settings → Weather for where it's for. */
export async function weatherRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /** Null when no place is set. */
  app.get('/api/weather', async (request, reply) => {
    const place = await getWeatherPlace();
    if (!place) return { weather: null };
    try {
      return { weather: await getWeather(place) };
    } catch (err) {
      if (err instanceof WeatherError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/weather/place', async () => ({ place: await getWeatherPlace() }));

  app.get('/api/weather/places', async (request, reply) => {
    const parsed = z.object({ q: z.string().trim().min(2).max(100) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Type a city or zip code' });
    try {
      return { places: await findPlaces(parsed.data.q) };
    } catch (err) {
      if (err instanceof WeatherError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.put('/api/weather/place', async (request, reply) => {
    const parsed = z
      .object({
        place: z
          .object({ name: z.string().trim().min(1).max(200), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
          .nullable(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid place' });
    await setWeatherPlace(parsed.data.place);
    return { place: parsed.data.place };
  });
}
