import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { one, query, transaction } from '../db.js';
import { logger } from '../log.js';

const log = logger('seed-auth');

interface TestUser {
  email: string;
  password: string;
  display_name?: string;
  /** Defaults to true. Set false to exercise the "check your inbox" branch. */
  email_confirmed?: boolean;
  metadata?: Record<string, unknown>;
}

// ESM: __dirname does not exist. Derive the path from import.meta.url.
const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(here, '../../seed/test-users.json');

// GoTrue only ever signs in a user that has a matching row in auth.identities,
// so every seeded user needs both halves - the user row for the credentials and
// the identity row for the email provider.
const APP_META = '{"provider":"email","providers":["email"]}';

/**
 * pgcrypto lives in `extensions` on Supabase and in `public` on a plain local
 * Postgres. Resolve it once instead of guessing, so the same seed runs against
 * both.
 */
async function cryptSchema(): Promise<string> {
  const row = await one<{ schema: string }>(
    `select extnamespace::regnamespace::text as schema
       from pg_extension where extname = 'pgcrypto'`,
  );
  if (!row) throw new Error('pgcrypto is not installed - run `create extension pgcrypto`');
  return row.schema;
}

/**
 * Idempotent upsert by email against auth.users + auth.identities. Re-running
 * resets the password and metadata of the seeded accounts but keeps their ids,
 * so anything already pointing at a test user id stays valid.
 *
 * Passwords are hashed with bcrypt through pgcrypto, which is the same scheme
 * GoTrue writes, so the seeded accounts sign in through the normal
 * `signInWithPassword` path with no admin API key involved.
 */
export async function seedTestUsers(filePath = SEED_PATH): Promise<number> {
  const users = JSON.parse(await readFile(filePath, 'utf8')) as TestUser[];
  const cs = await cryptSchema();
  let written = 0;

  for (const user of users) {
    const confirmed = user.email_confirmed ?? true;
    const userMeta = JSON.stringify({
      ...(user.metadata ?? {}),
      ...(user.display_name ? { display_name: user.display_name } : {}),
      email: user.email,
      email_verified: confirmed,
    });

    await transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `select id from auth.users where email = $1`,
        [user.email],
      );

      let id = existing.rows[0]?.id;

      if (id) {
        await client.query(
          `update auth.users set
             encrypted_password = ${cs}.crypt($2, ${cs}.gen_salt('bf')),
             email_confirmed_at = case when $3 then coalesce(email_confirmed_at, now()) else null end,
             raw_app_meta_data  = $4::jsonb,
             raw_user_meta_data = $5::jsonb,
             banned_until       = null,
             deleted_at         = null,
             updated_at         = now(),
             -- Same NULL-vs-empty-string trap as the insert; this also repairs
             -- rows an earlier run of this seed left unable to sign in.
             confirmation_token         = coalesce(confirmation_token, ''),
             recovery_token             = coalesce(recovery_token, ''),
             email_change               = coalesce(email_change, ''),
             email_change_token_new     = coalesce(email_change_token_new, ''),
             email_change_token_current = coalesce(email_change_token_current, ''),
             phone_change               = coalesce(phone_change, ''),
             phone_change_token         = coalesce(phone_change_token, ''),
             reauthentication_token     = coalesce(reauthentication_token, '')
           where id = $1`,
          [id, user.password, confirmed, APP_META, userMeta],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `insert into auth.users (
             instance_id, id, aud, role, email, encrypted_password,
             email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
             created_at, updated_at,
             -- GoTrue scans these into non-nullable Go strings. Leaving them
             -- NULL makes every sign-in fail with "Database error querying
             -- schema", which points nowhere near the actual cause.
             confirmation_token, recovery_token, email_change,
             email_change_token_new, email_change_token_current,
             phone_change, phone_change_token, reauthentication_token)
           values (
             '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
             'authenticated', 'authenticated', $1,
             ${cs}.crypt($2, ${cs}.gen_salt('bf')),
             case when $3 then now() end,
             $4::jsonb, $5::jsonb, now(), now(),
             '', '', '', '', '', '', '', '')
           returning id`,
          [user.email, user.password, confirmed, APP_META, userMeta],
        );
        id = inserted.rows[0]!.id;
      }

      // provider_id is the external subject id; for the email provider GoTrue
      // uses the user's own uuid. `email` is a generated column off
      // identity_data->>'email', so it is set by writing identity_data.
      await client.query(
        `insert into auth.identities
           (provider, provider_id, user_id, identity_data, created_at, updated_at)
         values ('email', $1::text, $2::uuid, $3::jsonb, now(), now())
         on conflict (provider_id, provider) do update set
           identity_data = excluded.identity_data,
           updated_at    = now()`,
        [id, id, JSON.stringify({ sub: id, email: user.email, email_verified: confirmed })],
      );
    });

    written++;
  }

  await verify(users, cs);
  log.info(`seeded ${written} test auth user(s)`);
  return written;
}

