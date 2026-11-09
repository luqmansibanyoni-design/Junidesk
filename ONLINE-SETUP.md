# JuniDesk online starter

This is the Replit project source prepared for deployment outside Replit. It contains the React app, Express API, PostgreSQL schema, and Bulapelo logo.

## Important setup

The app needs a hosted PostgreSQL database and Clerk authentication. Set these environment variables in your host's private environment settings:

- `DATABASE_URL` — Supabase Postgres Session Pooler URI
- `CLERK_SECRET_KEY` — Clerk server secret
- `JUNIDESK_ADMIN_EMAIL` — email address that should receive the first admin role
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk publishable key (available at frontend build time)
- `PORT` — supplied by most web hosts
- `BASE_PATH=/` — required by the Vite build
- `NODE_ENV=production`

Never commit `.env` or paste secret values into chat. `.env.example` contains placeholders only.

## Render build settings

- Build command: `corepack pnpm install --frozen-lockfile && corepack pnpm build`
- Start command: `corepack pnpm --filter @workspace/api-server run start`
- Health check path: `/api/healthz`

The build must have `PORT`, `BASE_PATH`, and `VITE_CLERK_PUBLISHABLE_KEY` available. Runtime must have `DATABASE_URL`, `CLERK_SECRET_KEY`, `JUNIDESK_ADMIN_EMAIL`, and `PORT`.

After setting up the database, run `corepack pnpm --filter @workspace/db run push` once from a trusted local environment with `DATABASE_URL` set to create the tables.

## Known item before real use

Ticket routes are now mounted and Clerk middleware is enabled. Ticket attachments still use Replit Object Storage and must be moved to another storage provider before enabling uploads on an external host. Do not use this starter with real users until that is replaced and access, sign-in, and deployment have been checked.
