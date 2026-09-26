# Recipes

A personal recipe box. Mobile-first, with URL import and a Claude connector (MCP) planned.

- `server/`: Fastify + Prisma (Postgres) API. In production it also serves the built web app and recipe images.
- `web/`: React + Vite app.

## Local development

Requires Node 22+ and a local Postgres.

```sh
cp server/.env.example server/.env  # then fill in DATABASE_URL and SESSION_SECRET
createdb -U postgres recipes  # or create the database however you like
npm install
npm run db:migrate -w server  # applies migrations and generates the Prisma client
npm run user:create -- you@example.com "Your Name" "a-good-password"
npm run dev                   # API on :3000, web on :5173
```

Open http://localhost:5173. To try it on your phone, open `http://<your-computer's-LAN-IP>:5173` on the same Wi-Fi.

### Changing the schema

Edit `server/prisma/schema.prisma`, then run `npm run db:migrate -w server -- --name what_changed`. Commit the new folder under `server/prisma/migrations/`.

## Deploying on Railway

1. Create a project from this GitHub repo, then add a **PostgreSQL** database to it.
2. On the app service, set these variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `SESSION_SECRET` = a long random string
   - `NODE_ENV` = `production`
   - `UPLOAD_DIR` = `/data/uploads`
3. Attach a **volume** to the app service, mounted at `/data`.
4. Under Networking, generate a public domain.

`railway.json` sets the build (`npm run build`), start (`npm start`, which runs `prisma migrate deploy` first) and health check (`/api/health`).

### Creating users in production

Log in to the Railway CLI, then run the script from your machine against the production database. Use the Postgres service's **public** URL (`DATABASE_PUBLIC_URL`), because the internal one only resolves inside Railway:

```sh
DATABASE_URL="<DATABASE_PUBLIC_URL>" npm run user:create -- you@example.com "Your Name" "password"
```

Running the script again with the same email resets that user's password.
