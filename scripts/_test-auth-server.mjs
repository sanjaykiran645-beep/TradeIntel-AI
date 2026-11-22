import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const TEST_USER_TOKEN = `offline-user-${randomUUID()}`;
export const TEST_ADMIN_TOKEN = `offline-admin-${randomUUID()}`;
export const TEST_OTHER_ADMIN_TOKEN = `offline-other-admin-${randomUUID()}`;
export const TEST_USER_ID = randomUUID();
export const TEST_ADMIN_USER_ID = randomUUID();
export const TEST_OTHER_ADMIN_USER_ID = randomUUID();

const TEST_USERS = {
  [TEST_USER_TOKEN]: {
    id: TEST_USER_ID,
    aud: 'authenticated',
    email: 'offline-user@example.invalid',
    app_metadata: { role: 'user' },
    user_metadata: { role: 'admin' }
  },
  [TEST_ADMIN_TOKEN]: {
    id: TEST_ADMIN_USER_ID,
    aud: 'authenticated',
    email: 'offline-admin@example.invalid',
    app_metadata: { role: 'admin' },
    user_metadata: { role: 'user' }
  },
  [TEST_OTHER_ADMIN_TOKEN]: {
    id: TEST_OTHER_ADMIN_USER_ID,
    aud: 'authenticated',
    email: 'offline-other-admin@example.invalid',
    app_metadata: { role: 'admin' },
    user_metadata: { role: 'admin' }
  }
};

function respondJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startTestAuthServer(users = TEST_USERS) {
  const tokenUsers = new Map(Object.entries(users));
  const server = createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      respondJson(response, 400, { code: 'bad_request', message: 'Invalid request.' });
      return;
    }

    if (request.method !== 'GET' || pathname !== '/auth/v1/user') {
      respondJson(response, 404, { code: 'not_found', message: 'Not found.' });
      return;
    }

    const token = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '')?.[1];
    const user = tokenUsers.get(token);
    if (!user) {
      respondJson(response, 401, { code: 'bad_jwt', message: 'Invalid JWT.' });
      return;
    }

    respondJson(response, 200, user);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();

  const address = server.address();
  return {
    url: 'http://127.0.0.1:' + address.port,
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    }
  };
}
