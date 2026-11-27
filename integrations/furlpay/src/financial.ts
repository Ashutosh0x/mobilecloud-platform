/**
 * The FurlPay financial authorization boundary.
 *
 * MobileCloud proves who the user is. It does not prove intent to move money,
 * and its ID token is not a payment instrument. Every action below requires a
 * FurlPay-owned step-up (passkey/WebAuthn) performed for that action or for a
 * recent, bounded window. An SSO session on its own can never satisfy this
 * check, by construction: `sso` is not a strong method.
 */

export const FINANCIAL_ACTIONS = [
  "wallet.read",
  "wallet.sign",
  "payment.initiate",
  "transfer.create",
  "withdrawal.create",
  "card.manage",
  "agent.spend",
  "limits.change",
  "policy.change",
] as const;

export type FinancialAction = (typeof FINANCIAL_ACTIONS)[number];

export type FinancialAuthContext = {
  accountId: string;
  sessionId: string;
  /** How FurlPay authenticated this session. `sso` alone is never enough. */
  methods: Array<"sso" | "password" | "passkey" | "webauthn">;
  /** When the financial step-up completed, Unix milliseconds. */
  stepUpAt?: number;
  /** Step-up must be bound to the device that will sign. */
  deviceBound?: boolean;
};

export class FinancialAuthorizationError extends Error {
  readonly code = "financial_step_up_required";
  readonly action: FinancialAction;
  constructor(action: FinancialAction, message: string) {
    super(message);
    this.action = action;
  }
}

export function isFinancialAction(value: string): value is FinancialAction {
  return (FINANCIAL_ACTIONS as readonly string[]).includes(value);
}

export function assertFinancialAuthorization(
  context: FinancialAuthContext,
  action: FinancialAction,
  options: { now?: () => number; maxStepUpAgeMs?: number } = {},
): void {
  const now = options.now ?? (() => Date.now());
  const maxAge = options.maxStepUpAgeMs ?? 5 * 60_000;
  const strong = context.methods.includes("passkey") || context.methods.includes("webauthn");
  if (!strong) {
    throw new FinancialAuthorizationError(action, "This action requires a FurlPay passkey step-up; a MobileCloud SSO session is not sufficient");
  }
  if (context.deviceBound !== true) {
    throw new FinancialAuthorizationError(action, "The financial step-up must be bound to this device");
  }
  if (typeof context.stepUpAt !== "number" || now() - context.stepUpAt > maxAge || context.stepUpAt > now() + 60_000) {
    throw new FinancialAuthorizationError(action, "The financial step-up has expired; authenticate again in FurlPay");
  }
}

/** A context derived from a federated login, useful for tests and negative paths. */
export function ssoOnlyContext(accountId: string, sessionId: string): FinancialAuthContext {
  return { accountId, sessionId, methods: ["sso"], deviceBound: false };
}
