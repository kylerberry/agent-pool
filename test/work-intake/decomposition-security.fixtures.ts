export function flatCandidate() {
  return {
    nodes: [
      {
        id: 'auth-1',
        intent: 'Create login endpoint',
        change_spec: 'Add POST /login route',
        acceptance_criteria: ['Returns token on valid credentials'],
        depends_on: [],
      },
      {
        id: 'auth-2',
        intent: 'Add session expiry',
        change_spec: 'Set 24h TTL on sessions',
        acceptance_criteria: ['Expired sessions are rejected'],
        depends_on: ['auth-1'],
      },
    ],
  };
}

export const API_KEY_CANARY = 'sk-live-abcdefghijklmnopqrstuvwxyz123456';
export const PASSWORD_CANARY = 'password=SuperSecret123!';
export const TOKEN_CANARY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZWNyZXQiOiJ4In0.signature';
