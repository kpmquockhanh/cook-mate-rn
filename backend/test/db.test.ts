import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { poolConfig } from '../src/db.js';
import { env } from '../src/env.js';

// What pg itself will do with these options: a Client resolves its TLS
// settings in the constructor and connects only on .connect(), so this
// checks the behaviour without a server.
//
// pg falls back to PGSSLMODE when the URL has no sslmode, so a shell set up
// for psql would otherwise decide these results instead of the URL.
delete process.env.PGSSLMODE;

function tlsOf(connectionString: string): unknown {
  return (new pg.Client(poolConfig(connectionString)) as unknown as { ssl: unknown }).ssl;
}

test('a compose hostname with no sslmode connects without TLS', () => {
  assert.equal(tlsOf('postgres://u:p@postgres:5432/db'), false);
});

test('127.0.0.1 with no sslmode connects without TLS', () => {
  assert.equal(tlsOf('postgres://u:p@127.0.0.1:5432/db'), false);
});

test('sslmode=verify-full turns on verified TLS', () => {
  const ssl = tlsOf('postgres://u:p@db.example.com:5432/db?sslmode=verify-full');
  assert.ok(ssl && typeof ssl === 'object', 'expected TLS options');
  assert.notEqual((ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, false);
});

test('sslmode=no-verify turns on TLS without certificate checks', () => {
  const ssl = tlsOf('postgres://u:p@db.example.com:5432/db?sslmode=no-verify');
  assert.deepEqual(ssl, { rejectUnauthorized: false });
});

test('poolConfig never sets ssl itself and passes the URL through', () => {
  const url = 'postgres://u:p@db.example.com:5432/db?sslmode=verify-full';
  const config = poolConfig(url);
  assert.equal('ssl' in config, false);
  assert.equal(config.connectionString, url);
});

test('pool size and connect timeout come from env', () => {
  const config = poolConfig('postgres://u:p@postgres:5432/db');
  assert.equal(config.max, Math.max(4, env.crawlConcurrency + 2));
  assert.equal(config.connectionTimeoutMillis, env.dbConnectTimeoutMs);
});
