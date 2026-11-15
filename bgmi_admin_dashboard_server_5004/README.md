# BGMI Admin Dashboard Server - Port 5004

This server matches the Admin Panel frontend currently calling `http://localhost:5004`.

## Endpoints

- GET `/health`
- GET `/api/admin/tournaments`
- PUT `/api/admin/tournaments/:id/hide`
- PUT `/api/admin/tournaments/:id/unhide`
- GET `/admin/tournament-joins/:id`
- PUT `/admin/tournament-joins/:id/approve`
- PUT `/admin/tournament-joins/:id/reject`
- DELETE `/admin/tournament-joins/:id`
- POST `/admin/tournament-declare-winner/:id`
- GET `/api/admin/debug`

## Setup on Windows

1. Create `C:\admin_dashboard_server_5004`
2. Put `server.js`, `package.json` and `.env` there.
3. Run:
   `npm install`
4. Create `.env` using `.env.example`.
5. Put the same Supabase URL and **service-role key** used by your trusted backend server.
6. Run:
   `npm start`

Expected:
`🚀 BGMI Admin Dashboard Server LIVE on port 5004`

IMPORTANT:
Do not put the Supabase service-role key in React/frontend code or share it publicly.
