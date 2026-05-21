# Health Vault Backend

Production-ready Node.js backend using Express, PostgreSQL, and Drizzle ORM.

## Architecture

The code follows strict clean architecture:

- `controllers`: request and response only
- `services`: validation and business logic
- `repositories`: Drizzle database queries only
- `models`: Drizzle schema
- `middlewares`: auth, validation, rate limiting, error handling
- `resources/emailTemplates`: shared base email template and partial templates

## Security

- bcrypt password hashing
- JWT access and refresh tokens
- Helmet headers
- Express rate limiter
- Login and OTP attempt blocking with `MAX_LOGIN_ATTEMPTS`
- `USER_STATUS`: `ACTIVE`, `BLOCKED`, `INACTIVE`

## Environment

Copy `.env.example` to `.env` and configure:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/health_vault
JWT_SECRET=replace-with-a-long-random-secret
MAX_LOGIN_ATTEMPTS=3
```

## Database

Drizzle schema is in `src/models`.

Migration SQL:

```bash
drizzle/0000_enterprise_schema.sql
```

Run migrations with your deployment migration runner or Drizzle Kit workflow.

## Scripts

```bash
npm run dev
npm start
npm run lint
npm run format:check
npm test
```

Swagger is available at `/swagger-ui`.

## Email Templates

All templates use `src/resources/emailTemplates/baseTemplate.html`.

Included templates:

- `forgotPassword.html`
- `otpVerification.html`
- `resetPasswordSuccess.html`
- `accountBlocked.html`

## Commit Format

Commitlint accepts:

- `feat: new feature`
- `fix: bug fix`
- `refactor: code improvement`
