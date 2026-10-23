import { i18n } from '@/modules/i18n';
import { readApiErrorMessage } from '@/shared/api';

// The auth API keeps its English messages stable; the client translates them.
// Structured AppError codes win, because several distinct failures share the
// generic INTERNAL_ERROR code and are only told apart by their message.
const AUTH_ERROR_KEY_BY_CODE: Record<string, string> = {
  AUTH_CREDENTIALS_REQUIRED: 'credentialsRequired',
  AUTH_CREDENTIALS_TOO_SHORT: 'credentialsTooShort',
  AUTH_USER_ALREADY_CONFIGURED: 'setupComplete',
  AUTH_USERNAME_CONFLICT: 'usernameConflict',
  AUTH_INVALID_CREDENTIALS: 'invalidCredentials',
  AUTH_USER_REQUIRED: 'authRequired',
  USER_REQUIRED: 'authRequired',
};

const AUTH_ERROR_KEY_BY_MESSAGE: Record<string, string> = {
  'Invalid username or password': 'invalidCredentials',
  'Username and password are required': 'credentialsRequired',
  'Too many login attempts. Wait one minute.': 'tooManyAttempts',
  'Invalid remote username, password or verification code.': 'invalidRemoteCredentials',
  'Initial setup is available locally only.': 'setupLocalOnly',
  'Local identity unavailable.': 'localIdentityUnavailable',
  'Complete initial account setup first.': 'setupFirst',
  'Too many pending login tickets.': 'tooManyTickets',
  'Invalid local ticket.': 'invalidLocalTicket',
  'Local ticket expired or already used.': 'localTicketExpired',
  'Local user unavailable.': 'localUserUnavailable',
  'Verified private access identity required.': 'accessIdentityRequired',
  'This identity is not mapped to an active account.': 'identityNotMapped',
  'This device session was revoked. Sign out of Cloudflare and sign in again.': 'deviceRevoked',
  'Current password is incorrect': 'currentPasswordIncorrect',
  'Password must be at least 6 characters and at most 72 UTF-8 bytes': 'passwordLength',
  'Access denied. No token provided.': 'authRequired',
  'Invalid token. User not found.': 'sessionInvalid',
  'Invalid token': 'sessionInvalid',
  'Session expired. Please log in again.': 'sessionExpired',
  'Authentication is required.': 'authRequired',
};

/**
 * Used by the auth module (login/setup) and the settings module (password
 * change) to show a localized message for an auth API error body. Unknown
 * errors keep the server text; a body without any message yields null.
 */
export function readAuthErrorMessage(body: unknown): string | null {
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = readApiErrorMessage(body);
  const key = (typeof code === 'string' ? AUTH_ERROR_KEY_BY_CODE[code] : undefined)
    ?? (message ? AUTH_ERROR_KEY_BY_MESSAGE[message.trim()] : undefined);
  return key ? i18n.t(`auth:serverErrors.${key}`) : message;
}