/**
 * Re-hashing the seed password against the stored hash is exactly the check
 * GoTrue performs on sign-in, so a pass here means the account really can log
 * in - not just that the rows exist.
 */
async function verify(users: TestUser[], cs: string): Promise<void> {
  for (const user of users) {
    const row = await one<{
      password_ok: boolean;
      confirmed: boolean;
      has_identity: boolean;
      null_tokens: string[];
    }>(
      `select u.encrypted_password = ${cs}.crypt($2, u.encrypted_password) as password_ok,
              u.email_confirmed_at is not null                             as confirmed,
              exists (select 1 from auth.identities i
                       where i.user_id = u.id and i.provider = 'email')    as has_identity,
              -- A NULL in any of these is what GoTrue reports as the useless
              -- "Database error querying schema"; fail here instead, by name.
              array_remove(array[
                case when u.confirmation_token         is null then 'confirmation_token' end,
                case when u.recovery_token             is null then 'recovery_token' end,
                case when u.email_change               is null then 'email_change' end,
                case when u.email_change_token_new     is null then 'email_change_token_new' end,
                case when u.email_change_token_current is null then 'email_change_token_current' end,
                case when u.phone_change               is null then 'phone_change' end,
                case when u.phone_change_token         is null then 'phone_change_token' end,
                case when u.reauthentication_token     is null then 'reauthentication_token' end
              ], null) as null_tokens
         from auth.users u where u.email = $1`,
      [user.email, user.password],
    );

    if (!row) throw new Error(`seed-auth: ${user.email} was not written`);
    if (!row.password_ok) throw new Error(`seed-auth: password mismatch for ${user.email}`);
    if (!row.has_identity) throw new Error(`seed-auth: missing email identity for ${user.email}`);
    if (row.null_tokens.length > 0) {
      throw new Error(
        `seed-auth: ${user.email} has NULL in ${row.null_tokens.join(', ')} - GoTrue will reject sign-in`,
      );
    }

    // The unconfirmed user's hash is just as valid; whether it can actually
    // sign in depends on the project's "confirm email" setting, which is the
    // branch that account exists to exercise.
    const state = row.confirmed ? 'confirmed' : 'unconfirmed - sign-in blocked if email confirmation is on';
    log.info(`  ${user.email} (${state}) - password hash verified`);
  }
}

/** Removes every account the seed file defines. Test data only, never app data. */
export async function clearTestUsers(filePath = SEED_PATH): Promise<number> {
  const users = JSON.parse(await readFile(filePath, 'utf8')) as TestUser[];
  const emails = users.map((u) => u.email);
  // auth.identities has on delete cascade from auth.users, so one delete is enough.
  const deleted = await query<{ email: string }>(
    `delete from auth.users where email = any($1::text[]) returning email`,
    [emails],
  );
  log.info(`removed ${deleted.length} test auth user(s)`);
  return deleted.length;
}
