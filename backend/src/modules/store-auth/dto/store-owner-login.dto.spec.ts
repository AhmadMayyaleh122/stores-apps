import { BadRequestException, ValidationPipe } from '@nestjs/common';

import {
  STORE_OWNER_LOGIN_PASSWORD_HTTP_MAX_LENGTH,
  StoreOwnerLoginDto,
} from './store-owner-login.dto';

describe('StoreOwnerLoginDto', () => {
  const validBody = {
    email: 'Owner@Example.COM',
    password: 'correct horse battery staple',
  };
  let validationPipe: ValidationPipe;

  beforeEach(() => {
    validationPipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
  });

  it('accepts the minimum valid shape without canonicalizing credentials', async () => {
    const result = await validateBody(validBody);

    expect(result).toBeInstanceOf(StoreOwnerLoginDto);
    expect(result).toEqual(validBody);
  });

  it('does not apply activation-time minimum password policy at the HTTP boundary', async () => {
    await expect(
      validateBody({ ...validBody, password: 'x' }),
    ).resolves.toMatchObject({ password: 'x' });
  });

  it.each([
    ['missing email', { password: validBody.password }],
    ['missing password', { email: validBody.email }],
    ['empty email', { ...validBody, email: '' }],
    ['empty password', { ...validBody, password: '' }],
    ['non-string email', { ...validBody, email: 42 }],
    ['non-string password', { ...validBody, password: { secret: true } }],
    ['malformed email', { ...validBody, email: 'not-an-email' }],
    ['oversized email', { ...validBody, email: `${'a'.repeat(250)}@example.com` }],
    [
      'oversized password',
      {
        ...validBody,
        password: 'x'.repeat(
          STORE_OWNER_LOGIN_PASSWORD_HTTP_MAX_LENGTH + 1,
        ),
      },
    ],
    ['unknown field', { ...validBody, databaseHost: 'db.internal' }],
  ])('rejects %s as a malformed request', async (_label, body) => {
    await expect(validateBody(body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  async function validateBody(
    body: object,
  ): Promise<StoreOwnerLoginDto> {
    return validationPipe.transform(body, {
      type: 'body',
      metatype: StoreOwnerLoginDto,
    }) as Promise<StoreOwnerLoginDto>;
  }
});
