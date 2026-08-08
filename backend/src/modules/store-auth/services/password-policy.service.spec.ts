import {
  PasswordPolicyService,
  STORE_PASSWORD_MAX_CODE_POINTS,
  STORE_PASSWORD_MIN_CODE_POINTS,
} from './password-policy.service';
import {
  StoreAuthError,
  StoreAuthErrorCode,
} from '../store-auth.errors';

describe('PasswordPolicyService', () => {
  const service = new PasswordPolicyService();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects 14 Unicode code points', () => {
    expectPolicyFailure('a'.repeat(14));
  });

  it('accepts exactly 15 Unicode code points', () => {
    const password = 'a'.repeat(STORE_PASSWORD_MIN_CODE_POINTS);

    expect(service.normalizeAndValidate(password)).toBe(password);
  });

  it('accepts exactly 128 Unicode code points', () => {
    const password = 'a'.repeat(STORE_PASSWORD_MAX_CODE_POINTS);

    expect(service.normalizeAndValidate(password)).toBe(password);
  });

  it('rejects 129 Unicode code points', () => {
    expectPolicyFailure('a'.repeat(STORE_PASSWORD_MAX_CODE_POINTS + 1));
  });

  it('counts Unicode code points instead of UTF-16 code units', () => {
    const password = '😀'.repeat(STORE_PASSWORD_MIN_CODE_POINTS);

    expect(password.length).toBe(STORE_PASSWORD_MIN_CODE_POINTS * 2);
    expect(service.normalizeAndValidate(password)).toBe(password);
  });

  it('normalizes canonically equivalent Unicode to NFC', () => {
    const decomposedPassword = 'e\u0301'.repeat(
      STORE_PASSWORD_MIN_CODE_POINTS,
    );
    const normalizedPassword = 'é'.repeat(STORE_PASSWORD_MIN_CODE_POINTS);

    expect(service.normalizeAndValidate(decomposedPassword)).toBe(
      normalizedPassword,
    );
  });

  it('preserves spaces and does not trim leading or trailing whitespace', () => {
    const password = `  ${'a'.repeat(13)}  `;

    expect(service.normalizeAndValidate(password)).toBe(password);
  });

  it('does not impose character-composition rules', () => {
    const lowercaseOnly = 'a'.repeat(STORE_PASSWORD_MIN_CODE_POINTS);
    const spacesOnly = ' '.repeat(STORE_PASSWORD_MIN_CODE_POINTS);

    expect(service.normalizeAndValidate(lowercaseOnly)).toBe(lowercaseOnly);
    expect(service.normalizeAndValidate(spacesOnly)).toBe(spacesOnly);
  });

  it('returns a stable safe error without the rejected password', () => {
    const rejectedPassword = 'do-not-expose';

    try {
      service.normalizeAndValidate(rejectedPassword);
      throw new Error('Expected password policy validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(StoreAuthError);
      expect((error as StoreAuthError).code).toBe(
        StoreAuthErrorCode.PASSWORD_POLICY_INVALID,
      );
      expect((error as Error).message).toBe(
        'Password does not meet the required policy.',
      );
      expect(JSON.stringify(error)).not.toContain(rejectedPassword);
      expect((error as Error).message).not.toContain(rejectedPassword);
    }
  });

  it('rejects a non-string runtime value safely', () => {
    expect(() =>
      service.normalizeAndValidate(null as unknown as string),
    ).toThrow('Password does not meet the required policy.');
  });

  it('translates unexpected Unicode normalization failures safely', () => {
    const password = 'a'.repeat(STORE_PASSWORD_MIN_CODE_POINTS);
    jest.spyOn(String.prototype, 'normalize').mockImplementationOnce(() => {
      throw new Error(`normalization detail for ${password}`);
    });

    expectPolicyFailure(password);
  });

  function expectPolicyFailure(password: string): void {
    expect(() => service.normalizeAndValidate(password)).toThrow(
      expect.objectContaining({
        code: StoreAuthErrorCode.PASSWORD_POLICY_INVALID,
      }),
    );
  }
});
