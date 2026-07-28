import { isCanonicalUuidV4 } from './admin-uuid.util';

describe('isCanonicalUuidV4', () => {
  it.each([
    '12345678-1234-4234-8123-456789012345',
    'A987FBC9-4BED-4078-8F07-9141BA07C9F3',
  ])('accepts canonical UUID-v4 value %s', (value) => {
    expect(isCanonicalUuidV4(value)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    'not-a-uuid',
    '12345678123442348123456789012345',
    '12345678-1234-1234-8123-456789012345',
    '12345678-1234-4234-7123-456789012345',
  ])('rejects non-canonical UUID-v4 value %s', (value) => {
    expect(isCanonicalUuidV4(value)).toBe(false);
  });
});
